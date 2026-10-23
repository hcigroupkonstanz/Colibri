using HCIKonstanz.Colibri.Core;
using HCIKonstanz.Colibri.Networking.Protocol;
using HCIKonstanz.Colibri.Setup;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;

namespace HCIKonstanz.Colibri.Networking
{
    /// <summary>
    /// TCP connection to a colibri-server, speaking the v3 binary protocol
    /// (see <see cref="Protocol.FrameCodec"/> and <c>colibri-server/docs/dev/protocol.md</c>).
    /// Requires colibri-server >= 2.0.0; the server accepts exactly one protocol version, so there
    /// is no negotiation and both sides are upgraded together.
    /// With <see cref="ColibriConfig.IsSSL"/> the same frames run inside TLS, and
    /// <see cref="ServerCertificatePolicy"/> decides which server certificates are accepted.
    /// </summary>
    [DefaultExecutionOrder(-100)]
    public class WebServerConnection : SingletonBehaviour<WebServerConnection>
    {
        // Must equal PROTOCOL_VERSION in colibri-server (src/server/modules/networking/protocol.ts) and in
        // colibri-web (src/Colibri.ts); the server's `npm run test:vectors` checks all three.
        private const string CLIENT_VERSION = "2";

        // The server refuses a client with another protocol version on this channel and command.
        // ReceiveLoop handles it itself instead of delivering it as an application message.
        private const string COLIBRI_CHANNEL = "colibri";
        private const string PROTOCOL_REJECTED_COMMAND = "protocol::rejected";

        // A server on another framing cannot decode our frames and cannot send the explicit refusal, so the
        // only symptom is sessions failing before a frame is read. This many in a row log a hint instead of
        // reconnecting silently; unanswered sessions count the same (see CountSessionWithoutAFrame).
        private const int EARLY_FRAME_FAILURES_BEFORE_HINT = 3;

        // The server heartbeats every 100 ms, so this much silence means the connection is gone even if
        // the socket has not noticed.
        private const long HEARTBEAT_TIMEOUT_THRESHOLD_MS = 2000;

        private const int RECEIVE_BUFFER_SIZE = 64 * 1024;

        // One connection attempt: name lookup, every address tried and, with TLS, the handshake (a server
        // without TLS may never answer it). The socket has no timeout of its own (about two minutes on
        // Android); 5 s leaves room for two lost SYNs. Sync.StopsWaitingForServer waits as long before it
        // simulates a placed body without the server's state.
        internal const int CONNECT_TIMEOUT_MS = 5000;

        // How long OnDisable waits for the outbox when quitting or ending Play mode. Short, since the app is
        // closing: what SyncTicker flushes from the send rate limit then is only a few frames.
        private const int QUIT_DRAIN_TIMEOUT_MS = 100;

        public delegate void MessageAction(string channel, string command, JToken payload);

        /// <summary>Raised on the main thread for every received message.</summary>
        public event MessageAction OnMessageReceived;

        /// <summary>
        /// Raised on the main thread once the server has sent its first frame, not on an accepted TCP
        /// connection alone. A server that accepts and then says nothing, or speaks a framing this client
        /// cannot read, never raises it.
        /// </summary>
        /// <remarks>
        /// Both events are raised from <c>Update</c> in the order the transitions happened, so the last one
        /// raised is the current state: a drop and reconnect between two frames raises
        /// <see cref="OnDisconnected"/> and then <see cref="OnConnected"/> in the next frame.
        /// Disabling or destroying this component raises what is still due from <c>OnDisable</c>, so an open
        /// connection ends with <see cref="OnDisconnected"/> (right after the event reached every handler, if
        /// a handler disabled it). Ending Play mode or the app raises neither: the handlers' objects may be gone.
        /// </remarks>
        public event Action OnConnected;

        /// <summary>
        /// Raised on the main thread once for every <see cref="OnConnected"/>, after it, when that connection
        /// ends: dropped, timed out, refused or closed by disabling this component (see
        /// <see cref="OnConnected"/> for the exception). An attempt that never reached Connected raises neither
        /// event; a refusal in the first frame shows as <see cref="Status"/> becoming
        /// <see cref="ConnectionStatus.ProtocolMismatch"/> and <see cref="Connected"/> being cancelled.
        /// </summary>
        public event Action OnDisconnected;

        // Main thread only: the loop the last OnEnable started, until OnDisable ends it.
        // Instance state, not static: static state would survive Enter Play Mode without domain reload.
        private ConnectionLoop _loop;

        // The tests shrink its send buffer to stand in for a slow link.
        internal Socket CurrentSocket => _loop?.Socket;

        // The tests wait on it for an ended loop to finish its cleanup.
        internal Task CurrentLoop => _loop?.Run;

        // Tests only: awaited when a session has ended, before the loop cleans up after it. Holds a loop that
        // OnDisable ended until the next loop is Connected, so a cleanup touching its status or outbox shows.
        internal volatile Func<Task> BeforeSessionCleanup;

        private string _hostname = "";

        private readonly FrameWriter _frameWriter = new FrameWriter();

        // The tests hold it to stand in for a slow write.
        internal SemaphoreSlim SendLock => _frameWriter.SendLock;

        private readonly Outbox _outbox;

        private readonly ReceiveQueue _receiveQueue = new ReceiveQueue();

        // Main thread only: reused by DeliverReceivedMessages from frame to frame.
        private readonly List<InPacket> _delivering = new List<InPacket>();

        private readonly Liveness _liveness = new Liveness();

        // Main thread only: the OnMessageReceived value last delivered to, and its invocation list.
        private MessageAction _deliveringTo;
        private Delegate[] _deliveringToList;

        private readonly ConnectionState _state = new ConnectionState();

        // How many times the connection has become Connected; 2 or more in an OnConnected handler means a reconnect.
        internal int ConnectedSessions => _state.ConnectedSessions;

        // Connection loop only.
        private bool _hasReportedMissingConfig;
        private string _reportedSanitizedApp;

        // Connection loop only: the TLS failure last logged as an error, so a server that keeps failing the
        // same way says so once. Cleared by a connection and by OnEnable.
        private string _reportedTlsFailure;

        // Cleared by OnEnable: the warning about a certificate accepted only because self-signed ones are
        // allowed is logged once, not at every reconnect.
        private volatile bool _hasWarnedAboutUntrustedCertificate;

        // ColibriConfig.Load() goes through Resources.Load, which is main-thread only, so the connection loop
        // reads this snapshot (refreshed in OnEnable and Update).
        private volatile ConnectionConfig _config = ConnectionConfig.Empty;

        // Set by each TLS handshake, for the Status window: the certificate the server presented and how it
        // was accepted. Null until a TLS connection has been made.
        private volatile string _presentedCertificateSha256;
        private volatile string _certificateAcceptance;

        /// <summary>
        /// Completes when <see cref="Status"/> becomes <see cref="ConnectionStatus.Connected"/>, i.e. once the
        /// server has sent its first frame; while disconnected it is a fresh, pending task. Cancelled when this
        /// component is disabled and when the server refuses the protocol version, which is final.
        /// </summary>
        public Task Connected => _state.Connected;

        // Main thread only. A handler that disables or destroys this component re-enters from OnDisable, see
        // RaiseConnectionEvents.
        private bool _isRaisingConnectionEvents;

        /// <summary>
        /// Smoothed rate at which <see cref="Update"/> runs, which is the rate at which received messages
        /// reach user code. Zero until the first few frames have been measured.
        /// </summary>
        /// <remarks>
        /// Not a network diagnostic: with the socket off the main thread, the remaining delivery delay is the
        /// local frame time, which an Editor in the background throttles hard enough to look like a slow connection.
        /// </remarks>
        public float DeliveryFramesPerSecond => _smoothedDeltaTime > 0f ? 1f / _smoothedDeltaTime : 0f;

        private float _smoothedDeltaTime;

        // Tests only: the thread the receive loop last ran on, to assert it is not the main thread. Zero before
        // the first receive.
        internal int ReceiveThreadId => _receiveThreadId;
        private volatile int _receiveThreadId;

        // Written by the receive loop off the main thread, read by the Editor status window and by user code
        // on the main thread.
        private volatile string _serverVersion;
        private volatile string _protocolMismatchReason;

        // Connection loop only (the receive loop is part of it), except for the test accessor.
        private int _consecutiveEarlyFrameFailures;
        private int _consecutiveUnansweredSessions;
        private volatile string _suspectedProtocolMismatch;

        /// <summary>Current connection state.</summary>
        public ConnectionStatus Status
        {
            get { return _state.Status; }
            private set { _state.Set(value); }
        }

        internal bool TrySetStatus(ConnectionStatus value, CancellationToken token) => _state.TrySetStatus(value, token);


        public WebServerConnection()
        {
            _outbox = new Outbox(_frameWriter);
        }

        private void OnEnable()
        {
            DontDestroyOnLoad(this);

            // Can only be read from the main thread.
            _hostname = PayloadCodec.SanitizeHandshakeField(SystemInfo.deviceName);
            RefreshConfig();

            _state.ResetGate();

            // Enabling the component again is a deliberate retry, refusal or not.
            _outbox.LiftRefusal();

            _hasWarnedAboutUntrustedCertificate = false;
            _reportedTlsFailure = null;

            _loop = new ConnectionLoop();
            _loop.Run = RunConnectionLoop(_loop);
        }

        private void RefreshConfig()
        {
            // Never null: an unconfigured project gets the defaults, and its empty app name is what
            // RunConnectionLoop reports and waits on.
            var config = ColibriConfig.Load();

            var current = _config;
            var refreshed = current.Refreshed(config);
            if (refreshed != current)
                _config = refreshed;
        }

        private void OnDisable()
        {
            // Quitting or ending Play mode: SyncTicker has just handed over what the send rate limit held, and on
            // Mono and IL2CPP a socket write completes a moment later on a worker thread, so closing the socket
            // now could lose it. An ordinary disable does not wait: the queue stays for the next enable.
            if (SingletonLifetime.IsQuitting)
                _outbox.WaitForOutboxToDrain(QUIT_DRAIN_TIMEOUT_MS);

            // Cancelled before anything below: from here on the loop leaves the status and the outbox alone,
            // however late it unwinds (see ConnectionLoop).
            var loop = _loop;
            _loop = null;
            if (loop != null)
            {
                loop.Lifetime.Cancel();
                loop.Lifetime.Dispose();
                ConnectRace.CloseSocket(loop.Socket);
            }

            // Whatever is still queued stays queued: re-enabling the component sends it.
            _outbox.CloseOutbox();

            // In this order: leaving Connected re-arms the gate, and an `await Connected` from now on would wait
            // on that fresh task forever, since OnEnable replaces the gate rather than completing it.
            Status = ConnectionStatus.Disconnected;
            _state.CancelGate();

            // A disabled or destroyed component gets no Update to raise these from, so the OnDisconnected of a
            // connection open until now is raised here. Not when quitting: teardown has no order, and a handler
            // may run on an object destroyed a moment ago. If a handler of these events disabled the component,
            // this returns at once and the loop that called the handler raises OnDisconnected after it.
            if (!SingletonLifetime.IsQuitting)
                RaiseConnectionEvents();
        }

        private void OnDestroy()
        {
            // Nothing will ever send these now, so nobody awaiting one should wait any longer.
            _outbox.AbandonEverythingQueued();
        }

        private void Update()
        {
            RefreshConfig();
            TrackDeliveryRate();
            RaiseConnectionEvents();
            DeliverReceivedMessages();

            var loop = _loop;
            if (loop != null && loop.IsWatchdogArmed && MillisSinceLastHeartbeat() > HEARTBEAT_TIMEOUT_THRESHOLD_MS)
            {
                // Disarmed first so this does not re-fire every frame while the session unwinds.
                loop.IsWatchdogArmed = false;
                loop.DroppedByWatchdog = true;

                if (Status == ConnectionStatus.Connected)
                {
                    Debug.Log("Colibri: no heartbeat from the server, dropping the connection");
                    // Anything sent from here on waits for the next connection rather than going
                    // to a socket that is about to be closed.
                    _outbox.CloseOutbox();
                    Status = ConnectionStatus.Disconnected;
                }
                else
                {
                    // Before the session loop sees the socket closed: see CountSessionWithoutAFrame.
                    loop.EndedSilent = true;
                    var config = _config;
                    Debug.Log($"Colibri: {config.ServerAddress}:{config.TcpPort} accepted the connection but has not sent anything in "
                        + $"{HEARTBEAT_TIMEOUT_THRESHOLD_MS / 1000f:0.#} s, dropping it");
                }

                // Faults the receive loop into the reconnect backoff.
                ConnectRace.CloseSocket(loop.Socket);
            }
        }

        private void RaiseConnectionEvents()
        {
            // A handler that disables or destroys this component re-enters here from OnDisable. Raising
            // OnDisconnected there would reach the handlers after it before the OnConnected being raised does;
            // the loop below raises it instead, once every handler has had OnConnected.
            if (_isRaisingConnectionEvents)
                return;

            _isRaisingConnectionEvents = true;
            try
            {
                while (_state.TryDequeueConnectionEvent(out var connected))
                {
                    if (connected)
                        Raise(OnConnected, nameof(OnConnected));
                    else
                        Raise(OnDisconnected, nameof(OnDisconnected));
                }
            }
            finally
            {
                _isRaisingConnectionEvents = false;
            }
        }

        /// <summary>
        /// Calls each handler on its own, so one that throws does not skip the handlers after it (Sync's
        /// re-request of the models after a reconnect among them) or the rest of this frame's Update.
        /// </summary>
        private static void Raise(Action handlers, string eventName)
        {
            if (handlers == null)
                return;

            foreach (var handler in handlers.GetInvocationList())
            {
                try
                {
                    ((Action)handler)();
                }
                catch (Exception e)
                {
                    Debug.LogError($"Colibri: a handler of {eventName} threw an exception. The other handlers were still called.\n{e}");
                }
            }
        }

        internal void EnqueueReceived(string channel, string command, JToken payload, CancellationToken token = default)
            => _receiveQueue.EnqueueReceived(channel, command, payload, token);

        /// <summary>
        /// Delivers everything received since the last frame. Handlers run on the main thread, one at a time,
        /// and one that throws does not stop the others or the messages queued behind it.
        /// </summary>
        internal void DeliverReceivedMessages()
        {
            // Reused from frame to frame, except by a handler that delivers again from inside one.
            var batch = _delivering.Count == 0 ? _delivering : new List<InPacket>();

            if (!_receiveQueue.TryTakeAll(batch))
                return;

            try
            {
                foreach (var packet in batch)
                    Deliver(packet);
            }
            finally
            {
                batch.Clear();
            }
        }

        private void Deliver(InPacket packet)
        {
            var handlers = OnMessageReceived;
            if (handlers == null)
                return;

            // A multicast delegate is immutable, so its invocation list is only fetched again after a subscribe
            // or unsubscribe.
            if (!ReferenceEquals(handlers, _deliveringTo))
            {
                _deliveringTo = handlers;
                _deliveringToList = handlers.GetInvocationList();
            }

            foreach (var handler in _deliveringToList)
            {
                try
                {
                    ((MessageAction)handler)(packet.Channel, packet.Command, packet.Payload);
                }
                catch (Exception e)
                {
                    Debug.LogError($"Colibri: a handler of OnMessageReceived threw an exception while handling {packet.Command} "
                        + $"on channel '{packet.Channel}'. The other handlers still received the message.\n{e}");
                }
            }
        }

        private void TrackDeliveryRate()
        {
            // unscaledDeltaTime, so a paused or slowed timeScale is not read as a stalled client.
            var delta = Time.unscaledDeltaTime;

            // Exponential moving average: one long frame shows up, without making the readout jump around.
            _smoothedDeltaTime = _smoothedDeltaTime <= 0f
                ? delta
                : Mathf.Lerp(_smoothedDeltaTime, delta, 0.1f);
        }


        /*
         *  Connection lifecycle
         */

        /*
         *  ConfigureAwait(false) on every await from here down, without exception.
         *
         *  The loop starts on the main thread (OnEnable), so an await without it captures Unity's
         *  SynchronizationContext and every continuation (connect, receive, heartbeat echo, send) waits
         *  for the player loop, which an unfocused Editor throttles. Messages reach user code through
         *  _receiveQueue and Update.
         */

        // One long-lived task per run, rather than Update retrying every frame while disconnected.
        private async Task RunConnectionLoop(ConnectionLoop loop)
        {
            var token = loop.Token;
            while (!token.IsCancellationRequested)
            {
                var config = _config;
                var address = config.ServerAddress;
                var app = config.AppName;

                // Whitespace counts as nothing, as in ColibriConfig.IsConfigured.
                if (string.IsNullOrWhiteSpace(address) || string.IsNullOrWhiteSpace(app))
                {
                    // Poll rather than give up, so setting the App Name at runtime still connects. Logged once, not at
                    // every poll.
                    if (!_hasReportedMissingConfig)
                    {
                        _hasReportedMissingConfig = true;
                        Debug.LogError(string.IsNullOrWhiteSpace(app) ? ColibriConfig.NOT_CONFIGURED_MESSAGE : ColibriConfig.NO_SERVER_ADDRESS_MESSAGE);
                    }

                    if (!await Delay(ConnectionState.RECONNECT_DELAY_MIN_MS, token).ConfigureAwait(false))
                        break;
                    continue;
                }

                _hasReportedMissingConfig = false;

                var handshakeApp = PayloadCodec.HandshakeAppName(app);
                if (handshakeApp != app && handshakeApp != _reportedSanitizedApp)
                {
                    // Logged, since a client configured with the original name will not see this one.
                    _reportedSanitizedApp = handshakeApp;
                    Debug.LogWarning(
                        $"Colibri: the App Name '{app}' cannot be sent as it is - it may not contain '::' or start or end with ':'. " +
                        $"Connecting as '{handshakeApp}' instead; change the App Name if other clients use the original.");
                }

                var mismatched = false;

                try
                {
                    loop.DecodedAnyFrame = false;
                    loop.ReachedHandshake = false;
                    loop.EndedSilent = false;
                    loop.DroppedByWatchdog = false;
                    loop.EndedOnBadFrame = false;
                    await RunSession(loop, config, handshakeApp).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (Exception) when (token.IsCancellationRequested)
                {
                    // Ended by OnDisable, which closed the socket under the read or write. Not a failure, so nothing is
                    // logged or retried.
                    break;
                }
                catch (ProtocolMismatchException e)
                {
                    mismatched = true;
                    Debug.LogError(
                        $"Colibri: the server refused this client - {e.Message}. " +
                        $"Update colibri-unity and colibri-server to matching versions. Not reconnecting.");
                }
                catch (FrameException e)
                {
                    loop.EndedOnBadFrame = true;
                    // No delimiter to resynchronize on, so a desynchronized stream is dropped and the connection rebuilt.
                    Debug.LogError($"Colibri: invalid frame from server, dropping connection: {e.Message}");
                }
                catch (TimeoutException e)
                {
                    // Nothing refused the connection and nothing answered: usually a wrong address, or a device on
                    // another network than the server.
                    Debug.Log($"Colibri: {e.Message}. Check the server address, and that this device is on the same network as the server. Retrying...");
                }
                catch (TlsHandshakeException e)
                {
                    ReportTlsFailure(e);
                }
                catch (Exception e) when (loop.DroppedByWatchdog && (e is SocketException || e is IOException))
                {
                    // The watchdog closed the socket and has said why; the read that fails on it (OperationAborted) would
                    // only repeat it.
                }
                catch (SocketException e)
                {
                    Debug.Log($"Colibri: connection to {address} failed ({e.SocketErrorCode}), retrying...");
                }
                catch (ObjectDisposedException)
                {
                    // Socket closed underneath us by the heartbeat watchdog.
                }
                catch (Exception e) when (e is IOException || e is AuthenticationException)
                {
                    // NetworkStream and SslStream wrap what the socket threw; unwrap it to tell the cases apart.
                    if (ServerConnector.FindCause<ObjectDisposedException>(e) == null)
                    {
                        var socketError = ServerConnector.FindCause<SocketException>(e);
                        Debug.Log(socketError != null
                            ? $"Colibri: connection to {address} failed ({socketError.SocketErrorCode}), retrying..."
                            : $"Colibri: connection to {address} failed ({e.Message}), retrying...");
                    }
                }
                catch (Exception e)
                {
                    Debug.LogException(e);
                }
                finally
                {
                    var beforeCleanup = BeforeSessionCleanup;
                    if (beforeCleanup != null)
                        await beforeCleanup().ConfigureAwait(false);

                    // This loop's own, whatever the next loop is doing by now (see ConnectionLoop).
                    loop.IsWatchdogArmed = false;
                    ConnectRace.CloseSocket(loop.Socket);
                    loop.Socket = null;

                    // Whatever ended the session, except this component being disabled, which says nothing about the server.
                    if (!token.IsCancellationRequested)
                        CountSessionWithoutAFrame(loop);

                    // Shared with the next loop, so only while this one has not been ended: by then OnDisable has closed
                    // the outbox and set the status itself, and they may belong to a session the next enable started.
                    _outbox.CloseOutbox(token);

                    // Before the status changes, so a reaction to ProtocolMismatch cannot queue a message that waits for
                    // a connection that never comes.
                    if (mismatched)
                        _outbox.RefuseSends(token);

                    _state.TrySetStatus(mismatched ? ConnectionStatus.ProtocolMismatch : ConnectionStatus.Disconnected, token);
                }

                // Terminal: retrying cannot make the versions agree, and would bury the one log line that says what
                // is wrong.
                if (mismatched)
                    break;

                if (token.IsCancellationRequested)
                    break;

                if (!await Delay(_state.NextBackoffDelay(), token).ConfigureAwait(false))
                    break;
            }
        }

        /// <summary>
        /// Called once for every session that ends, whatever ended it. A session that got past the handshake
        /// and ended without a decoded frame counts towards one of two hints, logged after
        /// <see cref="EARLY_FRAME_FAILURES_BEFORE_HINT"/> in a row. Each kind resets the other's count, and the
        /// first decoded frame resets both (<see cref="OnFrameDecoded"/>).
        /// </summary>
        /// <remarks>
        /// Framing hint: a server on another framing cannot decode our frames, so it cannot send the explicit
        /// refusal either. A suspicion only (it looks the same as a port that is not Colibri), so
        /// <see cref="Status"/> is left alone; only a refusal this client decoded is terminal.
        /// Unanswered hint: the watchdog ended the session, or with TLS it was closed or reset without a
        /// frame. A 1.x server heartbeats at once, behind a TLS-terminating proxy too, and that fails to
        /// decode; a 2.x server with TLS sends a frame after the handshake. What is left is a proxy whose
        /// backend is down, or a server that does not answer. Without TLS a close cannot be told apart from a
        /// TLS server hanging up on this client, so it counts as framing, whose hint names such a proxy too.
        /// </remarks>
        private void CountSessionWithoutAFrame(ConnectionLoop loop)
        {
            // Server down, wrong address or closed port: says nothing about protocol versions.
            if (!loop.ReachedHandshake)
                return;

            if (loop.DecodedAnyFrame)
                return;

            // Unanswered session, see above.
            if (loop.EndedSilent || (_state.UsesTls && !loop.EndedOnBadFrame))
            {
                _consecutiveEarlyFrameFailures = 0;
                _consecutiveUnansweredSessions++;
                if (_consecutiveUnansweredSessions == EARLY_FRAME_FAILURES_BEFORE_HINT)
                {
                    var config = _config;
                    Debug.LogWarning(
                        $"Colibri: {_consecutiveUnansweredSessions} connections in a row to {config.ServerAddress}:{config.TcpPort} were accepted, " +
                        "but nothing was received on any of them: each was closed by the other end or dropped after " +
                        $"{HEARTBEAT_TIMEOUT_THRESHOLD_MS / 1000f:0.#} s of silence. " +
                        "Something accepts connections there and then closes them or forwards nothing (a proxy or port forwarding " +
                        "whose backend is down, a captive portal, a firewall), or the server there does not answer or is not a " +
                        "colibri-server. Check that colibri-server is running and reachable at this address and port. Retrying...");
                }
                return;
            }

            _consecutiveUnansweredSessions = 0;
            _consecutiveEarlyFrameFailures++;
            if (_consecutiveEarlyFrameFailures != EARLY_FRAME_FAILURES_BEFORE_HINT)
                return;

            var suspicion =
                $"{_consecutiveEarlyFrameFailures} connections in a row were accepted but ended before a single frame could be read. " +
                $"This usually means a protocol mismatch: this client speaks v{CLIENT_VERSION} and needs colibri-server >= 2.0.0. " +
                "Check the server's version.";

            // A server with TLS turned on hangs up on a client that is not using it, before a
            // frame, exactly like this, and so does a proxy or port forwarding whose backend is down.
            if (!_state.UsesTls)
            {
                suspicion += " If the server has TLS turned on, tick 'Server supports SSL/TLS' in the Colibri configuration. " +
                    "If a proxy or port forwarding is in front of the server, check that the server behind it is running.";
            }

            // Logged before it is published: this runs on the session loop's thread, and the main thread polls
            // SuspectedProtocolMismatch (Status window, tests) and could act on the value before the line exists.
            Debug.LogError($"Colibri: {suspicion}");
            _suspectedProtocolMismatch = suspicion;
        }

        /// <summary>
        /// The first frame of a session, a refusal included, shows that the server speaks our framing, so the
        /// counts and the suspicion are cleared at once rather than when the session ends.
        /// </summary>
        private void OnFrameDecoded(ConnectionLoop loop)
        {
            loop.DecodedAnyFrame = true;
            _consecutiveEarlyFrameFailures = 0;
            _consecutiveUnansweredSessions = 0;
            _suspectedProtocolMismatch = null;
        }

        // Tests only: sessions in a row counted towards the framing hint.
        internal int ConsecutiveEarlyFrameFailures => Volatile.Read(ref _consecutiveEarlyFrameFailures);

        private async Task RunSession(ConnectionLoop loop, ConnectionConfig config, string app)
        {
            var token = loop.Token;
            var host = config.ServerAddress;
            var port = config.TcpPort;
            var useTls = config.UseTls;
            _state.BeginAttempt(useTls, token);

            Debug.Log($"Colibri: connecting to {host}:{port}{(useTls ? " (TLS)" : "")}");

            var certificateCheck = useTls
                ? new ServerCertificateCheck(host, config.AllowSelfSignedCertificate, config.ServerCertificateSha256)
                : null;

            ServerSession session;
            try
            {
                // Every address tried gets a socket of its own. The loop holds the one being tried, so OnDisable and
                // the cleanup after this session close it.
                session = await ServerConnector.OpenSessionAsync(host, port, certificateCheck, CONNECT_TIMEOUT_MS, socket => loop.Socket = socket, token)
                    .ConfigureAwait(false);
            }
            catch (TimeoutException e) when (!token.IsCancellationRequested)
            {
                _lastConnectFailure = e.Message;
                throw;
            }
            catch (TlsHandshakeException e) when (!token.IsCancellationRequested)
            {
                _lastConnectFailure = e.Message;
                throw;
            }
            catch (SocketException e) when (!token.IsCancellationRequested)
            {
                _lastConnectFailure = $"connecting to {host}:{port} failed ({e.SocketErrorCode})";
                throw;
            }

            // Closing the socket unblocks an in-flight read or write, TLS or not; neither has a token overload on
            // this API surface. Closes at once if the token is cancelled already.
            using (token.Register(session.Close))
            {
                try
                {
                    token.ThrowIfCancellationRequested();
                    _lastConnectFailure = null;

                    if (certificateCheck != null)
                        NoteCertificate(certificateCheck, host, port);

                    // Accepted, but nothing is known about what accepted it yet. The watchdog gives
                    // it as long to say something as a connected server gets between heartbeats.
                    StampLiveness();
                    loop.IsWatchdogArmed = true;

                    await _frameWriter.SendFrame(session, FrameCodec.EncodeHandshake(CLIENT_VERSION, app, _hostname), token)
                        .ConfigureAwait(false);
                    // Past this point the connection was accepted and this client has spoken, so a
                    // session that now ends without a frame is a statement about the server.
                    loop.ReachedHandshake = true;

                    await ReceiveLoop(loop, session, host, port, app).ConfigureAwait(false);
                }
                finally
                {
                    _frameWriter.ReleaseStream(session.Stream);
                }
            }
        }

        /// <summary>
        /// Keeps the handshake's verdict on the server's certificate for the Status window, and warns once
        /// when it was accepted only because self-signed certificates are allowed: the connection is
        /// encrypted, but nothing checks whose server it is.
        /// </summary>
        private void NoteCertificate(ServerCertificateCheck check, string host, int port)
        {
            _presentedCertificateSha256 = check.Fingerprint;
            _certificateAcceptance = DescribeAcceptance(check.Verdict);

            if (check.Verdict != ServerCertificatePolicy.Verdict.AcceptedUntrusted || _hasWarnedAboutUntrustedCertificate)
                return;

            _hasWarnedAboutUntrustedCertificate = true;
            Debug.LogWarning($"Colibri: accepted the certificate of {host}:{port} although {check.Problems}, because "
                + "'Allow self-signed certificate' is on. The connection is encrypted, but nothing checks that it goes to your server. "
                + $"To accept only this certificate, enter its fingerprint as 'Server certificate SHA-256': {check.Fingerprint}. "
                + "Said once per session.");
        }

        private static string DescribeAcceptance(ServerCertificatePolicy.Verdict verdict)
        {
            switch (verdict)
            {
                case ServerCertificatePolicy.Verdict.Trusted: return "trusted by this device";
                case ServerCertificatePolicy.Verdict.Pinned: return "matches 'Server certificate SHA-256'";
                case ServerCertificatePolicy.Verdict.AcceptedUntrusted: return "not trusted, accepted because 'Allow self-signed certificate' is on";
                default: return null;
            }
        }

        /// <summary>
        /// Logs a failed TLS handshake as an error the first time it fails that way, since it will not go away
        /// until a setting changes, and after that as a note, like a refused connection. The connection keeps
        /// being retried, so a server switched to TLS or given another certificate is picked up without a restart.
        /// </summary>
        private void ReportTlsFailure(TlsHandshakeException e)
        {
            var advice = e.Kind == TlsHandshakeException.Failure.NoTlsAnswer
                ? " 'Server supports SSL/TLS' is ticked in the Colibri configuration, so this client uses TLS on the TCP port too: "
                    + "turn TLS on at the server (TLS_CERT and TLS_KEY), or untick the setting."
                : "";

            // Keyed on the kind for a server that does not speak TLS, whose wording varies with how
            // it failed, and on the reason for a rejected certificate, which says what to change.
            var key = e.Kind == TlsHandshakeException.Failure.NoTlsAnswer ? e.Kind.ToString() : e.Message;
            if (key != _reportedTlsFailure)
            {
                _reportedTlsFailure = key;
                Debug.LogError($"Colibri: {e.Message}.{advice} Retrying...");
            }
            else
            {
                Debug.Log($"Colibri: {e.Message}, retrying...");
            }
        }

        /// <summary>
        /// The session is <see cref="ConnectionStatus.Connected"/> from the first frame the server sends, not
        /// from the TCP connection: anything can accept one, a 1.x server (which then speaks a framing this
        /// client cannot read) or a port that is not Colibri. Counting those would reset the backoff on every
        /// attempt, fire OnConnected and flush the queue into a session about to fail. A server that says
        /// nothing is dropped by the watchdog in <see cref="Update"/>; a real one heartbeats every 100 ms.
        /// </summary>
        private void BecomeConnected(ServerSession session, string host, int port, string app, CancellationToken token)
        {
            // A loop that OnDisable has ended does not connect: Connected, and the outbox, may
            // already be the next loop's.
            token.ThrowIfCancellationRequested();

            StampLiveness();

            _receiveQueue.ResetBacklogWarning();

            // A TLS failure after this one is news again.
            _reportedTlsFailure = null;

            // The address too when the server address is a name, which may have several: an IPv6
            // and an IPv4 one can lead to different places, a proxy that listens on only one, say.
            var via = session.Address != null && !AddressResolver.TryParseAddress(host, out _) ? $" ({session.Address})" : "";

            // The app name is named explicitly: a typo in it produces a perfectly healthy
            // connection on which no other client is ever seen.
            Debug.Log($"Colibri: connected to {host}:{port}{via} as app '{app}'. Only clients using the same App Name can see each other.");

            // Starts sending whatever queued up during the outage, in order. Opened before Status
            // says Connected, so anything sent by code that reacts to Connected lines up behind it.
            _outbox.OpenOutbox(session, token);
            if (!_state.TrySetStatus(ConnectionStatus.Connected, token))
                token.ThrowIfCancellationRequested();
        }

        private async Task ReceiveLoop(ConnectionLoop loop, ServerSession session, string host, int port, string app)
        {
            var token = loop.Token;
            var reader = new FrameReader();
            var buffer = new byte[RECEIVE_BUFFER_SIZE];
            var isConnected = false;

            while (!token.IsCancellationRequested)
            {
                // No token: closing the socket is what ends a read, as it ends a write.
                var received = await session.Stream.ReadAsync(buffer, 0, buffer.Length)
                    .ConfigureAwait(false);
                if (received <= 0)
                {
                    // Not logged if this end closed it: OnDisable closes the socket of a loop it ends.
                    if (!token.IsCancellationRequested)
                        Debug.Log("Colibri: server closed the connection");
                    return;
                }

                _receiveThreadId = Thread.CurrentThread.ManagedThreadId;

                // Once the server has proven itself, any received byte is proof of life: it heartbeats every 100 ms,
                // and a large message can take longer than that to arrive. Before then only a decoded frame counts,
                // or something trickling bytes that never form one would hold the session open.
                if (isConnected)
                    StampLiveness();

                var frames = ReadFrames(reader, buffer, received);
                if (frames.Count > 0 && !loop.DecodedAnyFrame)
                    OnFrameDecoded(loop);

                for (var i = 0; i < frames.Count; i++)
                {
                    // If OnDisable ended the loop after this batch was read, the rest of it is discarded like the bytes
                    // still unread on the closed socket, and changes nothing the next loop shares.
                    token.ThrowIfCancellationRequested();

                    var frame = frames[i];

                    // Before the session counts as connected: colibri-server says nothing before it has accepted the
                    // handshake, so a refusal is the very first frame and must not first be reported as a connection.
                    if (frame.Type == FrameType.Message && frame.Channel == COLIBRI_CHANNEL && frame.Command == PROTOCOL_REJECTED_COMMAND)
                        throw BuildProtocolMismatch(frame.Payload);

                    if (!isConnected)
                    {
                        isConnected = true;
                        BecomeConnected(session, host, port, app, token);
                    }

                    switch (frame.Type)
                    {
                        case FrameType.Heartbeat:
                            // Echoed back verbatim: the u64 is the server's own monotonic clock reading and is never interpreted
                            // here. Since 2.0.0 this echo is the sole source of the server's TCP latency measurements. Not
                            // awaited, see EchoHeartbeat.
                            _frameWriter.EchoHeartbeat(session, frame.PingTimestamp);
                            break;

                        case FrameType.Message:
                            _receiveQueue.EnqueueReceived(frame.Channel, frame.Command, PayloadCodec.ParsePayload(frame.Payload), token);
                            break;

                        case FrameType.Handshake:
                            // Server -> client handshakes are not part of the protocol.
                            Debug.LogWarning("Colibri: ignoring unexpected handshake frame from server");
                            break;
                    }
                }
            }

            token.ThrowIfCancellationRequested();
        }

        /// <summary>
        /// Reads the server's refusal payload. Forgiving about its shape: a payload that is missing or is not
        /// the JSON we expect must still produce a usable message, not a parse error that buries the real problem.
        /// </summary>
        private ProtocolMismatchException BuildProtocolMismatch(byte[] payload)
        {
            var serverVersion = "unknown";
            string reason = null;

            try
            {
                if (PayloadCodec.ParsePayload(payload) is JObject body)
                {
                    serverVersion = (string)body["serverVersion"] ?? serverVersion;
                    reason = (string)body["reason"];
                }
            }
            catch (Exception)
            {
                // Fall through to the generic wording below.
            }

            reason ??= $"the server speaks protocol v{serverVersion}, this client speaks v{CLIENT_VERSION}";

            _serverVersion = serverVersion;
            _protocolMismatchReason = reason;

            return new ProtocolMismatchException(reason, serverVersion, CLIENT_VERSION);
        }

        // Kept out of the async method above: a ReadOnlySpan<byte> local may not live inside
        // an async state machine.
        private static IReadOnlyList<DecodedFrame> ReadFrames(FrameReader reader, byte[] buffer, int count)
            => reader.Append(new ReadOnlySpan<byte>(buffer, 0, count));

        /// <returns>False if the wait was cancelled, so the caller should stop looping.</returns>
        private static async Task<bool> Delay(int delayMs, CancellationToken token)
        {
            try
            {
                await Task.Delay(delayMs, token).ConfigureAwait(false);
                return true;
            }
            catch (OperationCanceledException)
            {
                return false;
            }
        }

        // millisAgo is for the tests, which stand in for having heard from the server that long ago.
        internal void StampLiveness(long millisAgo = 0) => _liveness.Stamp(millisAgo);

        /// <summary>
        /// How many times the server has been heard from: it changes whenever
        /// <see cref="MillisSinceLastHeartbeat"/> starts again from zero. Sync uses it to note on Unity's
        /// clock when the server was last heard from (Sync.LastHeardAt), which the system clock behind the
        /// heartbeat times need not keep pace with.
        /// </summary>
        internal long LivenessStamps => _liveness.Stamps;

        /// <summary>
        /// How long ago the server was last heard from. Not a round-trip latency: the heartbeat carries the
        /// server's own clock, so the client cannot derive an RTT from it. Real latency figures are in the
        /// server's admin UI.
        /// </summary>
        public long MillisSinceLastHeartbeat() => _liveness.MillisSinceLastHeartbeat();

        /// <summary>Server the connection loop is currently using, as configured.</summary>
        public string ServerAddress => _config.ServerAddress;

        /// <summary>TCP port the connection loop is currently using.</summary>
        public int TcpPort => _config.TcpPort;

        /// <summary>App name this client identifies as. Only clients sharing it can see each other.</summary>
        public string AppName => _config.AppName;

        /// <summary>Client-library protocol version sent in the handshake.</summary>
        public static string ClientVersion => CLIENT_VERSION;

        /// <summary>
        /// Protocol version the server reported when it refused this client, or null while no refusal has
        /// been received. Only set alongside <see cref="ConnectionStatus.ProtocolMismatch"/>: a server that
        /// accepts the connection never sends its version.
        /// </summary>
        public string ServerVersion => _serverVersion;

        /// <summary>
        /// Why the server refused this client, or null if it has not. Companion to
        /// <see cref="ConnectionStatus.ProtocolMismatch"/> for showing the reason.
        /// </summary>
        public string ProtocolMismatchReason => _protocolMismatchReason;

        /// <summary>
        /// Why a protocol mismatch is suspected, or null if it is not. Set when several connections in a row
        /// were accepted but ended before a frame could be read, the only symptom when the server's framing
        /// is too different to send, or this client to decode, the explicit refusal. A connection the heartbeat
        /// watchdog dropped without a frame does not count (that logs a warning of its own).
        /// Unlike <see cref="ProtocolMismatchReason"/> this is a guess: it reads the same whether the server
        /// is out of date or the address points at something that is not Colibri at all. The connection keeps
        /// being retried and <see cref="Status"/> is unaffected. Cleared as soon as any frame decodes.
        /// </summary>
        public string SuspectedProtocolMismatch => _suspectedProtocolMismatch;

        /// <summary>
        /// Why the last attempt to open the TCP connection failed ("192.168.0.10:9212 did not answer within
        /// 5 s", a refusal, or with TLS a failed handshake or a rejected certificate), or null once one has
        /// opened. For showing why the client is not connected; each failure is logged as well.
        /// </summary>
        public string LastConnectFailure => _lastConnectFailure;
        private volatile string _lastConnectFailure;

        /// <summary>
        /// Whether the connection uses TLS: <see cref="ColibriConfig.IsSSL"/> as it was when the
        /// current connection, or the attempt in progress, started.
        /// </summary>
        public bool UsesTls => _state.UsesTls;

        /// <summary>
        /// The SHA-256 fingerprint of the certificate the server presented on the last TLS
        /// connection, as colibri-server logs it, or null before one has been made.
        /// </summary>
        internal string ServerCertificateSha256 => _presentedCertificateSha256;

        /// <summary>Why that certificate was accepted, in words, for the Status window; null before a TLS connection.</summary>
        internal string CertificateAcceptance => _certificateAcceptance;

        internal void OpenOutbox(ServerSession session, CancellationToken token) => _outbox.OpenOutbox(session, token);

        internal void CloseOutbox() => _outbox.CloseOutbox();

        internal void CloseOutbox(CancellationToken token) => _outbox.CloseOutbox(token);

        /// <summary>
        /// Sends a message, queueing it while not connected.
        /// </summary>
        /// <returns>
        /// Completes with true once the message has been written to the socket, or with false if
        /// it never will be: it could not be encoded, a bound on the outbox dropped it, the server
        /// refused this client's protocol version, or this component was destroyed first. Never
        /// false for a message that is still going to be sent, so there is nothing to retry. While
        /// the connection is down it stays pending.
        /// </returns>
        public Task<bool> SendCommandAsync(string channel, string command, JToken payload)
        {
            var frame = PayloadCodec.EncodeFrame(channel, command, payload);
            if (frame == null)
                return Task.FromResult(false);

            // RunContinuationsAsynchronously: it is completed by the drainer and from under the
            // outbox's callers, neither of which should run the awaiting code inline.
            var sent = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            _outbox.Post(channel, command, payload, frame, sent);
            return sent.Task;
        }

        /// <summary>Sends a message, queueing it while not connected. See <see cref="SendCommandAsync"/>.</summary>
        public void SendCommand(string channel, string command, JToken payload)
        {
            var frame = PayloadCodec.EncodeFrame(channel, command, payload);
            if (frame != null)
                _outbox.Post(channel, command, payload, frame, null);
        }
    }
}
