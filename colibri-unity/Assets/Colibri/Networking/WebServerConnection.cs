using HCIKonstanz.Colibri.Core;
using HCIKonstanz.Colibri.Networking.Protocol;
using HCIKonstanz.Colibri.Setup;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Runtime.ExceptionServices;
using System.Security.Authentication;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;

namespace HCIKonstanz.Colibri.Networking
{
    /// <summary>
    /// <see cref="ConnectionStatus.ProtocolMismatch"/> is terminal: unlike
    /// <see cref="ConnectionStatus.Disconnected"/> it is never followed by another attempt,
    /// because a version mismatch cannot resolve itself.
    /// </summary>
    public enum ConnectionStatus { Connected, Disconnected, Connecting, Reconnecting, ProtocolMismatch };

    /// <summary>
    /// TCP connection to a colibri-server, speaking the v3 binary protocol
    /// (see <see cref="Protocol.FrameCodec"/> and <c>colibri-server/docs/protocol.md</c>).
    ///
    /// Requires colibri-server >= 2.0.0. There is no version negotiation: the server accepts
    /// exactly one protocol version and refuses anything else, so both sides have to be
    /// upgraded together.
    ///
    /// With <see cref="ColibriConfig.IsSSL"/> the connection is TLS: the same frames, inside an
    /// encrypted stream. Which server certificates it accepts is up to
    /// <see cref="ServerCertificatePolicy"/>.
    /// </summary>
    [DefaultExecutionOrder(-100)]
    public class WebServerConnection : SingletonBehaviour<WebServerConnection>
    {
        /// <summary>
        /// Protocol version announced in the handshake. Has to equal <c>PROTOCOL_VERSION</c> in
        /// the server's <c>src/server/modules/networking/protocol.ts</c> and in colibri-web's
        /// <c>src/Colibri.ts</c>; colibri-server's <c>npm run test:vectors</c> checks that all of
        /// them agree. A server speaking anything else refuses the connection with a
        /// <see cref="PROTOCOL_REJECTED_COMMAND"/> message.
        /// </summary>
        private const string CLIENT_VERSION = "2";

        /// <summary>
        /// Channel and command the server refuses a mismatched client on. Handled here rather
        /// than in <c>Sync</c>: it is Colibri's own plumbing, not an application message.
        /// </summary>
        private const string COLIBRI_CHANNEL = "colibri";
        private const string PROTOCOL_REJECTED_COMMAND = "protocol::rejected";

        /// <summary>
        /// A server on a genuinely different framing cannot be told anything - it cannot decode
        /// our frames and we cannot decode its. What that looks like from here is a session that
        /// faults before a single frame is read, over and over. After this many in a row, say so:
        /// the alternative is an infinite reconnect loop whose log gives no hint of the cause.
        /// The same number of unanswered sessions in a row (see CountSessionWithoutAFrame) gets a
        /// hint of its own.
        /// </summary>
        private const int EARLY_FRAME_FAILURES_BEFORE_HINT = 3;

        /// <summary>
        /// The server heartbeats every 100 ms, so silence for this long means the connection
        /// is gone even if the socket has not noticed yet.
        /// </summary>
        private const long HEARTBEAT_TIMEOUT_THRESHOLD_MS = 2000;

        private const int RECEIVE_BUFFER_SIZE = 64 * 1024;
        private const int RECONNECT_DELAY_MIN_MS = 500;
        private const int RECONNECT_DELAY_MAX_MS = 10 * 1000;

        /// <summary>
        /// How long one attempt to open the TCP connection may take before it is given up and
        /// retried after the usual backoff. The socket has no timeout of its own: an address that
        /// nothing answers on - a server switched off on another subnet, a mistyped IP - used to
        /// hold the attempt in Connecting for the OS's own SYN timeout, about two minutes on
        /// Android, without a retry or a word in the log. On a local network a connection opens in
        /// milliseconds; 5 s still leaves room for two lost SYNs on bad Wi-Fi. With TLS the
        /// handshake has to finish within the same time: a server without TLS may never answer it.
        /// So do looking up the server's name and trying each of its addresses (see
        /// <see cref="ConnectAnyAsync"/>). A placed body waits as long for a server before it is
        /// simulated without the server's state (see Sync.StopsWaitingForServer).
        /// </summary>
        internal const int CONNECT_TIMEOUT_MS = 5000;

        /// <summary>
        /// The least time an attempt on one of several addresses gets. A server name can resolve to
        /// several addresses, typically an IPv4 and an IPv6 one, and they are tried one after the
        /// other, each with an equal share of the time left, so that one nothing answers on (behind
        /// a firewall that drops the connection, say) holds up the attempt only for its share. A
        /// path that works answers a connection well within a second, so a name with many addresses
        /// gets this much per address rather than shares too short to answer in.
        /// </summary>
        private const int MIN_ADDRESS_ATTEMPT_MS = 1000;

        /// <summary>
        /// The most time an attempt on a loopback address gets while other addresses are still to
        /// be tried. Loopback accepts or refuses a connection at once, except that Windows takes a
        /// second or more to report a refusal. "localhost" resolves to 127.0.0.1 and ::1, which is
        /// tried second (see <see cref="AddressesToTry"/>), so without this a connection to localhost
        /// would wait out that refusal every time against a server on ::1 only (TCP_HOST ::1).
        /// </summary>
        private const int LOOPBACK_ATTEMPT_MS = 250;

        /// <summary>
        /// How often a connect in progress looks whether its socket has been closed, which on Mono
        /// it does not notice by itself. See <see cref="WaitForConnectAsync"/>.
        /// </summary>
        private const int CLOSED_SOCKET_CHECK_MS = 100;

        /// <summary>
        /// How many broadcasts and other messages that are not model state may wait for the
        /// connection while it is down. This is a last-write-wins sync client: growing the queue
        /// without limit during a long outage would only buffer updates that are already
        /// superseded, so past this the oldest are dropped. Model messages are not dropped here; see
        /// "The outbox" below for why, and for what bounds them instead.
        /// </summary>
        private const int MAX_QUEUED_MESSAGES = 256;

        /// <summary>
        /// How many messages the outbox may hold in all, model state included - the backstop behind
        /// <see cref="MAX_QUEUED_MESSAGES"/>, which only counts what may be dropped. A model::request,
        /// a model::delete and a model::update that cannot be folded (one someone awaits, or one with
        /// something else about its object queued in between) are not counted there, so an outage in
        /// which objects keep being created and destroyed used to queue them without limit; so did a
        /// connection whose writes fall behind what is sent. Past this many the oldest messages that
        /// may be dropped go first, and only then the oldest model messages: a loss nothing repairs,
        /// but a bounded one.
        /// </summary>
        private const int MAX_OUTBOX_MESSAGES = 10000;

        /// <summary>
        /// How many received messages may wait for <see cref="Update"/> before the queue starts
        /// folding model updates. The receive thread keeps reading while Update does not run - a
        /// Quest paused with the headset off, an Editor in the background without Run In
        /// Background - so that the server does not time the client out, and every message it read
        /// used to be queued without limit and delivered all at once when Update ran again. Past
        /// this many, a model::update is folded into the one queued for the same object, newer
        /// fields winning, as the outbox does during an outage: the object ends up in the same
        /// state, and model state is bounded by the number of objects rather than by how long
        /// Update did not run. A frame normally hands over far fewer, so ordinary delivery is not
        /// affected; a listener that records every update sees only the newest state of each object
        /// for the stretch that Update did not run.
        /// </summary>
        private const int RECEIVED_FOLDING_THRESHOLD = 1000;

        /// <summary>
        /// How many received messages may wait for <see cref="Update"/> in all - the backstop behind
        /// <see cref="RECEIVED_FOLDING_THRESHOLD"/>, as <see cref="MAX_OUTBOX_MESSAGES"/> is for the
        /// outbox. Past it the oldest broadcasts and other messages that are not model state are
        /// dropped first, and only when none are left the oldest model messages.
        /// </summary>
        private const int MAX_RECEIVED_MESSAGES = 10000;

        /// <summary>
        /// How long the end of Play mode, or quitting the app, waits for what is still in the outbox
        /// to be written to the socket before it is closed. The app is closing, so the wait is
        /// short: on a working connection, writing what is queued then - the updates the send-rate
        /// limit was holding, flushed by SyncTicker - only hands a few frames to the operating
        /// system.
        /// </summary>
        private const int QUIT_DRAIN_TIMEOUT_MS = 100;

        /// <summary>
        /// ClientLogger (<c>client-logger.ts</c>) reads this channel's payload with
        /// <c>asString()</c>, so it is the one channel that ships raw text instead of JSON -
        /// quoting it would put stray quotes in the admin UI's log page.
        /// </summary>
        private const string LOG_CHANNEL = "log";

        private static readonly Encoding Utf8 = new UTF8Encoding(false, false);

        public delegate void MessageAction(string channel, string command, JToken payload);
        public event MessageAction OnMessageReceived;

        /// <summary>
        /// Raised on the main thread once the server has started talking to this client - its
        /// first frame, not merely an accepted TCP connection. Something that accepts and then
        /// says nothing, or speaks a framing this client cannot read, never raises it.
        /// </summary>
        /// <remarks>
        /// Both events are raised from <c>Update</c>, once per connection and in the order things
        /// happened, so the last one raised always tells the truth: a connection that drops and
        /// comes back between two frames - a long frame during a Wi-Fi blip - raises
        /// <see cref="OnDisconnected"/> and then <see cref="OnConnected"/> in the next frame.
        /// Disabling or destroying this component raises what is still due there and then, from
        /// <c>OnDisable</c>, so a connection open at that moment ends with its
        /// <see cref="OnDisconnected"/> too - or, when a handler of one of these events is what
        /// disabled it, right after that event has reached every handler. The one exception is
        /// the end of Play mode or of the app, which raises neither: the objects the handlers
        /// belong to may already be gone.
        /// </remarks>
        public event Action OnConnected;

        /// <summary>
        /// Raised on the main thread once for every <see cref="OnConnected"/>, after it, when that
        /// connection ends - dropped, timed out, refused by the server, or closed by disabling or
        /// destroying this component (see <see cref="OnConnected"/> for the one exception). An
        /// attempt that never got as far as Connected raises neither event. That includes a server
        /// that refuses this client in its very first frame: it is reported by
        /// <see cref="Status"/> becoming <see cref="ConnectionStatus.ProtocolMismatch"/> and by
        /// <see cref="Connected"/> being cancelled.
        /// </summary>
        public event Action OnDisconnected;

        // Instance, not static: static state survives Enter Play Mode with domain reload
        // disabled and would leave a second play session talking to a dead socket.
        //
        // Main thread only: the loop the last OnEnable started, until OnDisable ends it.
        private ConnectionLoop _loop;

        /// <summary>
        /// One run of the connection loop, from the OnEnable that starts it to the OnDisable that
        /// ends it, and what belongs to that run alone.
        /// </summary>
        /// <remarks>
        /// A disable and enable in one frame starts the next run while the last one is still
        /// unwinding on a worker thread. Its cleanup used to work on the component's fields, which
        /// by then were the next run's: it closed the new socket in the middle of its connect,
        /// disarmed its watchdog, and could close the outbox and set Disconnected under a session
        /// that was already Connected. A run keeps its socket and watchdog here instead. What the
        /// component shares - <see cref="Status"/>, the outbox and what is reported about the
        /// connection - a run changes only while its token is not cancelled, checked under the lock
        /// that guards it. OnDisable cancels the token before it sets all of that itself, so a run
        /// it has ended changes none of it, however late it unwinds.
        /// </remarks>
        private sealed class ConnectionLoop
        {
            public readonly CancellationTokenSource Lifetime = new CancellationTokenSource();

            // Taken once: the source's Token throws after OnDisable has disposed it, and the run
            // may still be unwinding then.
            public readonly CancellationToken Token;

            // The socket of the attempt or session in progress, or null between two. Closing it is
            // what ends a session, TLS or not. Set and cleared by the run; read by Update()'s
            // heartbeat watchdog and by OnDisable. The send path uses _outboxSession instead.
            public volatile Socket Socket;

            // Set as soon as the TCP connection is accepted, cleared when the session ends or the
            // watchdog in Update() fires. Covers the stretch before the first frame too: something
            // that accepts the connection and then never says a word would otherwise hold a session
            // in Connecting forever, now that Connected waits for the server to speak.
            public volatile bool IsWatchdogArmed;

            // Session-scoped: set once the TCP connection is up and this client has sent its
            // handshake. Without it, a session that never got that far - "connection refused"
            // because the server simply is not running - would count towards the framing hint and
            // have this client blaming a version mismatch for a server that is switched off.
            public volatile bool ReachedHandshake;

            // Session-scoped: set once the session has decoded anything at all. Only a session that
            // ends *before* this is set counts towards the framing hint.
            public volatile bool DecodedAnyFrame;

            // Session-scoped: set by the watchdog in Update() when it drops a session the server has
            // not sent a frame on. Such a session counts towards a hint of its own, not the framing
            // hint: neither a 1.x server nor one with TLS on stays silent.
            public volatile bool EndedSilent;

            // Session-scoped: set by the watchdog in Update() when it drops the session, connected
            // or not, before it closes the socket. The watchdog has said why, so the read or write
            // that fails on the closed socket is not logged as a failed connection as well.
            public volatile bool DroppedByWatchdog;

            // Session-scoped: set when the session ended on a frame this client could not decode,
            // the way every session with a 1.x server ends. With TLS, the only kind of session
            // without a frame that counts towards the framing hint; see CountSessionWithoutAFrame.
            public volatile bool EndedOnBadFrame;

            // The run itself: completes once it has ended and cleaned up after its last session.
            public Task Run;

            public ConnectionLoop()
            {
                Token = Lifetime.Token;
            }
        }

        /// <remarks>Internal for the tests, which shrink its send buffer to stand in for a slow link.</remarks>
        internal Socket CurrentSocket => _loop?.Socket;

        /// <summary>
        /// The connection loop the last OnEnable started, until OnDisable ends it. Completes once the
        /// loop has cleaned up after its last session.
        /// </summary>
        /// <remarks>Internal for the tests, which wait for an ended loop to finish its cleanup.</remarks>
        internal Task CurrentLoop => _loop?.Run;

        /// <summary>
        /// Awaited by a connection loop when a session has ended, before it cleans up after it. Null
        /// outside the tests.
        /// </summary>
        /// <remarks>
        /// Internal for the tests, which hold a loop that OnDisable has ended there until the next
        /// loop's session is Connected. On its own it unwinds within milliseconds, long before that,
        /// so a cleanup that changed the next session's status or outbox would go unnoticed.
        /// </remarks>
        internal volatile Func<Task> BeforeSessionCleanup;

        private string _hostname = "";

        // Serializes every write to the socket - the outbox's messages and the receive loop's
        // heartbeat echoes. Concurrent writes used to interleave their bytes and corrupt the
        // framing for everything that followed, and an SslStream takes only one write at a time.
        // The receive loop never waits for it: see EchoHeartbeat.
        private readonly SemaphoreSlim _sendLock = new SemaphoreSlim(1, 1);

        /// <remarks>Internal for the tests, which hold it to stand in for a slow write.</remarks>
        internal SemaphoreSlim SendLock => _sendLock;

        // The newest heartbeat echo not written yet, with the session it answers, or null. Set by
        // the receive loop, taken by whoever holds _sendLock. See EchoHeartbeat.
        private PendingEcho _pendingEcho;

        private sealed class PendingEcho
        {
            public Session Session;
            public byte[] Frame;
        }

        /// <summary>
        /// One connection to the server: its socket, and the stream every frame is read from and
        /// written to - the socket's own <see cref="NetworkStream"/>, or with TLS an
        /// <see cref="SslStream"/> over it. Closing the socket is what ends a session: it fails
        /// whatever is reading or writing at that moment, encrypted or not.
        /// </summary>
        internal sealed class Session
        {
            public readonly Socket Socket;
            public readonly Stream Stream;

            // The server address the socket is connected to, for the log; null in the tests' sessions.
            public readonly IPAddress Address;

            public Session(Socket socket, Stream stream, IPAddress address = null)
            {
                Socket = socket;
                Stream = stream;
                Address = address;
            }

            /// <summary>A session without TLS on a connected socket. For the EditMode tests.</summary>
            internal static Session Plain(Socket socket) => new Session(socket, new NetworkStream(socket, false));

            public void Close() => CloseSocket(Socket);
        }

        // Every outgoing message, in the order it was sent, until it has been written to a socket.
        // See "The outbox" below. Everything from here to _hasWarnedAboutRefusal is under _outboxLock:
        // senders on any thread, the drainer on the thread pool and the connection loop all touch it.
        private readonly LinkedList<Outgoing> _outbox = new LinkedList<Outgoing>();
        private readonly object _outboxLock = new object();

        // The session the outbox currently drains into, and its token. Null while not connected,
        // which is what makes a send wait in the outbox.
        private Session _outboxSession;
        private CancellationToken _outboxToken;

        // True while a DrainOutbox() is running. There is never more than one, which is what keeps
        // the messages in order.
        private bool _isDraining;

        // Reset on every connection, so a drop is reported once per outage.
        private bool _hasWarnedAboutDrops;
        private bool _hasWarnedAboutOutboxLimit;

        // Set when the server refuses this client's protocol version. Nothing will ever be sent
        // again, so a send completes at once, as dropped, instead of waiting in the outbox.
        private bool _isRefused;
        private bool _hasWarnedAboutRefusal;

        // Receive loop in, main thread out. Everything from here to _hasWarnedAboutReceivedBacklog
        // is under _queuedCommandsLock. See EnqueueReceived for how the queue is bounded.
        private readonly LinkedList<InPacket> _queuedCommands = new LinkedList<InPacket>();
        private readonly object _queuedCommandsLock = new object();

        // While a backlog lasts - from RECEIVED_FOLDING_THRESHOLD messages until Update has taken
        // them - the model::update queued for each object that later ones can still be folded into:
        // one that nothing else about the object has been queued behind.
        private readonly Dictionary<(string Channel, string Id), LinkedListNode<InPacket>> _queuedReceivedUpdates
            = new Dictionary<(string Channel, string Id), LinkedListNode<InPacket>>();
        private bool _isReceivedBacklog;
        private int _droppableReceivedCount;
        private int _foldedReceivedCount;
        private int _droppedReceivedCount;

        // Reset on every connection, so a backlog is reported once per connection.
        private bool _hasWarnedAboutReceivedBacklog;

        // Main thread only: what one DeliverReceivedMessages hands out, reused from frame to frame.
        private readonly List<InPacket> _delivering = new List<InPacket>();

        private long _lastHeartbeatTime;
        private long _livenessStamps;

        // Main thread only: the OnMessageReceived delegate last delivered to, and its handlers.
        private MessageAction _deliveringTo;
        private Delegate[] _deliveringToList;

        // Both touched from the connection loop and from Update() via the Status setter, so
        // every access to them is under _statusLock.
        private int _connectAttempts;
        private int _connectedSessions;

        /// <summary>
        /// How many times this connection has become <see cref="ConnectionStatus.Connected"/> -
        /// so 2 or more in an <see cref="OnConnected"/> handler means it is a reconnect.
        /// </summary>
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

        // Connection loop only: the TLS failure last logged as an error, so that a server that
        // keeps failing the same way says so once rather than at every attempt. Cleared by a
        // connection, and by enabling the component.
        private string _reportedTlsFailure;

        // Cleared by enabling the component: a certificate accepted only because self-signed ones
        // are allowed is said once per session, not at every reconnect.
        private volatile bool _hasWarnedAboutUntrustedCertificate;

        // ColibriConfig.Load() goes through Resources.Load, which is main-thread only, so the
        // connection loop reads this snapshot instead of the ScriptableObject.
        private volatile string _serverAddress;
        private volatile string _appName;
        private volatile int _tcpPort;
        private volatile bool _useTls;
        private volatile bool _allowSelfSignedCertificate;
        private volatile string _serverCertificateSha256;

        // Set by each TLS handshake, for the Status window: the certificate the server presented,
        // and how it was accepted. Null until a TLS connection has been made.
        private volatile string _presentedCertificateSha256;
        private volatile string _certificateAcceptance;

        // Gate that `await Connected` waits on, replacing the UniRx IObservable<bool> awaiter.
        // Only user code awaits it now - the send path queues in the outbox instead of waiting
        // here. Deliberately a TaskCompletionSource and not a UniTaskCompletionSource: any number
        // of callers may await it at once, and a UniTaskCompletionSource throws "can not await
        // twice" on the second pending awaiter.
        //
        // volatile because the gate is re-armed on the connection loop's thread while code on
        // any other thread may be reading it to await.
        private volatile TaskCompletionSource<bool> _connectedGate = NewGate();
        private volatile bool _isGateOpen;

        /// <summary>
        /// Completes when <see cref="Status"/> becomes <see cref="ConnectionStatus.Connected"/>,
        /// i.e. once the server has sent its first frame. While disconnected it is a fresh, pending
        /// task again. Cancelled when this component is disabled, and when the server refuses this
        /// client's protocol version: that is final, so awaiting it would otherwise never return.
        /// </summary>
        public Task Connected => _connectedGate.Task;

        private static TaskCompletionSource<bool> NewGate()
            => new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

        // OnConnected (true) and OnDisconnected (false) still to be raised on the main thread, in
        // the order the transitions happened: they are queued under _statusLock, by the Status
        // setter. They used to be two flags, raised connected-first, so a connection that dropped
        // and came back before the next Update raised OnConnected and then OnDisconnected, and
        // left user code believing it was disconnected while it was connected.
        private readonly ConcurrentQueue<bool> _connectionEvents = new ConcurrentQueue<bool>();

        // Set while RaiseConnectionEvents is running, on the main thread only. A handler that
        // disables or destroys this component runs OnDisable inside that loop; see there.
        private bool _isRaisingConnectionEvents;

        /// <summary>
        /// Smoothed rate at which <see cref="Update"/> runs, which is the rate at which received
        /// messages are handed to user code. Zero until the first few frames have been measured.
        /// </summary>
        /// <remarks>
        /// Not a diagnostic of the network. Once the socket is off the main thread the remaining
        /// delivery delay is entirely the local frame time, and an Editor in the background is
        /// throttled hard enough for that to be the dominant term - which looks exactly like a
        /// slow connection unless something says otherwise.
        /// </remarks>
        public float DeliveryFramesPerSecond => _smoothedDeltaTime > 0f ? 1f / _smoothedDeltaTime : 0f;

        private float _smoothedDeltaTime;

        /// <summary>
        /// Thread the receive loop last ran on, or 0 before the first receive. Exists so the test
        /// suite can assert the loop is not on the main thread; nothing in the library reads it.
        /// </summary>
        internal int ReceiveThreadId => _receiveThreadId;
        private volatile int _receiveThreadId;

        private volatile ConnectionStatus _status = ConnectionStatus.Disconnected;

        // Written by the receive loop off the main thread, read by the Editor status window and
        // by user code on the main thread.
        private volatile string _serverVersion;
        private volatile string _protocolMismatchReason;

        // Connection loop only (the receive loop is part of it), except for the test accessor.
        private int _consecutiveEarlyFrameFailures;
        private int _consecutiveUnansweredSessions;
        private volatile string _suspectedProtocolMismatch;

        // Whether the current session uses TLS, read from the configuration when it started.
        // Written by the connection loop under _statusLock, read by UsesTls on any thread.
        private volatile bool _sessionUsesTls;

        // The setter is a read-modify-write over several fields, and the connection loop and
        // Update()'s heartbeat watchdog can both reach it at the same time. Interleaved, the two
        // can lose a transition - the watchdog's Disconnected landing between the loop's compare
        // and its assignment leaves the gate open on a socket that is already closed. A loop sets
        // it through TrySetStatus, which checks under this lock that the loop has not been ended.
        private readonly object _statusLock = new object();

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

                        // The gate is created with RunContinuationsAsynchronously, so no awaiting
                        // caller resumes inline here and none of them runs while holding the lock.
                        _connectedGate.TrySetResult(true);
                    }
                    else if (_isGateOpen)
                    {
                        // Re-arm the gate so that `await Connected` while disconnected waits for
                        // the next successful connection.
                        _isGateOpen = false;
                        _connectedGate = NewGate();
                    }

                    // Final: there will be no next connection to wait for.
                    if (_status == ConnectionStatus.ProtocolMismatch)
                        _connectedGate.TrySetCanceled();

                    // One OnDisconnected per OnConnected, whatever ended the connection - a
                    // refusal included. It used to be raised for every failed attempt, connected
                    // or not, and never for a refusal at all.
                    if (wasConnected)
                        _connectionEvents.Enqueue(false);
                }
            }
        }

        /// <summary>
        /// Sets <see cref="Status"/> for the connection loop that <paramref name="token"/> belongs
        /// to, unless OnDisable has ended that loop: the status is then OnDisable's, and the next
        /// loop's. Checked under the lock the setter takes, so that OnDisable, which cancels the
        /// token before it sets Disconnected, always has the last word.
        /// </summary>
        /// <returns>False if the loop has been ended.</returns>
        /// <remarks>Internal for the EditMode tests.</remarks>
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

            // Whether the bound on the receive queue drops it before any model message: false for
            // the model commands, as in the outbox.
            public bool CanDrop;
        }


        private void OnEnable()
        {
            DontDestroyOnLoad(this);

            // Can only be read from the main thread.
            _hostname = SanitizeHandshakeField(SystemInfo.deviceName);
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
            // Never null - an unconfigured project gets the defaults, and the empty app name is
            // what RunConnectionLoop reports and waits on.
            var config = ColibriConfig.Load();

            _serverAddress = config.ServerAddress;
            _appName = config.AppName;
            _tcpPort = config.TcpServerPort;
            _useTls = config.IsSSL;
            _allowSelfSignedCertificate = config.AllowSelfSignedCertificate;
            _serverCertificateSha256 = config.ServerCertificateSha256;
        }

        private void OnDisable()
        {
            // Play mode ending, or the app quitting: SyncTicker has just handed over what the
            // send-rate limit was holding, and on Mono and IL2CPP a socket write completes a moment
            // later on a worker thread. Closing the socket straight away could lose it. An ordinary
            // disable does not wait: whatever is queued stays queued for the next enable.
            if (SingletonLifetime.IsQuitting)
                WaitForOutboxToDrain(QUIT_DRAIN_TIMEOUT_MS);

            // Cancelled before anything below: from here on the loop leaves the status and the
            // outbox alone, however late it unwinds (see ConnectionLoop).
            var loop = _loop;
            _loop = null;
            if (loop != null)
            {
                loop.Lifetime.Cancel();
                loop.Lifetime.Dispose();
                CloseSocket(loop.Socket);
            }

            // Whatever is still queued stays queued: re-enabling the component sends it.
            CloseOutbox();

            // In this order: leaving Connected re-arms the gate with a fresh task, and that is
            // the one an `await Connected` from now on would otherwise wait on forever - OnEnable
            // replaces it rather than completing it.
            Status = ConnectionStatus.Disconnected;
            _connectedGate.TrySetCanceled();

            // A disabled or destroyed component gets no Update to raise them from, so the
            // OnDisconnected of a connection open until now was never raised - or, after a
            // re-enable, raised late. Not at the end of Play mode or of the app: teardown has no
            // order, and a handler would as likely run on an object destroyed a moment ago. When
            // one of these handlers is what disabled it, this returns at once, and the loop that
            // called the handler raises OnDisconnected after it.
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
                CloseSocket(loop.Socket);
            }
        }

        /// <summary>Raises OnConnected and OnDisconnected for every transition still due, in order.</summary>
        private void RaiseConnectionEvents()
        {
            // A handler that disables or destroys this component calls back in here from
            // OnDisable. Raising OnDisconnected there and then would reach the handlers after it
            // before the OnConnected being raised does, and they would be left believing they are
            // connected. The loop below raises it instead, once every handler has had OnConnected.
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
        /// Calls each handler on its own. One that throws would otherwise skip the handlers after
        /// it - Sync's re-request of the models after a reconnect among them - and the rest of
        /// this frame's Update: the received messages and the heartbeat watchdog.
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
        /// Hands a received message to the main thread, where <see cref="Update"/> delivers it.
        /// Bounded the way the outbox is, for the stretches Update does not run: past
        /// <see cref="RECEIVED_FOLDING_THRESHOLD"/> waiting messages a model::update is folded into
        /// the one queued for the same object, and past <see cref="MAX_RECEIVED_MESSAGES"/> the
        /// oldest messages are dropped, broadcasts first.
        ///
        /// Not once OnDisable has ended the connection loop that <paramref name="token"/> belongs
        /// to: the next loop's messages may be queued by then, and this one would land behind them.
        /// </summary>
        /// <remarks>
        /// Called from the receive loop; internal so the EditMode tests can queue one too. The
        /// queue owns <paramref name="payload"/> from here on: a fold writes newer fields into it.
        /// </remarks>
        internal void EnqueueReceived(string channel, string command, JToken payload, CancellationToken token = default)
        {
            var canDrop = IsDroppable(command);

            lock (_queuedCommandsLock)
            {
                // Checked under the lock: the next loop starts only after OnDisable has cancelled the
                // token, so whatever it queues is queued after this check could still pass.
                if (token.IsCancellationRequested)
                    return;

                if (!_isReceivedBacklog && _queuedCommands.Count >= RECEIVED_FOLDING_THRESHOLD)
                    _isReceivedBacklog = true;

                if (_isReceivedBacklog && IsFoldableUpdate(command, payload, out var update, out var id))
                {
                    var key = (channel, id);
                    if (_queuedReceivedUpdates.TryGetValue(key, out var queued))
                    {
                        // The queued update is the one parsed off the socket, which nothing else
                        // holds yet. To the back of the queue: it now carries the newest change.
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
                    // Something else about an object - a delete, or a bare { id } that answers a
                    // request - ends the fold for it: an older update folded past it would arrive
                    // after it. See StopFolding, the outbox's counterpart.
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

        /// <summary>A model::update with something in it besides its id, which may be folded.</summary>
        private static bool IsFoldableUpdate(string command, JToken payload, out JObject update, out string id)
        {
            if (command != MODEL_UPDATE_COMMAND || !TryGetModelId(payload, out update, out id))
            {
                update = null;
                id = null;
                return false;
            }

            // A bare { id } is the server's answer to a request for a model it does not hold, which
            // SyncBehaviour acts on as such. Folded into an update with members, it would be lost.
            return update.Count > 1;
        }

        // Under _queuedCommandsLock.
        private void StopFoldingReceived(string channel, JToken payload)
        {
            if (TryGetModelId(payload, out _, out var id))
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
                && TryGetModelId(packet.Payload, out _, out var id)
                && _queuedReceivedUpdates.TryGetValue((packet.Channel, id), out var indexed)
                && ReferenceEquals(indexed, victim))
            {
                _queuedReceivedUpdates.Remove((packet.Channel, id));
            }
        }

        /// <summary>
        /// Delivers everything received since the last frame. Handlers run on the main thread to
        /// keep threading issues out of user code, and one at a time: a handler that throws used to
        /// take the remaining handlers of that message down with it, and push every message queued
        /// behind it to the next frame.
        /// </summary>
        /// <remarks>Internal so the EditMode tests can drive it without a player loop.</remarks>
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

            // A multicast delegate is immutable, so its invocation list only needs fetching
            // again when someone has subscribed or unsubscribed since.
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

        /// <summary>
        /// Measured here rather than anywhere else because this is the very method that drains
        /// <c>_queuedCommands</c>: it reports the rate messages are actually delivered at, not
        /// something adjacent to it.
        /// </summary>
        private void TrackDeliveryRate()
        {
            // unscaledDeltaTime, so a paused or slowed timeScale is not read as a stalled client.
            var delta = Time.unscaledDeltaTime;

            // Exponential moving average: a single long frame should show up, but not make the
            // readout jump around so much that it cannot be read.
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
         *  This loop is started from OnEnable, i.e. on the main thread, so without it the first
         *  await captures Unity's SynchronizationContext and every continuation in the chain -
         *  connect, receive, heartbeat echo, send - is posted back to the main thread and pumped
         *  once per frame. Inbound bytes then sit in the kernel buffer until the next frame, the
         *  heartbeat echo costs two more frame-pumps *inside* the receive loop, and StampLiveness
         *  only runs when the main thread runs.
         *
         *  An unfocused Editor throttles its player loop, so that one cause produced both halves
         *  of the reported symptom: sync that visibly lagged between two editors side by side,
         *  and missed heartbeats on whichever one was in the background.
         *
         *  The main-thread handoff that user code needs is elsewhere and stays where it is:
         *  received messages go through _queuedCommands and are delivered from Update().
         */

        // One long-lived task per component lifetime, instead of Update() re-entering
        // Connect() every frame while disconnected.
        private async Task RunConnectionLoop(ConnectionLoop loop)
        {
            var token = loop.Token;
            while (!token.IsCancellationRequested)
            {
                var address = _serverAddress;
                var app = _appName;

                // Whitespace counts as nothing, as in ColibriConfig.IsConfigured: an App Name of
                // spaces used to connect, into an app of its own that no other client is in,
                // while the setup and status windows said the project was not configured.
                if (string.IsNullOrWhiteSpace(address) || string.IsNullOrWhiteSpace(app))
                {
                    // Nothing configured (yet) - poll rather than give up, so setting the app
                    // name at runtime still connects. Said once, not twice a second.
                    if (!_hasReportedMissingConfig)
                    {
                        _hasReportedMissingConfig = true;
                        Debug.LogError(ColibriConfig.NOT_CONFIGURED_MESSAGE);
                    }

                    if (!await Delay(RECONNECT_DELAY_MIN_MS, token).ConfigureAwait(false))
                        break;
                    continue;
                }

                _hasReportedMissingConfig = false;

                var handshakeApp = HandshakeAppName(app);
                if (handshakeApp != app && handshakeApp != _reportedSanitizedApp)
                {
                    // Said rather than done quietly: only clients announcing the same app name
                    // see each other, and a web client configured with the original name will not.
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
                    // Ended by OnDisable, which closed the socket under whatever was reading or
                    // writing it. Nothing failed, and nothing is retried: saying "retrying" here
                    // used to read as a failure of the session the next enable had just started.
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
                    // A desynchronized stream cannot be recovered from - there is no delimiter
                    // to resynchronize on - so the connection is dropped and rebuilt.
                    Debug.LogError($"Colibri: invalid frame from server, dropping connection: {e.Message}");
                }
                catch (TimeoutException e)
                {
                    // Nothing refused the connection - nothing answered at all, which is usually
                    // the wrong address, or a device on another network than the server.
                    Debug.Log($"Colibri: {e.Message}. Check the server address, and that this device is on the same network as the server. Retrying...");
                }
                catch (TlsHandshakeException e)
                {
                    ReportTlsFailure(e);
                }
                catch (Exception e) when (loop.DroppedByWatchdog && (e is SocketException || e is IOException))
                {
                    // The watchdog closed the socket under the session and has already said why. The
                    // read that fails on it, with OperationAborted, would only say it again.
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
                    // How a stream reports the socket failing under it: NetworkStream and SslStream
                    // wrap what the socket threw, which is told apart here as it was before the
                    // connection went through a stream.
                    if (FindCause<ObjectDisposedException>(e) == null)
                    {
                        var socketError = FindCause<SocketException>(e);
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
                    CloseSocket(loop.Socket);
                    loop.Socket = null;

                    // However the session ended - a clean hang-up, an undecodable frame, a reset,
                    // the watchdog - except for this component being disabled, which says nothing
                    // about the server.
                    if (!token.IsCancellationRequested)
                        CountSessionWithoutAFrame(loop);

                    // Shared with the next loop, so only while this one has not been ended: OnDisable
                    // has then closed the outbox and set the status itself, and they may already
                    // belong to a session the next enable started.
                    CloseOutbox(token);

                    // Before the status changes, so nothing that reacts to ProtocolMismatch can
                    // still queue a message that would wait for a connection that never comes.
                    if (mismatched)
                        RefuseSends(token);

                    TrySetStatus(mismatched ? ConnectionStatus.ProtocolMismatch : ConnectionStatus.Disconnected, token);
                }

                // Terminal. Retrying cannot make the two sides agree, and a reconnect loop would
                // only bury the one log line that explains what is wrong.
                if (mismatched)
                    break;

                if (token.IsCancellationRequested)
                    break;

                if (!await Delay(NextBackoffDelay(), token).ConfigureAwait(false))
                    break;
            }
        }

        /// <summary>
        /// A server whose framing this client cannot decode also cannot decode ours, so it has
        /// no way to send the explicit refusal. Repeated failures before a single frame is read
        /// are the only symptom that case has, so name the likely cause instead of logging the
        /// same decode error forever.
        ///
        /// This is a suspicion, not a finding: it cannot tell an out-of-date server apart from a
        /// TCP port that is not Colibri at all. So it stays a warning, the connection keeps being
        /// retried, and <see cref="Status"/> is left alone - only a refusal this client actually
        /// decoded is terminal.
        ///
        /// Called once for every session that ends, whatever ended it. The count is reset by the
        /// first frame a session decodes (<see cref="OnFrameDecoded"/>), not here, so "consecutive"
        /// means what it says: it used to be updated only on a clean hang-up or an undecodable
        /// frame, and a session ended by a reset or the watchdog neither counted nor cleared it.
        ///
        /// A session on which nothing came back is counted apart, with a hint of its own: one the
        /// watchdog ended, with no frame in the time it waited, and with TLS one that was closed or
        /// reset without a frame. Neither cause of the framing hint looks like that. A 1.x server
        /// heartbeats from the moment it accepts, through a TLS-terminating proxy too, and its
        /// heartbeat fails to decode at once; a 2.x server with TLS on sends a frame once the TLS
        /// handshake is done. What is left is something that accepts connections and then closes
        /// them or forwards nothing, such as a proxy whose backend is down, or a server that does
        /// not answer. Without TLS, a close cannot be told apart from a server with TLS on hanging
        /// up on this client, so it counts towards the framing hint, which names such a proxy as
        /// well. Each kind of session breaks the other's row.
        /// </summary>
        private void CountSessionWithoutAFrame(ConnectionLoop loop)
        {
            // Never got as far as a connected socket: that is a server that is down, a wrong
            // address or a closed port, and has nothing to say about protocol versions.
            if (!loop.ReachedHandshake)
                return;

            if (loop.DecodedAnyFrame)
                return;

            // Nothing came back: see above.
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

            // Logged before it is published. This runs on the session loop's thread, so whatever
            // polls SuspectedProtocolMismatch on the main thread - the Status window, a test
            // waiting for it - could otherwise act on the value before the line exists.
            Debug.LogError($"Colibri: {suspicion}");
            _suspectedProtocolMismatch = suspicion;
        }

        /// <summary>
        /// The first frame of a session, of any kind - a refusal included - settles that this
        /// server speaks our framing, so it clears the count and the suspicion at once rather than
        /// whenever the session happens to end.
        /// </summary>
        private void OnFrameDecoded(ConnectionLoop loop)
        {
            loop.DecodedAnyFrame = true;
            _consecutiveEarlyFrameFailures = 0;
            _consecutiveUnansweredSessions = 0;
            _suspectedProtocolMismatch = null;
        }

        /// <summary>
        /// How many sessions in a row got past the handshake and then ended without a frame, other
        /// than by the watchdog or, with TLS, by a close or reset. Exists for the test suite;
        /// nothing in the library reads it.
        /// </summary>
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

            Session session;
            try
            {
                // Every address tried gets a socket of its own. The loop holds the one being tried,
                // so that OnDisable, and the cleanup after this session, close it.
                session = await OpenSessionAsync(host, port, certificateCheck, CONNECT_TIMEOUT_MS, socket => loop.Socket = socket, token)
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

            // Closing the socket is what unblocks an in-flight read or write, plain or TLS; there
            // is no cancellation token overload for either on this API surface. Registered on a
            // token that is cancelled already, it closes the socket at once.
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
        /// Opens the TCP connection to <paramref name="host"/> and, with <paramref name="tls"/>, a
        /// TLS session over it, all within <paramref name="timeoutMs"/>: the name lookup, every
        /// address tried and the handshake. The session's stream is the one the v3 frames are read
        /// from and written to, encrypted or not; without TLS it is the socket's own stream.
        /// </summary>
        /// <param name="host">
        /// The configured server address: a name, an IPv4 address, or an IPv6 address with or
        /// without brackets. TLS uses it as it is, for SNI and the certificate check.
        /// </param>
        /// <param name="tls">The certificate check of the handshake, or null for no TLS.</param>
        /// <param name="attempting">
        /// Called with the socket for each address, before it is tried. The sockets stay this
        /// method's: it closes every one but the one it returns, and that one too if it throws.
        /// </param>
        /// <exception cref="TimeoutException">The name did not resolve, or nothing answered the connection, in time, and nothing refused it.</exception>
        /// <exception cref="TlsHandshakeException">The TLS handshake failed or did not finish in time.</exception>
        /// <exception cref="OperationCanceledException"><paramref name="token"/> was cancelled first.</exception>
        /// <exception cref="ObjectDisposedException">A socket was closed while connecting.</exception>
        /// <exception cref="SocketException">
        /// The name does not resolve, or every address failed, one of them refused or all of them
        /// before their time was up, unreachable, say. See <see cref="ConnectAnyAsync"/> for which error.
        /// </exception>
        /// <remarks>Internal for the EditMode tests.</remarks>
        internal static async Task<Session> OpenSessionAsync(string host, int port, ServerCertificateCheck tls, int timeoutMs,
            Action<Socket> attempting, CancellationToken token)
        {
            var clock = System.Diagnostics.Stopwatch.StartNew();
            var addresses = await ResolveAsync(host, timeoutMs, token).ConfigureAwait(false);

            var remaining = (int)Math.Max(0, timeoutMs - clock.ElapsedMilliseconds);
            var (socket, address) = await ConnectAnyAsync(addresses, host, port, remaining, timeoutMs, attempting, token)
                .ConfigureAwait(false);

            try
            {
                // Not owning the socket: closing the socket stays the one way to end a session, and
                // it is closed by whoever ends it.
                var plain = new NetworkStream(socket, false);
                if (tls == null)
                    return new Session(socket, plain, address);

                remaining = (int)Math.Max(0, timeoutMs - clock.ElapsedMilliseconds);
                var encrypted = await AuthenticateAsync(socket, plain, host, port, tls, remaining, timeoutMs, token).ConfigureAwait(false);
                return new Session(socket, encrypted, address);
            }
            catch (Exception)
            {
                CloseSocket(socket);
                throw;
            }
        }

        /// <summary>
        /// The TLS handshake, as a client: SNI and the certificate's name are the configured
        /// server address, and <paramref name="check"/> decides about the certificate. The TLS
        /// versions are the runtime's own default: TLS 1.2 on Unity's TLS backend, 1.2 or 1.3
        /// elsewhere. colibri-server accepts nothing older than 1.2.
        /// </summary>
        private static async Task<Stream> AuthenticateAsync(Socket socket, NetworkStream plain, string host, int port,
            ServerCertificateCheck check, int timeoutMs, int totalTimeoutMs, CancellationToken token)
        {
            var tls = new SslStream(plain, false, check.Validate);
            var handshake = tls.AuthenticateAsClientAsync(host);

            using (var timer = CancellationTokenSource.CreateLinkedTokenSource(token))
            {
                if (await Task.WhenAny(handshake, Task.Delay(timeoutMs, timer.Token)).ConfigureAwait(false) == handshake)
                {
                    timer.Cancel();
                    try
                    {
                        await handshake.ConfigureAwait(false);
                        return tls;
                    }
                    catch (Exception e)
                    {
                        // Nothing else uses the stream yet, so it can go at once.
                        tls.Dispose();
                        token.ThrowIfCancellationRequested();

                        if (check.Rejection != null)
                        {
                            throw new TlsHandshakeException(TlsHandshakeException.Failure.CertificateRejected,
                                $"rejected the certificate of {host}:{port}: {check.Rejection}", e);
                        }

                        throw new TlsHandshakeException(TlsHandshakeException.Failure.NoTlsAnswer,
                            $"{host}:{port} did not answer the TLS handshake ({e.Message})", e);
                    }
                }
            }

            // As with a connect: closing the socket is what abandons the handshake. The stream is
            // let go of once the handshake has failed with it, and its exception observed then -
            // on the thread pool, not inline in the stream's own completion of the handshake.
            CloseSocket(socket);
            _ = handshake.ContinueWith(attempt =>
            {
                _ = attempt.Exception;
                tls.Dispose();
            }, CancellationToken.None, TaskContinuationOptions.None, TaskScheduler.Default);

            token.ThrowIfCancellationRequested();
            throw new TlsHandshakeException(TlsHandshakeException.Failure.NoTlsAnswer,
                $"{host}:{port} accepted the connection but did not answer the TLS handshake within "
                + $"{(totalTimeoutMs / 1000f).ToString("0.#", CultureInfo.InvariantCulture)} s");
        }

        /// <summary>
        /// Lets go of a session's stream once it has ended. An SslStream holds the TLS state, which
        /// closing the socket does not free, so it is disposed, but only once nothing is writing to
        /// it: a write of this session may still be on its way out of the outbox or the heartbeat
        /// echo, and those take the send lock. Not waited for, so that the end of a session never
        /// waits for a write.
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
        /// Keeps what the handshake decided about the server's certificate for the Status window,
        /// and says once per session that one was accepted only because self-signed certificates
        /// are allowed: the connection is encrypted, but nothing has checked whose server it is.
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
        /// Logs a failed TLS handshake: as an error the first time it fails that way, since it
        /// will not go away until a setting changes, and after that only as a note, as a refused
        /// connection is. The connection keeps being retried, so a server that is switched to TLS,
        /// or given another certificate, is picked up without a restart.
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

        /// <summary>The first exception of type <typeparamref name="T"/> in <paramref name="e"/>'s chain of inner exceptions, itself included.</summary>
        private static T FindCause<T>(Exception e) where T : Exception
        {
            for (var cause = e; cause != null; cause = cause.InnerException)
            {
                if (cause is T found)
                    return found;
            }

            return null;
        }

        /*
         *  Finding the server
         *
         *  The socket used to be IPv4 and to connect by name, so a server name with only IPv6
         *  addresses (AAAA records), or an IPv6 address, could not be reached at all. Now the name
         *  is looked up here, and each of its addresses is tried with a socket of its own family.
         */

        /// <summary>
        /// The addresses to try for <paramref name="host"/>, in the order to try them. An IP address
        /// is taken as it is. A name is looked up, and its IPv4 addresses come first, then its IPv6
        /// addresses, each family in the order the platform's resolver gives it (RFC 6724). See
        /// <see cref="AddressesToTry"/> for why.
        /// </summary>
        /// <exception cref="SocketException">The name does not resolve, or resolves to no address.</exception>
        /// <exception cref="TimeoutException">The lookup did not finish within <paramref name="timeoutMs"/>.</exception>
        /// <exception cref="OperationCanceledException"><paramref name="token"/> was cancelled first.</exception>
        internal static Task<IReadOnlyList<IPAddress>> ResolveAsync(string host, int timeoutMs, CancellationToken token)
        {
            if (TryParseAddress(host, out var address))
                return Task.FromResult(AddressesToTry(new[] { address }));

            // The blocking lookup on the thread pool rather than GetHostAddressesAsync: neither can
            // be cancelled on Unity's .NET profile, and this one works the same on Mono and IL2CPP.
            // A lookup that is given up holds its pool thread until the resolver gives up as well.
            return WaitForLookupAsync(Task.Run(() => Dns.GetHostAddresses(host)), host, timeoutMs, token);
        }

        /// <summary>
        /// The rest of <see cref="ResolveAsync"/> for a name: waits for <paramref name="lookup"/>
        /// until it completes, the time is up or <paramref name="token"/> is cancelled.
        /// </summary>
        /// <remarks>Internal for the EditMode tests, which stand in for a slow resolver with a lookup that never completes.</remarks>
        internal static async Task<IReadOnlyList<IPAddress>> WaitForLookupAsync(Task<IPAddress[]> lookup, string host, int timeoutMs, CancellationToken token)
        {
            using (var timer = CancellationTokenSource.CreateLinkedTokenSource(token))
            {
                if (await Task.WhenAny(lookup, Task.Delay(Math.Max(0, timeoutMs), timer.Token)).ConfigureAwait(false) == lookup)
                {
                    timer.Cancel();

                    // Rethrows a lookup that failed by itself: HostNotFound, say.
                    var addresses = AddressesToTry(await lookup.ConfigureAwait(false));
                    if (addresses.Count == 0)
                        throw new SocketException((int)SocketError.HostNotFound);

                    return addresses;
                }
            }

            // Nothing waits for the abandoned lookup any more, so its exception is observed here
            // rather than surfacing as unobserved later.
            _ = lookup.ContinueWith(attempt => { _ = attempt.Exception; }, CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);

            token.ThrowIfCancellationRequested();
            throw new TimeoutException(
                $"{host} could not be resolved within {(timeoutMs / 1000f).ToString("0.#", CultureInfo.InvariantCulture)} s");
        }

        /// <summary>
        /// Whether <paramref name="host"/> is an IP address rather than a name: an IPv4 address, or
        /// an IPv6 address with or without the brackets a URL puts around one ("[2001:db8::1]").
        /// </summary>
        /// <remarks>Internal for VoiceServerConnection and the EditMode tests.</remarks>
        internal static bool TryParseAddress(string host, out IPAddress address)
        {
            address = null;
            if (string.IsNullOrEmpty(host))
                return false;

            if (host.Length > 2 && host[0] == '[' && host[host.Length - 1] == ']')
            {
                // As in a URL, brackets hold an IPv6 address and nothing else.
                if (IPAddress.TryParse(host.Substring(1, host.Length - 2), out var bracketed)
                    && bracketed.AddressFamily == AddressFamily.InterNetworkV6)
                {
                    address = bracketed;
                    return true;
                }

                return false;
            }

            return IPAddress.TryParse(host, out address);
        }

        /// <summary>
        /// Whether the device has a route to <paramref name="address"/>. Connecting a UDP socket
        /// sends nothing: it only looks the route up, and fails at once without one.
        /// </summary>
        /// <remarks>Internal for VoiceServerConnection and the EditMode tests.</remarks>
        internal static bool HasRoute(IPAddress address, int port)
        {
            try
            {
                using (var probe = new Socket(address.AddressFamily, SocketType.Dgram, ProtocolType.Udp))
                {
                    probe.Connect(new IPEndPoint(address, port));
                    return true;
                }
            }
            catch (Exception)
            {
                // NetworkUnreachable, or no sockets of that family on this device or runtime, which
                // a connection or a voice socket would fail on as well.
                return false;
            }
        }

        /// <summary>
        /// What a lookup found, ready to be tried in order: each address once, the IPv4 addresses
        /// first and then the IPv6 addresses, each family in the order found, and an IPv4-mapped
        /// IPv6 address as the IPv4 address it stands for, which an IPv4 socket reaches on every
        /// platform.
        /// </summary>
        /// <remarks>
        /// IPv4 first because voice goes to an IPv4 address whenever the name has one
        /// (VoiceServerConnection.SelectServerAddress), and colibri-server relays voice only from
        /// the source address of a TCP connection of the same app (voice-server.ts, admit). In the
        /// resolver's order, usually IPv6 first, a name with both an A and an AAAA record had TCP
        /// arrive over IPv6 and voice over IPv4, from another address, and every voice packet was
        /// dropped: "localhost" on Windows against a server on TCP_HOST ::, or a Docker host whose
        /// docker-proxy forwards IPv6 TCP from the bridge gateway's address. A name with only IPv6
        /// addresses still connects over IPv6, and voice follows. Internal for the EditMode tests.
        /// </remarks>
        internal static IReadOnlyList<IPAddress> AddressesToTry(IPAddress[] found)
        {
            var addresses = new List<IPAddress>();
            if (found == null)
                return addresses;

            var ipv6 = new List<IPAddress>();
            foreach (var candidate in found)
            {
                var address = candidate.IsIPv4MappedToIPv6 ? candidate.MapToIPv4() : candidate;
                var family = address.AddressFamily == AddressFamily.InterNetwork ? addresses : ipv6;
                if (!family.Contains(address))
                    family.Add(address);
            }

            addresses.AddRange(ipv6);
            return addresses;
        }

        /// <summary>
        /// How long the attempt on one of several addresses may take: an equal share of
        /// <paramref name="remainingMs"/> among <paramref name="attemptsLeft"/> addresses, this one
        /// and those after it that the device has a route to, but at least
        /// <see cref="MIN_ADDRESS_ATTEMPT_MS"/>, and for a loopback address at most
        /// <see cref="LOOPBACK_ATTEMPT_MS"/>. The last address gets all the time left, and no
        /// attempt more than that.
        /// </summary>
        /// <remarks>Internal for the EditMode tests.</remarks>
        internal static int AttemptTimeoutMs(int remainingMs, int attemptsLeft, bool isLoopback)
        {
            if (attemptsLeft <= 1)
                return remainingMs;

            var share = Math.Max(remainingMs / attemptsLeft, MIN_ADDRESS_ATTEMPT_MS);
            if (isLoopback)
                share = Math.Min(share, LOOPBACK_ATTEMPT_MS);

            return Math.Min(share, remainingMs);
        }

        /// <summary>
        /// Connects to the first of <paramref name="addresses"/> that answers. They are tried in
        /// order, each with a socket of its own family and the time <see cref="AttemptTimeoutMs"/>
        /// gives it, and the next is tried at once when one is refused or unreachable. When every
        /// address fails, the error that says the most about the server is reported (see
        /// <see cref="FailureRank"/>), the first of equals.
        /// </summary>
        /// <param name="host">The server address as configured, for the messages.</param>
        /// <param name="timeoutMs">The time all attempts together may take.</param>
        /// <param name="totalTimeoutMs">The time the whole connection had, lookup included, which a timeout names.</param>
        /// <param name="attempting">See <see cref="OpenSessionAsync"/>.</param>
        /// <returns>The connected socket, and the address it is connected to.</returns>
        /// <exception cref="TimeoutException">No address refused, and one did not answer within its time, or no time was left to try one.</exception>
        /// <exception cref="SocketException">Every address failed, and one refused or none went unanswered: the first refusal, or else the first address's error.</exception>
        /// <exception cref="OperationCanceledException"><paramref name="token"/> was cancelled first.</exception>
        /// <exception cref="ObjectDisposedException">A socket was closed while connecting.</exception>
        /// <remarks>Asks <see cref="HasRoute"/> which addresses the device has a route to. Internal for the EditMode tests.</remarks>
        internal static Task<(Socket Socket, IPAddress Address)> ConnectAnyAsync(IReadOnlyList<IPAddress> addresses, string host,
            int port, int timeoutMs, int totalTimeoutMs, Action<Socket> attempting, CancellationToken token)
            => ConnectAnyAsync(addresses, host, port, timeoutMs, totalTimeoutMs, address => HasRoute(address, port), attempting, token);

        /// <summary>
        /// <see cref="ConnectAnyAsync(IReadOnlyList{IPAddress}, string, int, int, int, Action{Socket}, CancellationToken)"/>,
        /// asking <paramref name="hasRoute"/> whether the device has a route to an address.
        /// </summary>
        /// <remarks>Internal for the EditMode tests, which decide which addresses have a route.</remarks>
        internal static async Task<(Socket Socket, IPAddress Address)> ConnectAnyAsync(IReadOnlyList<IPAddress> addresses, string host,
            int port, int timeoutMs, int totalTimeoutMs, Func<IPAddress, bool> hasRoute, Action<Socket> attempting, CancellationToken token)
        {
            var clock = System.Diagnostics.Stopwatch.StartNew();
            var routedAfter = CountRoutedAfter(addresses, hasRoute);
            Exception failure = null;

            for (var i = 0; i < addresses.Count; i++)
            {
                token.ThrowIfCancellationRequested();

                var remaining = timeoutMs - clock.ElapsedMilliseconds;
                if (remaining <= 0)
                    break;

                // Shared only with the addresses after this one that the device has a route to. One
                // without fails at once, as an IPv6 address does on Wi-Fi without IPv6, and counted,
                // it left the IPv4 address before it half of the 5 s, too short for a connection
                // that needs a third SYN.
                var address = addresses[i];
                var attemptMs = AttemptTimeoutMs((int)remaining, 1 + routedAfter[i], IPAddress.IsLoopback(address));

                Socket socket = null;
                var connected = false;
                try
                {
                    // The address's own family: an IPv4 socket cannot reach an IPv6 address.
                    socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
                    attempting?.Invoke(socket);

                    // Registered on a token that is cancelled already, it closes the socket at once.
                    using (token.Register(() => CloseSocket(socket)))
                        await ConnectAsync(socket, address, port, attemptMs, token).ConfigureAwait(false);

                    connected = true;
                    return (socket, address);
                }
                catch (Exception e) when (!(e is ObjectDisposedException) && !token.IsCancellationRequested)
                {
                    // Refused, unreachable, an address family this device has no sockets for, no
                    // answer within this address's share, or anything else a runtime throws for one
                    // address family and not the other: the next address may still answer.
                    // Reported if none does: the error that says the most about the server, the
                    // first of equals.
                    if (failure == null || FailureRank(e) > FailureRank(failure))
                        failure = e;

                    if (i + 1 < addresses.Count && clock.ElapsedMilliseconds < timeoutMs)
                    {
                        var next = Endpoint(addresses[i + 1], port);
                        // Two decimals: a loopback address's 250 ms read as 0.3 s with one. "No connection",
                        // not "no answer": Windows retries a refused connect for about a second, so a
                        // loopback address that refused is given up on before the refusal arrives.
                        Debug.Log(e is TimeoutException
                            ? $"Colibri: no connection to {Endpoint(address, port)} within "
                                + $"{(attemptMs / 1000f).ToString("0.##", CultureInfo.InvariantCulture)} s, trying {next}"
                            : $"Colibri: no connection to {Endpoint(address, port)} "
                                + $"({(e is SocketException refused ? refused.SocketErrorCode.ToString() : e.Message)}), trying {next}");
                    }
                }
                finally
                {
                    if (!connected)
                        CloseSocket(socket);
                }
            }

            token.ThrowIfCancellationRequested();

            // Whether the server refused or did not answer is what tells what is wrong.
            if (failure != null && !(failure is TimeoutException))
                ExceptionDispatchInfo.Capture(failure).Throw();

            // Invariant: this ends up in the log and on screen, and "0,5 s" in one locale and
            // "0.5 s" in another is one more thing to puzzle over.
            throw new TimeoutException(
                $"{host}:{port} did not answer within {(totalTimeoutMs / 1000f).ToString("0.#", CultureInfo.InvariantCulture)} s", failure);
        }

        /// <summary>
        /// For each of <paramref name="addresses"/>, how many of those after it the device has a
        /// route to. Asks <paramref name="hasRoute"/> once about each address but the first, which
        /// comes after none, before any is tried: an address without a route stays in the list, so
        /// that it is still tried and its error can be reported.
        /// </summary>
        private static int[] CountRoutedAfter(IReadOnlyList<IPAddress> addresses, Func<IPAddress, bool> hasRoute)
        {
            var counts = new int[addresses.Count];
            for (var i = addresses.Count - 1; i > 0; i--)
                counts[i - 1] = counts[i] + (hasRoute(addresses[i]) ? 1 : 0);

            return counts;
        }

        /// <summary>
        /// How much a failed attempt says about the server, to choose the error reported when every
        /// address failed. A refusal says the most (the machine is there, nothing listens on the
        /// port), then no answer, then anything else, which is about the path to the server.
        /// </summary>
        /// <remarks>
        /// An IPv6 address tried after IPv4 on a network without IPv6 fails as unreachable, which hid
        /// a refused IPv4 address: a server that was down read as a network without a route. A
        /// refusal beats no answer because Windows reports a refused loopback connection only after
        /// a second or more: with no server running, "localhost" gave up on 127.0.0.1 after its
        /// 0.25 s, ::1 then refused, and the timeout pointed to the address and the network rather
        /// than to starting the server.
        /// </remarks>
        private static int FailureRank(Exception failure)
        {
            if (failure is SocketException refused && refused.SocketErrorCode == SocketError.ConnectionRefused)
                return 2;

            return failure is TimeoutException ? 1 : 0;
        }

        /// <summary>An address as a URL writes it: IPv6 in brackets.</summary>
        private static string HostOf(IPAddress address)
            => address.AddressFamily == AddressFamily.InterNetworkV6 ? $"[{address}]" : address.ToString();

        private static string Endpoint(IPAddress address, int port) => $"{HostOf(address)}:{port}";

        /// <summary>
        /// Opens the TCP connection to one address, or gives up after <paramref name="timeoutMs"/>.
        /// Closing the socket is the only way to abandon a pending connect on this API surface, so
        /// that is what giving up does; the socket cannot be used again afterwards.
        /// </summary>
        /// <exception cref="TimeoutException">Nothing answered in time.</exception>
        /// <exception cref="OperationCanceledException"><paramref name="token"/> was cancelled first.</exception>
        /// <exception cref="ObjectDisposedException">The socket was closed first.</exception>
        /// <exception cref="SocketException">The attempt failed before the time was up, refused, say.</exception>
        /// <remarks>Internal for the EditMode tests, which time it against a port that never answers.</remarks>
        internal static async Task ConnectAsync(Socket socket, IPAddress address, int port, int timeoutMs, CancellationToken token)
        {
            var connecting = socket.ConnectAsync(address, port);
            await WaitForConnectAsync(socket, connecting, HostOf(address), port, timeoutMs, token).ConfigureAwait(false);
        }

        /// <summary>
        /// The rest of <see cref="ConnectAsync"/>: waits for <paramref name="connecting"/>, the
        /// connect in progress on <paramref name="socket"/>, until it completes, the time is up,
        /// <paramref name="token"/> is cancelled or the socket is closed.
        /// </summary>
        /// <remarks>
        /// The socket is looked at every <see cref="CLOSED_SOCKET_CHECK_MS"/> rather than left to
        /// the connect to notice: on Mono a connect whose socket is closed neither completes nor
        /// fails, so an attempt whose socket was closed under it waited out the whole timeout and
        /// then reported a server that may well have answered as not answering. Internal for the
        /// EditMode tests, which stand in for that with a connect that never completes.
        /// </remarks>
        internal static async Task WaitForConnectAsync(Socket socket, Task connecting, string host, int port, int timeoutMs, CancellationToken token)
        {
            var clock = System.Diagnostics.Stopwatch.StartNew();
            var closed = false;

            using (var timer = CancellationTokenSource.CreateLinkedTokenSource(token))
            {
                while (true)
                {
                    var remaining = timeoutMs - clock.ElapsedMilliseconds;
                    if (remaining <= 0)
                        break;

                    await Task.WhenAny(connecting, Task.Delay((int)Math.Min(remaining, CLOSED_SOCKET_CHECK_MS), timer.Token))
                        .ConfigureAwait(false);

                    if (token.IsCancellationRequested)
                        break;

                    if (IsClosed(socket))
                    {
                        closed = true;
                        break;
                    }

                    if (connecting.IsCompleted)
                    {
                        timer.Cancel();

                        // Rethrows a connect that failed by itself.
                        await connecting.ConfigureAwait(false);
                        return;
                    }
                }
            }

            CloseSocket(socket);

            // Nothing waits for the abandoned connect any more. On .NET it now fails with the closed
            // socket, and its exception is observed here rather than surfacing as unobserved later;
            // on Mono it may never complete at all.
            _ = connecting.ContinueWith(attempt => { _ = attempt.Exception; }, CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);

            token.ThrowIfCancellationRequested();
            if (closed)
                throw new ObjectDisposedException(typeof(Socket).FullName, $"The socket was closed while connecting to {host}:{port}.");

            // Invariant: this ends up in the log and on screen, and "0,5 s" in one locale and
            // "0.5 s" in another is one more thing to puzzle over.
            throw new TimeoutException(
                $"{host}:{port} did not answer within {(timeoutMs / 1000f).ToString("0.#", CultureInfo.InvariantCulture)} s");
        }

        /// <summary>
        /// The session is <see cref="ConnectionStatus.Connected"/> from the first frame the server
        /// sends, not from the moment the TCP connection opened. Anything can accept a connection:
        /// a 1.x server does, and then speaks a framing this client cannot read; so does a port
        /// that is not Colibri at all. Counting those as connections reset the reconnect backoff on
        /// every attempt - it never grew past 500 ms - and fired OnConnected, and flushed the queued
        /// messages, into a session that was about to fail. A server that says nothing at all is
        /// dropped by the watchdog in <see cref="Update"/>; the server heartbeats every 100 ms, so
        /// a real one is never kept waiting.
        /// </summary>
        private void BecomeConnected(Session session, string host, int port, string app, CancellationToken token)
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
            var via = session.Address != null && !TryParseAddress(host, out _) ? $" ({session.Address})" : "";

            // The app name is named explicitly: a typo in it produces a perfectly healthy
            // connection on which no other client is ever seen.
            Debug.Log($"Colibri: connected to {host}:{port}{via} as app '{app}'. Only clients using the same App Name can see each other.");

            // Starts sending whatever queued up during the outage, in order. Opened before Status
            // says Connected, so anything sent by code that reacts to Connected lines up behind it.
            OpenOutbox(session, token);
            if (!TrySetStatus(ConnectionStatus.Connected, token))
                token.ThrowIfCancellationRequested();
        }

        private async Task ReceiveLoop(ConnectionLoop loop, Session session, string host, int port, string app)
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
                    // Unless it was this end: OnDisable closes the socket of a loop it ends.
                    if (!token.IsCancellationRequested)
                        Debug.Log("Colibri: server closed the connection");
                    return;
                }

                _receiveThreadId = Thread.CurrentThread.ManagedThreadId;

                // Once the server has proven itself, any received byte is proof of life: it
                // heartbeats every 100 ms whether or not there is traffic, and a large message can
                // take longer than that to arrive. Before then only a decoded frame counts, or
                // something trickling bytes that never form one would hold the session open.
                if (isConnected)
                    StampLiveness();

                var frames = ReadFrames(reader, buffer, received);
                if (frames.Count > 0 && !loop.DecodedAnyFrame)
                    OnFrameDecoded(loop);

                for (var i = 0; i < frames.Count; i++)
                {
                    // Ended by OnDisable after this batch was read: the rest of it goes the way of
                    // the bytes still unread on the closed socket, and changes nothing the next loop
                    // shares.
                    token.ThrowIfCancellationRequested();

                    var frame = frames[i];

                    // Checked before the session counts as connected: colibri-server says nothing
                    // to a client before it has accepted the handshake, so a refusal is the very
                    // first frame, and that must not first be reported as a connection. (A server
                    // that heartbeats first, as colibri-server once did, is refused all the same:
                    // the refusal then ends a session that counted as connected.)
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
                            // Echoed back verbatim - the u64 is the server's own monotonic clock
                            // reading and is never interpreted here. Since 2.0.0 this echo is the
                            // sole source of the server's TCP latency measurements; the old
                            // `colibri`/`latency` message echo is Socket.IO-only and nothing
                            // sends it to a TCP client any more. Not awaited: see EchoHeartbeat.
                            EchoHeartbeat(session, frame.PingTimestamp);
                            break;

                        case FrameType.Message:
                            // A refusal never gets here - it is intercepted above, before the
                            // queue: it is Colibri's own plumbing, and delivering it as an ordinary
                            // message would leave every application to recognize it for itself.
                            // It throws, so the session unwinds through the one place that decides
                            // whether to retry.
                            EnqueueReceived(frame.Channel, frame.Command, ParsePayload(frame.Payload), token);
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
        /// Reads the server's refusal payload. Deliberately forgiving about its shape: the whole
        /// point of this path is to explain a mismatch, so a payload that is missing or is not
        /// the JSON we expect must still produce a usable message rather than a parse error that
        /// buries the real problem.
        /// </summary>
        private ProtocolMismatchException BuildProtocolMismatch(byte[] payload)
        {
            var serverVersion = "unknown";
            string reason = null;

            try
            {
                if (ParsePayload(payload) is JObject body)
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

        /// <returns><c>false</c> if the wait was cancelled - i.e. the caller should stop looping.</returns>
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

        /// <summary>Whether <paramref name="socket"/> has been closed, by whoever closed it.</summary>
        private static bool IsClosed(Socket socket)
        {
            try
            {
                // Looks without waiting, and throws ObjectDisposedException on a closed socket, on
                // .NET, Mono and IL2CPP alike.
                socket.Poll(0, SelectMode.SelectError);
                return false;
            }
            catch (ObjectDisposedException)
            {
                return true;
            }
            catch (SocketException)
            {
                // Open, but in a state the connect will report itself.
                return false;
            }
        }

        private static void CloseSocket(Socket socket)
        {
            if (socket == null)
                return;

            try
            {
                socket.Close();
            }
            catch (ObjectDisposedException)
            {
                // Already closed - closing is idempotent by design here, since both OnDisable
                // and the heartbeat watchdog can race the session's own teardown.
            }
            catch (Exception e)
            {
                Debug.LogWarning($"Colibri: error while closing socket: {e.Message}");
            }
        }

        /// <remarks>
        /// Internal for the EditMode tests, which stand in for hearing from the server with it, and
        /// for having heard from it <paramref name="millisAgo"/> ago on the system clock.
        /// </remarks>
        internal void StampLiveness(long millisAgo = 0)
        {
            Interlocked.Exchange(ref _lastHeartbeatTime, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - millisAgo);
            Interlocked.Increment(ref _livenessStamps);
        }

        /// <summary>
        /// How many times the server has been heard from: it changes whenever
        /// <see cref="MillisSinceLastHeartbeat"/> starts again from zero. Sync notes on Unity's clock
        /// when it last changed (see Sync.LastHeardAt), which the system clock that times the
        /// heartbeats need not keep pace with.
        /// </summary>
        internal long LivenessStamps => Interlocked.Read(ref _livenessStamps);

        /// <summary>
        /// How long ago the server was last heard from. Not a round-trip latency: the server's
        /// heartbeat carries the server's own clock, so the client cannot derive an RTT from it.
        /// Real latency figures live on the server's admin UI.
        /// </summary>
        public long MillisSinceLastHeartbeat() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - Interlocked.Read(ref _lastHeartbeatTime);

        /// <summary>Server the connection loop is currently using, as configured.</summary>
        public string ServerAddress => _serverAddress;

        /// <summary>TCP port the connection loop is currently using.</summary>
        public int TcpPort => _tcpPort;

        /// <summary>App name this client identifies as. Only clients sharing it can see each other.</summary>
        public string AppName => _appName;

        /// <summary>Client-library protocol version sent in the handshake.</summary>
        public static string ClientVersion => CLIENT_VERSION;

        /// <summary>
        /// Protocol version the server reported when it refused this client, or null while no
        /// refusal has been received. Only ever set alongside
        /// <see cref="ConnectionStatus.ProtocolMismatch"/>: a server that accepts the connection
        /// never sends its version, because there is nothing to report.
        /// </summary>
        public string ServerVersion => _serverVersion;

        /// <summary>
        /// Why the server refused this client, or null if it has not. Companion to
        /// <see cref="ConnectionStatus.ProtocolMismatch"/> for anything that wants to show the
        /// reason rather than just the state.
        /// </summary>
        public string ProtocolMismatchReason => _protocolMismatchReason;

        /// <summary>
        /// Why a protocol mismatch is *suspected*, or null if it is not. Set when several
        /// connections in a row were accepted but ended before a frame could be read - the only
        /// symptom available when the server's framing differs so much that it cannot send, and
        /// this client cannot decode, the explicit refusal. A connection on which no frame arrived
        /// before the heartbeat watchdog dropped it does not count: silence is logged as a warning
        /// of its own, since neither an out-of-date server nor one with TLS on stays silent. With
        /// TLS, neither does one that was closed or reset without a frame: an out-of-date server
        /// behind a TLS-terminating proxy sends frames this client cannot decode, and only those
        /// count there.
        ///
        /// Unlike <see cref="ProtocolMismatchReason"/> this is a guess, not something the server
        /// said: it reads the same whether the server is out of date or the address points at
        /// something that is not Colibri at all. The connection keeps being retried, and
        /// <see cref="Status"/> is unaffected. Cleared as soon as any frame decodes.
        /// </summary>
        public string SuspectedProtocolMismatch => _suspectedProtocolMismatch;

        /// <summary>
        /// Why the last attempt to open the TCP connection failed - "192.168.0.10:9212 did not
        /// answer within 5 s", say, a refusal, or with TLS a failed handshake or a rejected
        /// certificate - or null once one has opened. For showing why the client is still not
        /// connected; each failure is logged as well. Unaffected by anything that happens after the
        /// connection opened.
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

        // All socket writes go under _sendLock so that a frame is never interleaved with another
        // frame's bytes. Messages come through here; heartbeat echoes through EchoHeartbeat, which
        // never waits for the lock, and are written between two frames.
        private async Task SendFrame(Session session, byte[] frame, CancellationToken token)
        {
            await _sendLock.WaitAsync(token).ConfigureAwait(false);
            try
            {
                // An echo that came in while someone else had the socket goes first, and one that
                // came in while this frame was being written - a large one on a slow link takes
                // seconds - goes straight after it.
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
        // the socket - encrypted first, with TLS - so a frame is never cut short.
        private static Task WriteAll(Session session, byte[] frame)
            => session.Stream.WriteAsync(frame, 0, frame.Length);

        /// <summary>
        /// Answers a server heartbeat without waiting for the socket. The receive loop calls this,
        /// and it must never wait for a write: a large message on a slow link holds the socket for
        /// as long as it takes to write, and a receive loop waiting behind it stopped reading - the
        /// server's heartbeats included - so the watchdog in <see cref="Update"/> dropped a healthy
        /// connection after 2 s. The next session sent the same message first, and was dropped the
        /// same way, again and again, with nothing else getting through.
        ///
        /// So the echo is left in a slot, and written by whoever has the socket: at once if nobody
        /// does, otherwise by the write in progress as soon as its frame is complete - a frame cannot
        /// be split by another frame's bytes. Only the newest echo is kept. While a long write holds
        /// the socket the server is still receiving its bytes, and that is what its idle timeout
        /// looks at; a skipped echo only costs it one latency sample.
        /// </summary>
        private void EchoHeartbeat(Session session, ulong pingTimestamp)
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
        /// Under _sendLock: writes the pending echo, if there is one. With
        /// <paramref name="session"/>, only an echo that belongs to that session - an echo left
        /// over from an earlier session answers nothing any more, and is dropped.
        /// </summary>
        /// <remarks>Never throws: a write that fails closes the socket, which ends the session.</remarks>
        private async Task WritePendingEcho(Session session)
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
        /// wait for the next write or the next heartbeat, so it is written now - unless another
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
         *  Every message goes into one FIFO and is written to the socket by one drainer, so they
         *  leave in exactly the order they were sent - across an outage too. Sends used to wait
         *  on the Connected gate instead: each one issued while disconnected parked a task (no
         *  bound), and on reconnect the parked continuations resumed together on the thread pool
         *  and raced for the socket, so outage messages went out in any order and interleaved with
         *  new ones. On a last-write-wins server that let a stale position overwrite a newer one.
         *
         *  While connected the outbox is just the way to the socket and is normally empty or
         *  close to it. While not, it is the retry queue, sent ahead of anything newer as soon as
         *  the next session is connected. A message whose write failed stays at the head and goes
         *  first next time.
         *
         *  The queue is bounded during an outage, but not by dropping just anything. Broadcasts -
         *  and anything else that is not model state - are capped at MAX_QUEUED_MESSAGES, oldest
         *  dropped first. The model commands are not dropped by it, because nothing would repair
         *  the loss: a dropped model::request leaves its SyncBehaviour waiting for its first state
         *  and never sending a change, a dropped model::delete leaves the object alive on every
         *  other client, and a dropped model::update - an object that changed once early in the
         *  outage while others kept moving - is lost, and the re-request after reconnecting then
         *  even reverts it locally to the server's older copy. Instead, every model::update queued
         *  for the same object during an outage is folded into one, newer fields winning, which
         *  is exactly what a last-write-wins server would have ended up with. That keeps model
         *  state bounded by the number of objects rather than by how long the outage lasts.
         *
         *  Requests, deletes and awaited updates are not folded, though; each is queued as it is.
         *  So behind both of these sits a hard cap on the whole outbox, MAX_OUTBOX_MESSAGES, which
         *  applies while connected too: the last resort, which does drop model state rather than
         *  grow without end.
         *
         *  The folded update moves to the back of the queue, so a fold must never carry an update
         *  past something else about the same object: a newer update, a delete, or a request the
         *  server would answer without it. Such a message ends the fold for that object, and the
         *  next update starts a new one behind it; reconnecting ends every fold.
         */

        private const string MODEL_REQUEST_COMMAND = "model::request";
        private const string MODEL_UPDATE_COMMAND = "model::update";
        private const string MODEL_DELETE_COMMAND = "model::delete";

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
        // into - one that nothing else about the object has been queued behind.
        private int _droppableCount;
        private readonly Dictionary<(string Channel, string Id), LinkedListNode<Outgoing>> _queuedModelUpdates
            = new Dictionary<(string Channel, string Id), LinkedListNode<Outgoing>>();

        /// <summary>
        /// Lets the outbox drain into this session. Called once it is Connected, with the token of
        /// the loop the session belongs to: once OnDisable has ended that loop this does nothing.
        /// </summary>
        /// <remarks>Internal for the EditMode tests, which open and close it around sessions they fake.</remarks>
        internal void OpenOutbox(Session session, CancellationToken token)
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

                // Updates are only folded within one outage. From here on, those folded during the
                // outage that just ended are ordinary queued messages: what is sent while connected
                // lines up behind them without being looked at. If one is still queued when the
                // connection drops again - a slow link - folding the next outage's update for that
                // object into it would move it past those, a newer update to the object among them.
                _queuedModelUpdates.Clear();

                startDraining = !_isDraining && _outbox.Count > 0;
                if (startDraining)
                    _isDraining = true;
            }

            if (startDraining)
                _ = DrainOutbox();
        }

        /// <summary>Makes every send from now on wait in the outbox for the next connection.</summary>
        /// <remarks>Internal for the EditMode tests.</remarks>
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
        /// <see cref="CloseOutbox()"/> for the connection loop that <paramref name="token"/> belongs
        /// to, when its session ends: unless OnDisable has ended that loop, which has then closed
        /// the outbox itself, and the outbox may already drain into the next loop's session.
        /// </summary>
        /// <remarks>Internal for the EditMode tests.</remarks>
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
        /// the session has ended, or <paramref name="timeoutMs"/> has passed - whichever comes
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
        /// The server refused this client: everything still queued is dropped, and every send from
        /// now on is dropped as it is made. Waiting would be waiting forever - nothing will ever
        /// connect again - and that is a task leaked per send, plus RemoteLogging's queue growing
        /// for good behind a send that never returns.
        ///
        /// Not once OnDisable has ended the loop that <paramref name="token"/> belongs to: enabling
        /// the component again is a deliberate retry, and the next loop's sends are not refused.
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
                    _outbox.AddLast(new Outgoing { Frame = frame, Sent = sent, CanDrop = IsDroppable(command) });
                    if (IsDroppable(command))
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
            if (sent == null && command == MODEL_UPDATE_COMMAND && TryGetModelId(payload, out var update, out var id))
            {
                var key = (channel, id);

                // A copy, because the caller's object may change after it was sent.
                var latest = (JObject)update.DeepClone();

                if (_queuedModelUpdates.TryGetValue(key, out var queued))
                {
                    var merged = (JObject)queued.Value.ModelUpdate.DeepClone();
                    foreach (var property in latest.Properties())
                        merged[property.Name] = property.Value;

                    var mergedFrame = TryEncodeFrame(channel, command, merged);
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

            var canDrop = IsDroppable(command);
            if (!canDrop)
                StopFolding(channel, payload);

            _outbox.AddLast(new Outgoing { Frame = frame, Sent = sent, CanDrop = canDrop });
            if (canDrop)
                _droppableCount++;
        }

        // Under _outboxLock, for a model command that is not folded: an update someone awaits, a
        // request or a delete. A folded update goes to the back of the queue, so the update queued
        // for an object may only absorb later ones while nothing else about that object is queued
        // behind it. Otherwise its older values would overtake a newer update, arrive after a
        // delete and bring the object back, or miss a request the server then answers without them.
        private void StopFolding(string channel, JToken payload)
        {
            if (TryGetModelId(payload, out _, out var id))
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

        private static bool IsDroppable(string command)
            => command != MODEL_REQUEST_COMMAND && command != MODEL_UPDATE_COMMAND && command != MODEL_DELETE_COMMAND;

        private static bool TryGetModelId(JToken payload, out JObject update, out string id)
        {
            update = payload as JObject;
            id = null;

            if (update == null || !(update["id"] is JValue value) || value.Type != JTokenType.String)
                return false;

            id = (string)value;
            return true;
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
                Session session;
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

        private static byte[] EncodeFrame(string channel, string command, JToken payload)
        {
            try
            {
                return FrameCodec.EncodeMessage(channel, command, EncodePayload(channel, payload));
            }
            catch (FrameException e)
            {
                // One unrepresentable message is dropped as one bad message, exactly as the
                // server does on its own egress path.
                Debug.LogError($"Colibri: dropping unencodable message ({channel} / {command}): {e.Message}");
                return null;
            }
        }

        private static byte[] TryEncodeFrame(string channel, string command, JToken payload)
        {
            try
            {
                return FrameCodec.EncodeMessage(channel, command, EncodePayload(channel, payload));
            }
            catch (FrameException)
            {
                return null;
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
            var frame = EncodeFrame(channel, command, payload);
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
            var frame = EncodeFrame(channel, command, payload);
            if (frame != null)
                Post(channel, command, payload, frame, null);
        }


        /*
         *  Payload encoding
         */

        private static byte[] EncodePayload(string channel, JToken payload)
        {
            if (payload == null || payload.Type == JTokenType.Null)
                return Array.Empty<byte>();

            // Everything except the log channel goes out as JSON. Writing a string payload
            // unquoted (as v1 did) is not valid JSON, so the server's Payload.asValue() threw
            // and fell back to asString() - meaning a Unity string and a web client's string
            // did not round-trip identically.
            if (channel == LOG_CHANNEL)
                return Utf8.GetBytes(payload.Type == JTokenType.String ? payload.Value<string>() : payload.ToString(Formatting.None));

            return Utf8.GetBytes(payload.ToString(Formatting.None));
        }

        /// <summary>
        /// Reads a received payload as JSON, keeping every string exactly as it was sent.
        /// </summary>
        /// <remarks>
        /// JToken.Parse reads a string that looks like a date - "2026-10-08T12:00:00Z", what
        /// JavaScript's toISOString() and C#'s ToString("o") write - as a DateTime. A string
        /// listener or a [Sync] string member then got "10/08/2026 12:00:00" instead, and a
        /// timestamp with an offset was moved into this device's time zone, while colibri-web,
        /// reading the same message with JSON.parse, kept the string. Internal for the EditMode
        /// tests.
        /// </remarks>
        internal static JToken ParsePayload(byte[] payload)
        {
            if (payload == null || payload.Length == 0)
                return JValue.CreateNull();

            var text = Utf8.GetString(payload);
            try
            {
                // What JToken.Parse does, but with dates left as strings.
                using (var reader = new JsonTextReader(new StringReader(text)) { DateParseHandling = DateParseHandling.None })
                {
                    var token = JToken.ReadFrom(reader);

                    // Anything but a comment after the value is an error, as in JToken.Parse: the
                    // reader throws on it.
                    while (reader.Read())
                    {
                    }

                    return token;
                }
            }
            catch (JsonException)
            {
                // A non-JSON body (e.g. a raw log line) is still delivered, as a raw string.
                return new JValue(text);
            }
        }

        /// <summary>
        /// The app the handshake sends for the App Name <paramref name="appName"/>, which is the
        /// app the server puts this client in. Voice packets carry its hash as their app id, as
        /// the server relays voice only from the address of a Unity client of the packet's app.
        /// </summary>
        /// <remarks>Internal for VoiceServerConnection and the EditMode tests.</remarks>
        internal static string HandshakeAppName(string appName) => SanitizeHandshakeField(appName);

        /// <summary>
        /// Makes a device or app name safe to put in the handshake. '::' is the field separator,
        /// so a name containing one produces a frame the server rejects outright. A single ':' at
        /// either end is worse, because nothing rejects it: it merges with the separator next to
        /// it into ':::', which the server splits as '::' + ':', so app "app:" arrives as app
        /// "app" with the colon moved onto the client name - another app, silently.
        /// </summary>
        /// <remarks>Internal for the EditMode tests.</remarks>
        internal static string SanitizeHandshakeField(string value)
        {
            if (string.IsNullOrEmpty(value))
                return value;

            // After this there is no '::' left, so at most one ':' can remain at each end.
            var sanitized = value.Replace(FrameCodec.FieldSeparator, "_");

            if (sanitized[0] == ':')
                sanitized = "_" + sanitized.Substring(1);
            if (sanitized[sanitized.Length - 1] == ':')
                sanitized = sanitized.Substring(0, sanitized.Length - 1) + "_";

            return sanitized;
        }
    }
}
