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
        // Must equal PROTOCOL_VERSION in colibri-server (src/server/modules/protocol/protocol.ts) and in
        // colibri-web (src/Colibri.ts); the server's `npm run test:vectors` checks all three.
        private const string CLIENT_VERSION = "2";

        // The server refuses a client with another protocol version on this channel and command.
        // ReceiveLoop handles it itself instead of delivering it as an application message.
        private const string COLIBRI_CHANNEL = "colibri";
        private const string PROTOCOL_REJECTED_COMMAND = "protocol::rejected";

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

        internal FrameWriter FrameWriter => _frameWriter;

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

        private readonly ConnectionDiagnostics _diagnostics;

        // ColibriConfig.Load() goes through Resources.Load, which is main-thread only, so the connection loop
        // reads this snapshot (refreshed in OnEnable and Update).
        private volatile ConnectionConfig _config = ConnectionConfig.Empty;

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

        /// <summary>Current connection state.</summary>
        public ConnectionStatus Status
        {
            get { return _state.Status; }
            private set { _state.Set(value); }
        }

        internal ConnectionState State => _state;


        public WebServerConnection()
        {
            _outbox = new Outbox(_frameWriter);
            _diagnostics = new ConnectionDiagnostics(_state, () => _config, HEARTBEAT_TIMEOUT_THRESHOLD_MS, CLIENT_VERSION);
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

            _diagnostics.ResetTlsReports();

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

            // In this order: leaving Connected re-arms ConnectionState's gate, and an `await Connected` from now on would
            // wait on that fresh task forever, since OnEnable replaces the gate rather than completing it.
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
                    // Before the session loop sees the socket closed: see ConnectionDiagnostics.CountSessionWithoutAFrame.
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

        internal ReceiveQueue ReceiveQueue => _receiveQueue;

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
                    _diagnostics.ReportMissingConfig(app);

                    if (!await Delay(ConnectionState.RECONNECT_DELAY_MIN_MS, token).ConfigureAwait(false))
                        break;
                    continue;
                }

                _diagnostics.ClearMissingConfigReport();

                var handshakeApp = PayloadCodec.HandshakeAppName(app);
                _diagnostics.ReportSanitizedApp(app, handshakeApp);

                var retry = await RunAttempt(loop, config, handshakeApp).ConfigureAwait(false);
                if (!retry)
                    break;

                if (token.IsCancellationRequested)
                    break;

                if (!await Delay(_state.NextBackoffDelay(), token).ConfigureAwait(false))
                    break;
            }
        }

        private async Task<bool> RunAttempt(ConnectionLoop loop, ConnectionConfig config, string handshakeApp)
        {
            var token = loop.Token;
            var address = config.ServerAddress;
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
                return false;
            }
            catch (Exception) when (token.IsCancellationRequested)
            {
                // Ended by OnDisable, which closed the socket under the read or write. Not a failure, so nothing is
                // logged or retried.
                return false;
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
                _diagnostics.ReportTlsFailure(e);
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
                await CleanUpAfterSession(loop, mismatched).ConfigureAwait(false);
            }

            // Terminal: retrying cannot make the versions agree, and would bury the one log line that says what
            // is wrong.
            return !mismatched;
        }

        private async Task CleanUpAfterSession(ConnectionLoop loop, bool mismatched)
        {
            var token = loop.Token;
            var beforeCleanup = BeforeSessionCleanup;
            if (beforeCleanup != null)
                await beforeCleanup().ConfigureAwait(false);

            // This loop's own, whatever the next loop is doing by now (see ConnectionLoop).
            loop.IsWatchdogArmed = false;
            ConnectRace.CloseSocket(loop.Socket);
            loop.Socket = null;

            // Whatever ended the session, except this component being disabled, which says nothing about the server.
            if (!token.IsCancellationRequested)
                _diagnostics.CountSessionWithoutAFrame(loop);

            // Shared with the next loop, so only while this one has not been ended: by then OnDisable has closed
            // the outbox and set the status itself, and they may belong to a session the next enable started.
            _outbox.CloseOutbox(token);

            // Before the status changes, so a reaction to ProtocolMismatch cannot queue a message that waits for
            // a connection that never comes.
            if (mismatched)
                _outbox.RefuseSends(token);

            _state.TrySetStatus(mismatched ? ConnectionStatus.ProtocolMismatch : ConnectionStatus.Disconnected, token);
        }

        internal ConnectionDiagnostics Diagnostics => _diagnostics;

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

            var session = await OpenSession(loop, host, port, certificateCheck).ConfigureAwait(false);

            // Closing the socket unblocks an in-flight read or write, TLS or not; neither has a token overload on
            // this API surface. Closes at once if the token is cancelled already.
            using (token.Register(session.Close))
            {
                try
                {
                    token.ThrowIfCancellationRequested();
                    _diagnostics.LastConnectFailure = null;

                    if (certificateCheck != null)
                        _diagnostics.NoteCertificate(certificateCheck, host, port);

                    // Accepted, but nothing is known about what accepted it yet. The watchdog gives
                    // it as long to say something as a connected server gets between heartbeats.
                    _liveness.Stamp();
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

        private async Task<ServerSession> OpenSession(ConnectionLoop loop, string host, int port, ServerCertificateCheck certificateCheck)
        {
            var token = loop.Token;
            try
            {
                // Every address tried gets a socket of its own. The loop holds the one being tried, so OnDisable and
                // the cleanup after this session close it.
                return await ServerConnector.OpenSessionAsync(host, port, certificateCheck, CONNECT_TIMEOUT_MS, socket => loop.Socket = socket, token)
                    .ConfigureAwait(false);
            }
            catch (TimeoutException e) when (!token.IsCancellationRequested)
            {
                _diagnostics.LastConnectFailure = e.Message;
                throw;
            }
            catch (TlsHandshakeException e) when (!token.IsCancellationRequested)
            {
                _diagnostics.LastConnectFailure = e.Message;
                throw;
            }
            catch (SocketException e) when (!token.IsCancellationRequested)
            {
                _diagnostics.LastConnectFailure = $"connecting to {host}:{port} failed ({e.SocketErrorCode})";
                throw;
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

            _liveness.Stamp();

            _receiveQueue.ResetBacklogWarning();

            // A TLS failure after this one is news again.
            _diagnostics.ClearReportedTlsFailure();

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
                    _liveness.Stamp();

                var frames = ReadFrames(reader, buffer, received);
                if (frames.Count > 0 && !loop.DecodedAnyFrame)
                    _diagnostics.OnFrameDecoded(loop);

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

                    HandleFrame(session, frame, token);
                }
            }

            token.ThrowIfCancellationRequested();
        }

        private void HandleFrame(ServerSession session, DecodedFrame frame, CancellationToken token)
        {
            switch (frame.Type)
            {
                case FrameType.Heartbeat:
                    // Echoed back verbatim: the u64 is the server's own monotonic clock reading and is never interpreted
                    // here. Since 2.0.0 this echo is the sole source of the server's TCP latency measurements. Not
                    // awaited, see FrameWriter.EchoHeartbeat.
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

            _diagnostics.ServerVersion = serverVersion;
            _diagnostics.ProtocolMismatchReason = reason;

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

        internal Liveness Liveness => _liveness;

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
        public string ServerVersion => _diagnostics.ServerVersion;

        /// <summary>
        /// Why the server refused this client, or null if it has not. Companion to
        /// <see cref="ConnectionStatus.ProtocolMismatch"/> for showing the reason.
        /// </summary>
        public string ProtocolMismatchReason => _diagnostics.ProtocolMismatchReason;

        /// <summary>
        /// Why a protocol mismatch is suspected, or null if it is not. Set when several connections in a row
        /// were accepted but ended before a frame could be read, the only symptom when the server's framing
        /// is too different to send, or this client to decode, the explicit refusal. A connection the heartbeat
        /// watchdog dropped without a frame does not count (that logs a warning of its own).
        /// Unlike <see cref="ProtocolMismatchReason"/> this is a guess: it reads the same whether the server
        /// is out of date or the address points at something that is not Colibri at all. The connection keeps
        /// being retried and <see cref="Status"/> is unaffected. Cleared as soon as any frame decodes.
        /// </summary>
        public string SuspectedProtocolMismatch => _diagnostics.SuspectedProtocolMismatch;

        /// <summary>
        /// Why the last attempt to open the TCP connection failed ("192.168.0.10:9212 did not answer within
        /// 5 s", a refusal, or with TLS a failed handshake or a rejected certificate), or null once one has
        /// opened. For showing why the client is not connected; each failure is logged as well.
        /// </summary>
        public string LastConnectFailure => _diagnostics.LastConnectFailure;

        /// <summary>
        /// Whether the connection uses TLS: <see cref="ColibriConfig.IsSSL"/> as it was when the
        /// current connection, or the attempt in progress, started.
        /// </summary>
        public bool UsesTls => _state.UsesTls;

        /// <summary>
        /// The SHA-256 fingerprint of the certificate the server presented on the last TLS
        /// connection, as colibri-server logs it, or null before one has been made.
        /// </summary>
        internal string ServerCertificateSha256 => _diagnostics.PresentedCertificateSha256;

        /// <summary>Why that certificate was accepted, in words, for the Status window; null before a TLS connection.</summary>
        internal string CertificateAcceptance => _diagnostics.CertificateAcceptance;

        internal Outbox Outbox => _outbox;

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
