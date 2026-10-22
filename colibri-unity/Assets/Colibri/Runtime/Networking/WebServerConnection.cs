using HCIKonstanz.Colibri.Core;
using HCIKonstanz.Colibri.Networking.Protocol;
using HCIKonstanz.Colibri.Setup;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net.Security;
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
        private const int RECONNECT_DELAY_MIN_MS = 500;
        private const int RECONNECT_DELAY_MAX_MS = 10 * 1000;

        // One connection attempt: name lookup, every address tried and, with TLS, the handshake (a server
        // without TLS may never answer it). The socket has no timeout of its own (about two minutes on
        // Android); 5 s leaves room for two lost SYNs. Sync.StopsWaitingForServer waits as long before it
        // simulates a placed body without the server's state.
        internal const int CONNECT_TIMEOUT_MS = 5000;

        // Cap on broadcasts and other messages that are not model state waiting for the connection. The oldest
        // are dropped: this is a last-write-wins sync client, so a long queue only buffers superseded updates.
        // Model messages are not counted here, see "The outbox" below.
        private const int MAX_QUEUED_MESSAGES = 256;

        // Cap on the whole outbox, model state included: the backstop for MAX_QUEUED_MESSAGES, which applies
        // only while disconnected and does not count requests, deletes and unfoldable updates. Past it the
        // oldest droppable messages go first, then the oldest model messages.
        private const int MAX_OUTBOX_MESSAGES = 10000;

        // Received messages waiting for Update past which model updates are folded per object, newer fields
        // winning. The receive thread keeps reading while Update does not run (Quest paused, Editor in the
        // background), so model state is bounded by the number of objects, not by how long Update stalled.
        // A listener that records every update sees only the newest state of each object for that stretch.
        private const int RECEIVED_FOLDING_THRESHOLD = 1000;

        // Cap on all received messages waiting for Update, the backstop for RECEIVED_FOLDING_THRESHOLD as
        // MAX_OUTBOX_MESSAGES is for the outbox. The oldest broadcasts and other non-model messages are
        // dropped first, then the oldest model messages.
        private const int MAX_RECEIVED_MESSAGES = 10000;

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

        // One run of the connection loop, from the OnEnable that starts it to the OnDisable that ends it.
        // A disable and enable in one frame start the next run while the last still unwinds on a worker
        // thread, so a run keeps its own socket and watchdog here. The state the component shares (Status,
        // the outbox, what is reported about the connection) a run changes only while its token is not
        // cancelled, checked under the lock that guards it; OnDisable cancels the token before it sets all
        // of that itself.
        private sealed class ConnectionLoop
        {
            public readonly CancellationTokenSource Lifetime = new CancellationTokenSource();

            // Taken once: Lifetime.Token throws after OnDisable has disposed the source, and the run may still unwind.
            public readonly CancellationToken Token;

            // Socket of the attempt or session in progress, null between two. Closing it ends a session, TLS or
            // not. Set and cleared by the run, read by the watchdog in Update and by OnDisable; the send path
            // uses _outboxSession.
            public volatile Socket Socket;

            // Set when the TCP connection is accepted, cleared when the session ends or the watchdog fires.
            // Covers the stretch before the first frame, so a server that accepts and then says nothing cannot
            // hold a session in Connecting.
            public volatile bool IsWatchdogArmed;

            // Session-scoped: the TCP connection is up and the handshake sent. Without it, a refused connection
            // (server not running) would count towards the framing hint.
            public volatile bool ReachedHandshake;

            // Session-scoped: the session has decoded a frame. Only sessions that end before this count towards
            // the framing hint.
            public volatile bool DecodedAnyFrame;

            // Session-scoped: the watchdog dropped the session before the server sent a frame. Counts towards the
            // unanswered-session hint, not the framing hint (see CountSessionWithoutAFrame).
            public volatile bool EndedSilent;

            // Session-scoped: the watchdog closed the socket, connected or not, and has said why, so the read or
            // write that fails on it is not logged as well.
            public volatile bool DroppedByWatchdog;

            // Session-scoped: ended on a frame that could not be decoded, as sessions with a 1.x server do. With
            // TLS, the only frameless session that counts towards the framing hint.
            public volatile bool EndedOnBadFrame;

            // Completes once the run has ended and cleaned up after its last session.
            public Task Run;

            public ConnectionLoop()
            {
                Token = Lifetime.Token;
            }
        }

        // The tests shrink its send buffer to stand in for a slow link.
        internal Socket CurrentSocket => _loop?.Socket;

        // The tests wait on it for an ended loop to finish its cleanup.
        internal Task CurrentLoop => _loop?.Run;

        // Tests only: awaited when a session has ended, before the loop cleans up after it. Holds a loop that
        // OnDisable ended until the next loop is Connected, so a cleanup touching its status or outbox shows.
        internal volatile Func<Task> BeforeSessionCleanup;

        private string _hostname = "";

        // Serializes every socket write, outbox messages and heartbeat echoes alike: concurrent writes would
        // interleave bytes and corrupt the framing, and an SslStream takes one write at a time. The receive
        // loop never waits for it (see EchoHeartbeat).
        private readonly SemaphoreSlim _sendLock = new SemaphoreSlim(1, 1);

        // The tests hold it to stand in for a slow write.
        internal SemaphoreSlim SendLock => _sendLock;

        // The newest heartbeat echo not written yet, with the session it answers, or null. Set by the receive
        // loop, taken by whoever holds _sendLock (see EchoHeartbeat).
        private PendingEcho _pendingEcho;

        private sealed class PendingEcho
        {
            public ServerSession Session;
            public byte[] Frame;
        }

        // Every outgoing message in send order, until written to a socket (see "The outbox" below).
        // Everything up to _hasWarnedAboutRefusal is guarded by _outboxLock: senders on any thread, the
        // drainer on the thread pool and the connection loop all touch it.
        private readonly LinkedList<Outgoing> _outbox = new LinkedList<Outgoing>();
        private readonly object _outboxLock = new object();

        // The session the outbox drains into, and its token. Null while not connected, which makes a send
        // wait in the outbox.
        private ServerSession _outboxSession;
        private CancellationToken _outboxToken;

        // True while a DrainOutbox is running. Only one runs at a time, which keeps the messages in order.
        private bool _isDraining;

        // Reset when the outbox opens, so each is logged once per connection.
        private bool _hasWarnedAboutDrops;
        private bool _hasWarnedAboutOutboxLimit;

        // Set when the server refuses this client's protocol version. Nothing is sent after that, so a send
        // completes at once as dropped.
        private bool _isRefused;
        private bool _hasWarnedAboutRefusal;

        // Receive loop in, main thread out. Everything up to _hasWarnedAboutReceivedBacklog is guarded by
        // _queuedCommandsLock. See EnqueueReceived for how the queue is bounded.
        private readonly LinkedList<InPacket> _queuedCommands = new LinkedList<InPacket>();
        private readonly object _queuedCommandsLock = new object();

        // During a backlog (from RECEIVED_FOLDING_THRESHOLD messages until Update takes them): the model::update
        // queued for each object that later ones can still be folded into, i.e. with nothing else about the
        // object queued behind it.
        private readonly Dictionary<(string Channel, string Id), LinkedListNode<InPacket>> _queuedReceivedUpdates
            = new Dictionary<(string Channel, string Id), LinkedListNode<InPacket>>();
        private bool _isReceivedBacklog;
        private int _droppableReceivedCount;
        private int _foldedReceivedCount;
        private int _droppedReceivedCount;

        // Reset on every connection, so a backlog is logged once per connection.
        private bool _hasWarnedAboutReceivedBacklog;

        // Main thread only: reused by DeliverReceivedMessages from frame to frame.
        private readonly List<InPacket> _delivering = new List<InPacket>();

        private readonly Liveness _liveness = new Liveness();

        // Main thread only: the OnMessageReceived value last delivered to, and its invocation list.
        private MessageAction _deliveringTo;
        private Delegate[] _deliveringToList;

        // Both touched by the connection loop and, via the Status setter, by Update: every access is under
        // _statusLock.
        private int _connectAttempts;
        private int _connectedSessions;

        // How many times the connection has become Connected; 2 or more in an OnConnected handler means a reconnect.
        internal int ConnectedSessions
        {
            get
            {
                lock (_statusLock)
                    return _connectedSessions;
            }
        }

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
        private volatile string _serverAddress;
        private volatile string _appName;
        private volatile int _tcpPort;
        private volatile bool _useTls;
        private volatile bool _allowSelfSignedCertificate;
        private volatile string _serverCertificateSha256;

        // Set by each TLS handshake, for the Status window: the certificate the server presented and how it
        // was accepted. Null until a TLS connection has been made.
        private volatile string _presentedCertificateSha256;
        private volatile string _certificateAcceptance;

        // Gate behind `await Connected`, awaited by user code only (sends queue in the outbox instead).
        // A TaskCompletionSource because several callers may await it at once, which UniTaskCompletionSource
        // rejects. volatile: re-armed on the connection loop's thread, read on any.
        private volatile TaskCompletionSource<bool> _connectedGate = NewGate();
        private volatile bool _isGateOpen;

        /// <summary>
        /// Completes when <see cref="Status"/> becomes <see cref="ConnectionStatus.Connected"/>, i.e. once the
        /// server has sent its first frame; while disconnected it is a fresh, pending task. Cancelled when this
        /// component is disabled and when the server refuses the protocol version, which is final.
        /// </summary>
        public Task Connected => _connectedGate.Task;

        private static TaskCompletionSource<bool> NewGate()
            => new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

        // OnConnected (true) and OnDisconnected (false) still to be raised on the main thread, in the order
        // the transitions happened. Queued by the Status setter under _statusLock.
        private readonly ConcurrentQueue<bool> _connectionEvents = new ConcurrentQueue<bool>();

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

        private volatile ConnectionStatus _status = ConnectionStatus.Disconnected;

        // Written by the receive loop off the main thread, read by the Editor status window and by user code
        // on the main thread.
        private volatile string _serverVersion;
        private volatile string _protocolMismatchReason;

        // Connection loop only (the receive loop is part of it), except for the test accessor.
        private int _consecutiveEarlyFrameFailures;
        private int _consecutiveUnansweredSessions;
        private volatile string _suspectedProtocolMismatch;

        // Whether the current session uses TLS, read from the configuration when it started. Written by the
        // connection loop under _statusLock, read by UsesTls on any thread.
        private volatile bool _sessionUsesTls;

        // Status's setter is a read-modify-write over several fields, and both the connection loop and the
        // watchdog in Update reach it. Unguarded, a transition can be lost: a watchdog Disconnected landing
        // between the loop's compare and assignment leaves the gate open on a closed socket. A loop sets it
        // through TrySetStatus, which also checks under this lock that the loop has not been ended.
        private readonly object _statusLock = new object();

        /// <summary>Current connection state.</summary>
        public ConnectionStatus Status
        {
            get { return _status; }
            private set
            {
                lock (_statusLock)
                {
                    if (_status == value)
                        return;

                    var wasConnected = _status == ConnectionStatus.Connected;
                    _status = value;

                    if (_status == ConnectionStatus.Connected)
                    {
                        _connectAttempts = 0;
                        _connectedSessions++;
                        _connectionEvents.Enqueue(true);
                        _isGateOpen = true;

                        // Continuations run asynchronously (see NewGate), so no awaiter resumes inline under the lock.
                        _connectedGate.TrySetResult(true);
                    }
                    else if (_isGateOpen)
                    {
                        // Re-arm, so `await Connected` while disconnected waits for the next connection.
                        _isGateOpen = false;
                        _connectedGate = NewGate();
                    }

                    // Final: there is no next connection to wait for.
                    if (_status == ConnectionStatus.ProtocolMismatch)
                        _connectedGate.TrySetCanceled();

                    // One OnDisconnected per OnConnected, whatever ended the connection, a refusal included.
                    if (wasConnected)
                        _connectionEvents.Enqueue(false);
                }
            }
        }

        /// <summary>
        /// Sets <see cref="Status"/> for the connection loop that <paramref name="token"/> belongs to, unless
        /// OnDisable has ended that loop: the status is then OnDisable's and the next loop's. Checked under the
        /// lock the setter takes, so OnDisable, which cancels the token before it sets Disconnected, has the
        /// last word.
        /// </summary>
        /// <returns>False if the loop has been ended.</returns>
        internal bool TrySetStatus(ConnectionStatus value, CancellationToken token)
        {
            lock (_statusLock)
            {
                if (token.IsCancellationRequested)
                    return false;

                Status = value;
                return true;
            }
        }

        private struct InPacket
        {
            public string Channel;
            public string Command;
            public JToken Payload;

            // Dropped before any model message when the queue is over its bound; false for model commands, as in the outbox.
            public bool CanDrop;
        }


        private void OnEnable()
        {
            DontDestroyOnLoad(this);

            // Can only be read from the main thread.
            _hostname = PayloadCodec.SanitizeHandshakeField(SystemInfo.deviceName);
            RefreshConfig();

            _connectedGate = NewGate();
            _isGateOpen = false;

            // Enabling the component again is a deliberate retry, refusal or not.
            lock (_outboxLock)
            {
                _isRefused = false;
                _hasWarnedAboutRefusal = false;
            }

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

            _serverAddress = config.Host;
            _appName = config.App;
            _tcpPort = config.TcpServerPort;
            _useTls = config.IsSSL;
            _allowSelfSignedCertificate = config.AllowSelfSignedCertificate;
            _serverCertificateSha256 = config.ServerCertificateSha256;
        }

        private void OnDisable()
        {
            // Quitting or ending Play mode: SyncTicker has just handed over what the send rate limit held, and on
            // Mono and IL2CPP a socket write completes a moment later on a worker thread, so closing the socket
            // now could lose it. An ordinary disable does not wait: the queue stays for the next enable.
            if (SingletonLifetime.IsQuitting)
                WaitForOutboxToDrain(QUIT_DRAIN_TIMEOUT_MS);

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
            CloseOutbox();

            // In this order: leaving Connected re-arms the gate, and an `await Connected` from now on would wait
            // on that fresh task forever, since OnEnable replaces the gate rather than completing it.
            Status = ConnectionStatus.Disconnected;
            _connectedGate.TrySetCanceled();

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
            Outgoing[] abandoned;
            lock (_outboxLock)
                abandoned = TakeEverythingQueued();

            foreach (var message in abandoned)
                message.Sent?.TrySetResult(false);
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
                    CloseOutbox();
                    Status = ConnectionStatus.Disconnected;
                }
                else
                {
                    // Before the session loop sees the socket closed: see CountSessionWithoutAFrame.
                    loop.EndedSilent = true;
                    Debug.Log($"Colibri: {_serverAddress}:{_tcpPort} accepted the connection but has not sent anything in "
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
                while (_connectionEvents.TryDequeue(out var connected))
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

        /// <summary>
        /// Hands a received message to the main thread, where <see cref="Update"/> delivers it. Bounded like
        /// the outbox for the stretches Update does not run: past <see cref="RECEIVED_FOLDING_THRESHOLD"/>
        /// waiting messages a model::update is folded into the one queued for the same object, and past
        /// <see cref="MAX_RECEIVED_MESSAGES"/> the oldest messages are dropped, broadcasts first.
        /// Does nothing once OnDisable has ended the connection loop that <paramref name="token"/> belongs
        /// to: the next loop's messages may be queued by then, and this one would land behind them.
        /// </summary>
        /// <remarks>
        /// Called from the receive loop. The queue owns <paramref name="payload"/> from here on: a fold writes
        /// newer fields into it.
        /// </remarks>
        internal void EnqueueReceived(string channel, string command, JToken payload, CancellationToken token = default)
        {
            var canDrop = ModelCommands.IsDroppable(command);

            lock (_queuedCommandsLock)
            {
                // Checked and queued under one lock: the next loop starts only after OnDisable has cancelled the
                // token, so its messages queue behind this one.
                if (token.IsCancellationRequested)
                    return;

                if (!_isReceivedBacklog && _queuedCommands.Count >= RECEIVED_FOLDING_THRESHOLD)
                    _isReceivedBacklog = true;

                if (_isReceivedBacklog && ModelCommands.IsFoldableUpdate(command, payload, out var update, out var id))
                {
                    var key = (channel, id);
                    if (_queuedReceivedUpdates.TryGetValue(key, out var queued))
                    {
                        // The queued payload was parsed off the socket and nothing else holds it yet. To the back of the
                        // queue: it now carries the newest change.
                        var merged = (JObject)queued.Value.Payload;
                        foreach (var property in update.Properties())
                            merged[property.Name] = property.Value;

                        _queuedCommands.Remove(queued);
                        _queuedCommands.AddLast(queued);
                        _foldedReceivedCount++;
                        return;
                    }

                    _queuedReceivedUpdates[key] = _queuedCommands.AddLast(
                        new InPacket { Channel = channel, Command = command, Payload = payload, CanDrop = false });
                }
                else
                {
                    // A delete, or a bare { id } that answers a request, ends the fold for its object: an older update
                    // folded past it would arrive after it. StopFolding is the outbox's counterpart.
                    if (_isReceivedBacklog && !canDrop)
                        StopFoldingReceived(channel, payload);

                    _queuedCommands.AddLast(new InPacket { Channel = channel, Command = command, Payload = payload, CanDrop = canDrop });
                    if (canDrop)
                        _droppableReceivedCount++;
                }

                while (_queuedCommands.Count > MAX_RECEIVED_MESSAGES)
                    DropOldestReceived();
            }
        }

        // Under _queuedCommandsLock.
        private void StopFoldingReceived(string channel, JToken payload)
        {
            if (ModelCommands.TryGetModelId(payload, out _, out var id))
            {
                _queuedReceivedUpdates.Remove((channel, id));
                return;
            }

            // No id: about every object on the channel, as far as anyone can tell.
            List<(string Channel, string Id)> onChannel = null;
            foreach (var key in _queuedReceivedUpdates.Keys)
            {
                if (key.Channel == channel)
                    (onChannel ??= new List<(string Channel, string Id)>()).Add(key);
            }

            if (onChannel != null)
            {
                foreach (var key in onChannel)
                    _queuedReceivedUpdates.Remove(key);
            }
        }

        // Under _queuedCommandsLock. The oldest message that may be dropped goes first, and only
        // when none is left the oldest of the rest.
        private void DropOldestReceived()
        {
            var victim = _queuedCommands.First;
            if (_droppableReceivedCount > 0)
            {
                while (!victim.Value.CanDrop)
                    victim = victim.Next;
                _droppableReceivedCount--;
            }

            _queuedCommands.Remove(victim);
            _droppedReceivedCount++;

            var packet = victim.Value;
            if (!packet.CanDrop
                && ModelCommands.TryGetModelId(packet.Payload, out _, out var id)
                && _queuedReceivedUpdates.TryGetValue((packet.Channel, id), out var indexed)
                && ReferenceEquals(indexed, victim))
            {
                _queuedReceivedUpdates.Remove((packet.Channel, id));
            }
        }

        /// <summary>
        /// Delivers everything received since the last frame. Handlers run on the main thread, one at a time,
        /// and one that throws does not stop the others or the messages queued behind it.
        /// </summary>
        internal void DeliverReceivedMessages()
        {
            int folded;
            int dropped;
            var warnAboutBacklog = false;

            // Reused from frame to frame, except by a handler that delivers again from inside one.
            var batch = _delivering.Count == 0 ? _delivering : new List<InPacket>();

            // Taken in one go, so the receive thread is held up once per frame rather than once per
            // message. What arrives while these are delivered waits for the next frame.
            lock (_queuedCommandsLock)
            {
                if (_queuedCommands.Count == 0)
                    return;

                batch.AddRange(_queuedCommands);
                _queuedCommands.Clear();

                folded = _foldedReceivedCount;
                dropped = _droppedReceivedCount;
                if ((folded > 0 || dropped > 0) && !_hasWarnedAboutReceivedBacklog)
                {
                    _hasWarnedAboutReceivedBacklog = true;
                    warnAboutBacklog = true;
                }

                // The backlog, if there was one, is over.
                _isReceivedBacklog = false;
                _queuedReceivedUpdates.Clear();
                _droppableReceivedCount = 0;
                _foldedReceivedCount = 0;
                _droppedReceivedCount = 0;
            }

            if (warnAboutBacklog)
            {
                var lost = dropped > 0
                    ? $" and the {dropped} oldest messages were dropped, broadcasts first"
                    : "; nothing was dropped";
                Debug.LogWarning($"Colibri: {batch.Count + folded + dropped} received messages waited for Update, which did not run "
                    + "for a while (the app was paused, or the Editor was in the background without Run In Background). To keep memory "
                    + $"bounded, {folded} model updates were folded into the newest state of their object{lost}. Said once per connection.");
            }

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
         *  _queuedCommands and Update.
         */

        // One long-lived task per run, rather than Update retrying every frame while disconnected.
        private async Task RunConnectionLoop(ConnectionLoop loop)
        {
            var token = loop.Token;
            while (!token.IsCancellationRequested)
            {
                var address = _serverAddress;
                var app = _appName;

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

                    if (!await Delay(RECONNECT_DELAY_MIN_MS, token).ConfigureAwait(false))
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
                    await RunSession(loop, address, _tcpPort, handshakeApp, _useTls).ConfigureAwait(false);
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
                    CloseOutbox(token);

                    // Before the status changes, so a reaction to ProtocolMismatch cannot queue a message that waits for
                    // a connection that never comes.
                    if (mismatched)
                        RefuseSends(token);

                    TrySetStatus(mismatched ? ConnectionStatus.ProtocolMismatch : ConnectionStatus.Disconnected, token);
                }

                // Terminal: retrying cannot make the versions agree, and would bury the one log line that says what
                // is wrong.
                if (mismatched)
                    break;

                if (token.IsCancellationRequested)
                    break;

                if (!await Delay(NextBackoffDelay(), token).ConfigureAwait(false))
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
            if (loop.EndedSilent || (_sessionUsesTls && !loop.EndedOnBadFrame))
            {
                _consecutiveEarlyFrameFailures = 0;
                _consecutiveUnansweredSessions++;
                if (_consecutiveUnansweredSessions == EARLY_FRAME_FAILURES_BEFORE_HINT)
                {
                    Debug.LogWarning(
                        $"Colibri: {_consecutiveUnansweredSessions} connections in a row to {_serverAddress}:{_tcpPort} were accepted, " +
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
            if (!_sessionUsesTls)
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

        private async Task RunSession(ConnectionLoop loop, string host, int port, string app, bool useTls)
        {
            var token = loop.Token;
            lock (_statusLock)
            {
                // A loop that OnDisable has ended starts nothing: the status, and the connection
                // UsesTls describes, may already be the next loop's.
                token.ThrowIfCancellationRequested();

                _sessionUsesTls = useTls;
                Status = _connectAttempts == 0 ? ConnectionStatus.Connecting : ConnectionStatus.Reconnecting;
            }

            Debug.Log($"Colibri: connecting to {host}:{port}{(useTls ? " (TLS)" : "")}");

            var certificateCheck = useTls
                ? new ServerCertificateCheck(host, _allowSelfSignedCertificate, _serverCertificateSha256)
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

                    await SendFrame(session, FrameCodec.EncodeHandshake(CLIENT_VERSION, app, _hostname), token)
                        .ConfigureAwait(false);
                    // Past this point the connection was accepted and this client has spoken, so a
                    // session that now ends without a frame is a statement about the server.
                    loop.ReachedHandshake = true;

                    await ReceiveLoop(loop, session, host, port, app).ConfigureAwait(false);
                }
                finally
                {
                    ReleaseStream(session.Stream);
                }
            }
        }

        /// <summary>
        /// Disposes a session's stream once it has ended: an SslStream holds TLS state that closing the socket
        /// does not free. Waits for the send lock first, since a write of this session may still be on its way
        /// out of the outbox or the heartbeat echo. Not awaited, so the end of a session never waits for a write.
        /// </summary>
        private void ReleaseStream(Stream stream)
        {
            if (!(stream is SslStream))
                return;

            _ = Task.Run(async () =>
            {
                await _sendLock.WaitAsync().ConfigureAwait(false);
                try
                {
                    stream.Dispose();
                }
                catch (Exception)
                {
                    // The socket under it is closed already; there is nothing left to tidy.
                }
                finally
                {
                    ReleaseSendLock();
                }
            });
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

            lock (_queuedCommandsLock)
                _hasWarnedAboutReceivedBacklog = false;

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
            OpenOutbox(session, token);
            if (!TrySetStatus(ConnectionStatus.Connected, token))
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
                            EchoHeartbeat(session, frame.PingTimestamp);
                            break;

                        case FrameType.Message:
                            EnqueueReceived(frame.Channel, frame.Command, PayloadCodec.ParsePayload(frame.Payload), token);
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

        private int NextBackoffDelay()
        {
            // Same lock as the Status setter, which resets the counter on a successful connect.
            lock (_statusLock)
            {
                var shift = Math.Min(_connectAttempts, 5);
                _connectAttempts++;
                return Math.Min(RECONNECT_DELAY_MAX_MS, RECONNECT_DELAY_MIN_MS << shift);
            }
        }

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
        public string ServerAddress => _serverAddress;

        /// <summary>TCP port the connection loop is currently using.</summary>
        public int TcpPort => _tcpPort;

        /// <summary>App name this client identifies as. Only clients sharing it can see each other.</summary>
        public string AppName => _appName;

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
        public bool UsesTls => _sessionUsesTls;

        /// <summary>
        /// The SHA-256 fingerprint of the certificate the server presented on the last TLS
        /// connection, as colibri-server logs it, or null before one has been made.
        /// </summary>
        internal string ServerCertificateSha256 => _presentedCertificateSha256;

        /// <summary>Why that certificate was accepted, in words, for the Status window; null before a TLS connection.</summary>
        internal string CertificateAcceptance => _certificateAcceptance;


        /*
         *  Sending
         */

        // All writes hold _sendLock, so a frame is never interleaved with another frame's bytes. Heartbeat
        // echoes come through EchoHeartbeat, which never waits for the lock, and are written between two frames.
        private async Task SendFrame(ServerSession session, byte[] frame, CancellationToken token)
        {
            await _sendLock.WaitAsync(token).ConfigureAwait(false);
            try
            {
                // An echo that came in while someone else had the socket goes first; one that came in while this
                // frame was being written (seconds, for a large frame on a slow link) goes straight after it.
                await WritePendingEcho(session).ConfigureAwait(false);
                await WriteAll(session, frame).ConfigureAwait(false);
                await WritePendingEcho(session).ConfigureAwait(false);
            }
            finally
            {
                ReleaseSendLock();
            }
        }

        // Under _sendLock. A stream write completes only once the whole frame has been handed to
        // the socket (encrypted first, with TLS), so a frame is never cut short.
        private static Task WriteAll(ServerSession session, byte[] frame)
            => session.Stream.WriteAsync(frame, 0, frame.Length);

        /// <summary>
        /// Answers a server heartbeat without waiting for the socket. The receive loop calls this and must
        /// never wait for a write: a large message on a slow link holds the socket, and a receive loop stuck
        /// behind it stops reading the server's heartbeats, so the watchdog in <see cref="Update"/> would
        /// drop a healthy connection after 2 s.
        /// </summary>
        /// <remarks>
        /// The echo is left in a slot and written by whoever has the socket: at once if nobody does, otherwise
        /// by the write in progress as soon as its frame is complete, so a frame is never split by another
        /// frame's bytes. Only the newest echo is kept. While a long write holds the socket the server is
        /// still receiving its bytes, which is what its idle timeout looks at; a skipped echo only costs it one
        /// latency sample.
        /// </remarks>
        private void EchoHeartbeat(ServerSession session, ulong pingTimestamp)
        {
            Volatile.Write(ref _pendingEcho, new PendingEcho { Session = session, Frame = FrameCodec.EncodeHeartbeat(pingTimestamp) });

            if (_sendLock.Wait(0))
                _ = WritePendingEchoAndRelease();
        }

        // Called holding _sendLock, which it releases.
        private async Task WritePendingEchoAndRelease()
        {
            try
            {
                await WritePendingEcho(null).ConfigureAwait(false);
            }
            finally
            {
                ReleaseSendLock();
            }
        }

        /// <summary>
        /// Under _sendLock: writes the pending echo, if there is one. With <paramref name="session"/>, only an
        /// echo that belongs to that session; one left over from an earlier session answers nothing any more,
        /// and is dropped.
        /// </summary>
        /// <remarks>Never throws: a write that fails closes the socket, which ends the session.</remarks>
        private async Task WritePendingEcho(ServerSession session)
        {
            var echo = Interlocked.Exchange(ref _pendingEcho, null);
            if (echo == null || (session != null && !ReferenceEquals(echo.Session, session)))
                return;

            try
            {
                await WriteAll(echo.Session, echo.Frame).ConfigureAwait(false);
            }
            catch (Exception)
            {
                // The connection is gone. Closing the socket makes the receive loop notice now,
                // and a message written next fails and stays queued for the next session.
                echo.Session.Close();
            }
        }

        /// <summary>
        /// Lets go of the socket. An echo that arrived after the holder last looked would otherwise
        /// wait for the next write or the next heartbeat, so it is written now, unless another
        /// write has taken the socket in the meantime, which then writes it.
        /// </summary>
        private void ReleaseSendLock()
        {
            _sendLock.Release();

            if (Volatile.Read(ref _pendingEcho) != null && _sendLock.Wait(0))
                _ = WritePendingEchoAndRelease();
        }

        /*
         *  The outbox.
         *
         *  Every message goes into one FIFO and is written to the socket by one drainer, so messages leave
         *  in the order they were sent, across an outage too. While connected the outbox is just the way to
         *  the socket and normally empty or close to it. While not, it is the retry queue, sent ahead of
         *  anything newer once the next session is connected. A message whose write failed stays at the head
         *  and goes first next time.
         *
         *  The queue is bounded during an outage, but not by dropping just anything. Broadcasts, and
         *  anything else that is not model state, are capped at MAX_QUEUED_MESSAGES, oldest dropped first.
         *  The model commands are not dropped by it, because nothing would repair the loss: a dropped
         *  model::request leaves its SyncBehaviour waiting for its first state and never sending a change, a
         *  dropped model::delete leaves the object alive on every other client, and a dropped model::update
         *  is lost, and the re-request after reconnecting then reverts it locally to the server's older copy.
         *  Instead, every model::update queued for the same object during an outage is folded into one, newer
         *  fields winning, which is what a last-write-wins server would have ended up with. That keeps model
         *  state bounded by the number of objects rather than by how long the outage lasts.
         *
         *  Requests, deletes and awaited updates are not folded; each is queued as it is. So behind both of
         *  these sits a hard cap on the whole outbox, MAX_OUTBOX_MESSAGES, which applies while connected too:
         *  the last resort, which does drop model state rather than grow without end.
         *
         *  The folded update moves to the back of the queue, so a fold must never carry an update past
         *  something else about the same object: a newer update, a delete, or a request the server would
         *  answer without it. Such a message ends the fold for that object, the next update starts a new one
         *  behind it, and reconnecting ends every fold.
         */

        private sealed class Outgoing
        {
            public byte[] Frame;

            // Null for SendCommand, which nobody awaits.
            public TaskCompletionSource<bool> Sent;

            // Whether the outage bound counts it, and the cap on the whole outbox drops it before any
            // model command: false for the model commands.
            public bool CanDrop;

            // Set for a model::update queued during an outage, which later updates for the same
            // object in that outage may be folded into (see _queuedModelUpdates). The payload is a
            // private copy.
            public JObject ModelUpdate;
            public (string Channel, string Id) ModelKey;
        }

        // Under _outboxLock: how many droppable messages the outbox holds, and the model::update
        // queued for each object during the current outage that later ones can still be folded
        // into, i.e. with nothing else about the object queued behind it.
        private int _droppableCount;
        private readonly Dictionary<(string Channel, string Id), LinkedListNode<Outgoing>> _queuedModelUpdates
            = new Dictionary<(string Channel, string Id), LinkedListNode<Outgoing>>();

        /// <summary>
        /// Lets the outbox drain into this session. Called once it is Connected, with the token of the loop the
        /// session belongs to: once OnDisable has ended that loop this does nothing.
        /// </summary>
        internal void OpenOutbox(ServerSession session, CancellationToken token)
        {
            bool startDraining;
            lock (_outboxLock)
            {
                // Checked under the lock: OnDisable cancels the token before it closes the outbox.
                if (token.IsCancellationRequested)
                    return;

                _outboxSession = session;
                _outboxToken = token;
                _hasWarnedAboutDrops = false;
                _hasWarnedAboutOutboxLimit = false;

                // Folds last one outage. What was folded in the outage that just ended is ordinary queued messages
                // now; if one is still queued when the connection drops again (slow link), folding the next outage's
                // update for that object into it would move it past the newer updates queued behind it.
                _queuedModelUpdates.Clear();

                startDraining = !_isDraining && _outbox.Count > 0;
                if (startDraining)
                    _isDraining = true;
            }

            if (startDraining)
                _ = DrainOutbox();
        }

        /// <summary>Makes every send from now on wait in the outbox for the next connection.</summary>
        internal void CloseOutbox()
        {
            lock (_outboxLock)
            {
                _outboxSession = null;
                _outboxToken = CancellationToken.None;

                // Nothing more will be written to that session: see WaitForOutboxToDrain.
                Monitor.PulseAll(_outboxLock);
            }
        }

        /// <summary>
        /// <see cref="CloseOutbox()"/> for the connection loop that <paramref name="token"/> belongs to, when
        /// its session ends, unless OnDisable has ended that loop: it has closed the outbox itself, and the
        /// outbox may already drain into the next loop's session.
        /// </summary>
        internal void CloseOutbox(CancellationToken token)
        {
            lock (_outboxLock)
            {
                if (!token.IsCancellationRequested)
                    CloseOutbox();
            }
        }

        /// <summary>
        /// Blocks until everything in the outbox has been written to the current session's socket,
        /// the session has ended or <paramref name="timeoutMs"/> has passed, whichever comes
        /// first. Returns at once while not connected.
        /// </summary>
        /// <returns>True if the outbox is empty.</returns>
        /// <remarks>
        /// Safe to call from the main thread: the drainer never needs it, since every await on the
        /// way to the socket is ConfigureAwait(false).
        /// </remarks>
        private bool WaitForOutboxToDrain(int timeoutMs)
        {
            var clock = System.Diagnostics.Stopwatch.StartNew();
            lock (_outboxLock)
            {
                // Woken by the drainer after each message it has written, and when the session ends.
                while (_outbox.Count > 0 && _outboxSession != null)
                {
                    var remaining = timeoutMs - clock.ElapsedMilliseconds;
                    if (remaining <= 0)
                        break;

                    Monitor.Wait(_outboxLock, (int)remaining);
                }

                return _outbox.Count == 0;
            }
        }

        /// <summary>
        /// The server refused this client: everything still queued is dropped, and so is every later send as it
        /// is made. Nothing will connect again, so waiting would leave every <see cref="SendCommandAsync"/>
        /// pending for good.
        /// Does nothing once OnDisable has ended the loop that <paramref name="token"/> belongs to: enabling the
        /// component again is a deliberate retry, and the next loop's sends are not refused.
        /// </summary>
        private void RefuseSends(CancellationToken token)
        {
            Outgoing[] dropped;
            lock (_outboxLock)
            {
                // Checked under the lock that OnEnable lifts a refusal under.
                if (token.IsCancellationRequested)
                    return;

                _isRefused = true;
                dropped = TakeEverythingQueued();
            }

            foreach (var message in dropped)
                message.Sent?.TrySetResult(false);
        }

        // Under _outboxLock.
        private Outgoing[] TakeEverythingQueued()
        {
            var taken = new Outgoing[_outbox.Count];
            _outbox.CopyTo(taken, 0);
            _outbox.Clear();
            _queuedModelUpdates.Clear();
            _droppableCount = 0;
            return taken;
        }

        // Under _outboxLock. Every removal from the outbox goes through here, so the count and the
        // index of queued model updates stay true to what is in it.
        private void RemoveFromOutbox(LinkedListNode<Outgoing> node)
        {
            _outbox.Remove(node);

            var message = node.Value;
            if (message.CanDrop)
                _droppableCount--;

            if (message.ModelUpdate != null
                && _queuedModelUpdates.TryGetValue(message.ModelKey, out var indexed)
                && ReferenceEquals(indexed, node))
            {
                _queuedModelUpdates.Remove(message.ModelKey);
            }
        }

        private void Post(string channel, string command, JToken payload, byte[] frame, TaskCompletionSource<bool> sent)
        {
            List<Outgoing> dropped = null;
            var warnAboutDrops = false;
            var warnAboutOutboxLimit = false;
            var startDraining = false;
            var refused = false;
            var warnAboutRefusal = false;

            lock (_outboxLock)
            {
                if (_isRefused)
                {
                    refused = true;
                    warnAboutRefusal = !_hasWarnedAboutRefusal;
                    _hasWarnedAboutRefusal = true;
                }
                else if (_outboxSession == null)
                {
                    Queue(channel, command, payload, frame, sent);

                    while (_droppableCount > MAX_QUEUED_MESSAGES)
                    {
                        var oldest = _outbox.First;
                        while (!oldest.Value.CanDrop)
                            oldest = oldest.Next;

                        (dropped ??= new List<Outgoing>()).Add(oldest.Value);
                        RemoveFromOutbox(oldest);
                    }

                    if (dropped != null && !_hasWarnedAboutDrops)
                    {
                        _hasWarnedAboutDrops = true;
                        warnAboutDrops = true;
                    }
                }
                else
                {
                    _outbox.AddLast(new Outgoing { Frame = frame, Sent = sent, CanDrop = ModelCommands.IsDroppable(command) });
                    if (ModelCommands.IsDroppable(command))
                        _droppableCount++;

                    if (!_isDraining)
                    {
                        _isDraining = true;
                        startDraining = true;
                    }
                }

                if (!refused && _outbox.Count > MAX_OUTBOX_MESSAGES)
                {
                    EnforceOutboxLimit(ref dropped);

                    warnAboutOutboxLimit = !_hasWarnedAboutOutboxLimit;
                    _hasWarnedAboutOutboxLimit = true;
                }
            }

            // Logged, and the dropped tasks completed, outside the lock: both can run other code.
            if (refused)
            {
                if (warnAboutRefusal)
                {
                    Debug.LogWarning($"Colibri: not sending {command} on channel '{channel}' - the server refused this client's protocol version, "
                        + "so nothing is sent any more. Every later message is dropped the same way; this is said once.");
                }

                sent?.TrySetResult(false);
                return;
            }

            if (warnAboutDrops)
            {
                Debug.LogWarning($"Colibri: more than {MAX_QUEUED_MESSAGES} messages are waiting for the connection to come back, "
                    + "so the oldest are being dropped. Synchronized model state is kept: it is folded into one update per object instead. "
                    + "Said once per outage.");
            }

            if (warnAboutOutboxLimit)
            {
                Debug.LogWarning($"Colibri: more than {MAX_OUTBOX_MESSAGES} messages are waiting to be sent, so the oldest are being dropped - "
                    + "broadcasts and other messages first, and once there are none of those left, synchronized model state (requests, "
                    + "updates and deletes), which other clients then never see. Said once per connection.");
            }

            if (dropped != null)
            {
                foreach (var message in dropped)
                    message.Sent?.TrySetResult(false);
            }

            // Outside the lock: the drain runs synchronously up to its first write that does not
            // complete at once.
            if (startDraining)
                _ = DrainOutbox();
        }

        // Under _outboxLock. The oldest message that may be dropped goes first, and only when none
        // is left the oldest of the rest. Never the message the drainer is writing at this moment:
        // dropping that one would report as dropped a message that may well arrive.
        private void EnforceOutboxLimit(ref List<Outgoing> dropped)
        {
            while (_outbox.Count > MAX_OUTBOX_MESSAGES)
            {
                var oldest = _isDraining ? _outbox.First.Next : _outbox.First;

                var victim = oldest;
                if (_droppableCount > 0)
                {
                    var droppable = oldest;
                    while (droppable != null && !droppable.Value.CanDrop)
                        droppable = droppable.Next;

                    victim = droppable ?? oldest;
                }

                (dropped ??= new List<Outgoing>()).Add(victim.Value);
                RemoveFromOutbox(victim);
            }
        }

        // Under _outboxLock, while not connected.
        private void Queue(string channel, string command, JToken payload, byte[] frame, TaskCompletionSource<bool> sent)
        {
            // Only what nobody awaits is folded: each awaited task has to complete for its own message.
            if (sent == null && command == ModelCommands.MODEL_UPDATE_COMMAND && ModelCommands.TryGetModelId(payload, out var update, out var id))
            {
                var key = (channel, id);

                // A copy, because the caller's object may change after it was sent.
                var latest = (JObject)update.DeepClone();

                if (_queuedModelUpdates.TryGetValue(key, out var queued))
                {
                    var merged = (JObject)queued.Value.ModelUpdate.DeepClone();
                    foreach (var property in latest.Properties())
                        merged[property.Name] = property.Value;

                    var mergedFrame = PayloadCodec.TryEncodeFrame(channel, command, merged);
                    if (mergedFrame != null)
                    {
                        // To the back of the queue: it now carries the newest change.
                        RemoveFromOutbox(queued);
                        latest = merged;
                        frame = mergedFrame;
                    }
                }

                _queuedModelUpdates[key] = _outbox.AddLast(new Outgoing { Frame = frame, CanDrop = false, ModelUpdate = latest, ModelKey = key });
                return;
            }

            var canDrop = ModelCommands.IsDroppable(command);
            if (!canDrop)
                StopFolding(channel, payload);

            _outbox.AddLast(new Outgoing { Frame = frame, Sent = sent, CanDrop = canDrop });
            if (canDrop)
                _droppableCount++;
        }

        // Under _outboxLock, for a model command that is not folded (an awaited update, a request, a
        // delete). A folded update goes to the back, so the update queued for an object may absorb later
        // ones only while nothing else about it is queued behind: otherwise its older values would
        // overtake a newer update, arrive after a delete and revive the object, or miss a request the
        // server then answers without them.
        private void StopFolding(string channel, JToken payload)
        {
            if (ModelCommands.TryGetModelId(payload, out _, out var id))
            {
                _queuedModelUpdates.Remove((channel, id));
                return;
            }

            // No id: a request for the whole channel, which is about every object on it. (A
            // malformed update or delete ends up here too; ending more folds than needed only
            // costs queue space.)
            List<(string Channel, string Id)> onChannel = null;
            foreach (var key in _queuedModelUpdates.Keys)
            {
                if (key.Channel == channel)
                    (onChannel ??= new List<(string Channel, string Id)>()).Add(key);
            }

            if (onChannel != null)
            {
                foreach (var key in onChannel)
                    _queuedModelUpdates.Remove(key);
            }
        }

        /// <summary>
        /// Writes the outbox to the current session's socket, head first, until it is empty or
        /// the session is gone. Only ever one running (<c>_isDraining</c>), and it reads the session
        /// afresh for every message, so a drainer that outlives one session carries on into the next.
        /// </summary>
        private async Task DrainOutbox()
        {
            while (true)
            {
                LinkedListNode<Outgoing> node;
                Outgoing next;
                ServerSession session;
                CancellationToken token;
                lock (_outboxLock)
                {
                    if (_outboxSession == null || _outbox.Count == 0)
                    {
                        _isDraining = false;
                        return;
                    }

                    node = _outbox.First;
                    next = node.Value;
                    session = _outboxSession;
                    token = _outboxToken;
                }

                try
                {
                    await SendFrame(session, next.Frame, token).ConfigureAwait(false);
                }
                catch (Exception e)
                {
                    // The message stays at the head of the outbox and is the first thing the
                    // next session sends. This session is finished: close it, so the receive loop
                    // notices now rather than at the next heartbeat.
                    lock (_outboxLock)
                    {
                        if (ReferenceEquals(_outboxSession, session))
                        {
                            _outboxSession = null;
                            _outboxToken = CancellationToken.None;
                            Monitor.PulseAll(_outboxLock);
                        }
                    }

                    if (!token.IsCancellationRequested)
                        Debug.Log($"Colibri: sending failed ({e.GetType().Name}: {e.Message}); queued messages will be sent after reconnecting");

                    session.Close();
                    continue;
                }

                lock (_outboxLock)
                {
                    // Gone already if, while it was being written, the session ended and the
                    // outage bound dropped it. (A fold never absorbs it: only updates queued since
                    // the outbox last closed are folded into, and this one was queued before that.)
                    if (node.List == _outbox)
                        RemoveFromOutbox(node);

                    // One message further: see WaitForOutboxToDrain.
                    Monitor.PulseAll(_outboxLock);
                }

                next.Sent?.TrySetResult(true);
            }
        }

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
            Post(channel, command, payload, frame, sent);
            return sent.Task;
        }

        /// <summary>Sends a message, queueing it while not connected. See <see cref="SendCommandAsync"/>.</summary>
        public void SendCommand(string channel, string command, JToken payload)
        {
            var frame = PayloadCodec.EncodeFrame(channel, command, payload);
            if (frame != null)
                Post(channel, command, payload, frame, null);
        }
    }
}
