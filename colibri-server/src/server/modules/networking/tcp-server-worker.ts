import * as net from 'net';
import * as tls from 'tls';
import { CONNECTION_LINE, WorkerMessage, WorkerService } from '../core/index.js';
import * as threads from 'worker_threads';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import {
    COLIBRI_CHANNEL,
    FrameError,
    FrameReader,
    FrameType,
    MAX_FRAME_LENGTH,
    PROTOCOL_REJECTED_COMMAND,
    PROTOCOL_VERSION,
    TLS_HANDSHAKE_PREFIX_LENGTH,
    V1FramingError,
    encodeHeartbeatFrame,
    encodeMessageFrame,
    looksLikeTlsHandshake,
    ownBytes,
    protocolRejection,
} from './protocol.js';
import {
    DEFAULT_RATE_LIMIT,
    EPISODE_QUIET_MILLIS,
    HeldUpdate,
    HeldUpdates,
    InboundBacklog,
    InboundRateLimiter,
    LIMITED_TRAFFIC,
    LimitEpisode,
    Limited,
    MODEL_UPDATE_COMMAND,
    RateLimit,
    asModelUpdate,
    describeEpisode,
    isLimitable,
    lostUpdatesNote,
    rateLimitEndWarning,
    rateLimitStartWarning,
    warnsAtEnd,
} from './inbound-limits.js';
import { AddressThrottle } from './address-throttle.js';
import { ClientActivity, RATE_WINDOW_MILLIS, TrafficMeter } from './client-activity.js';
import { readProxyHeader } from './proxy-protocol.js';
import { TrustProxy, compileTrustedProxies, trustNoProxy } from './trusted-proxies.js';

export const TCP_SERVER_WORKER = fileURLToPath(import.meta.url);

// Passed as workerData by TCPServerProxy and checked by the bootstrap at the bottom of this
// file. `!threads.isMainThread` alone was not enough of a guard: any test runner that
// executes its suites inside worker threads (vitest's default pool does) would construct a
// second TCPServerWorker on import and have it subscribe to *that* thread's message
// channel, which is the runner's own RPC.
export const TCP_SERVER_WORKER_ROLE = 'colibri-tcp-server';
const maxBufferSize = MAX_FRAME_LENGTH;

// For a last-write-wins synchronization server, a client whose socket write buffer is
// already this full is not keeping up - queuing yet another update behind it only grows
// process memory without bound (the old `socket.write()`'s return value was ignored
// entirely). Dropping a stale update for a slow client is the correct behaviour here.
// Replies (see MAX_REPLY_BACKLOG_BYTES) neither count towards it nor are dropped by it.
const highWaterMark = 1024 * 1024;

// How many bytes of replies, the server's answers to a client's own requests, may wait to be sent
// to one client before further replies to it are dropped too.
//
// A reply is not dropped at highWaterMark like relayed traffic: nothing would ever send it again.
// The answer to a model::request for a whole channel is one frame per model, all written at once,
// so on any link slower than loopback a store larger than highWaterMark used to reach a late joiner
// only in part, and the models cut off stayed missing on it until they next changed. This bound is
// many full stores and many maximum-size frames; it only stops a client that keeps asking without
// ever reading from taking up memory without limit.
export const MAX_REPLY_BACKLOG_BYTES = 64 * 1024 * 1024;

// How long a socket this server has ended (a refusal, or a framing error) may stay half-open
// waiting for the peer's FIN before it is destroyed. Ending first rather than destroying is what
// lets the refusal frame reach the client; this bounds what a peer that never closes its side
// can hold on to.
const CLOSE_GRACE_MILLIS = 5000;

// How many TCP messages may be waiting for the main thread before the worker starts holding back
// model updates and dropping broadcasts (see isLimitable). At the main thread's saturation point on
// a 4-core test machine (about 15k model::update/s) 2000 is roughly 130 ms of work: well clear of a
// normal burst, and short enough that what does get through is not seconds old.
export const DEFAULT_INBOUND_BACKLOG_LIMIT = 2000;

// Which limit kept a message from passing on at once.
type Refusal = 'rate' | 'backlog';

// What the worker posts as 'clientConnected$' once a client's handshake is accepted.
export interface TcpClientConnected {
    id: string;
    app: string;
    name: string;
    version: string;
    // Its address: the one its PROXY protocol header named, if it had one; see clientAddress.
    address: string;
    // Whether its connection to this server is encrypted.
    tls: boolean;
    // Whether it reached the proxy over TLS: it came through a trusted proxy, and TCP_TLS_AT_PROXY
    // says that proxy ends TLS. See TcpServerOptions.tlsAtProxy.
    tlsAtProxy: boolean;
    // Date.now() of the connection, before its handshake.
    connectedAt: number;
}

// What the worker posts as 'clientActivity$', answering an 'm:clientActivity' from TCPServerProxy:
// the activity of every client whose handshake was accepted, with each one's rate history if the
// request asks for it. Only ever posted when asked, which the proxy does only while an admin UI page
// shows it, and asks for the history only for a page's first snapshot.
export interface TcpClientActivityReport {
    request: number;
    clients: (ClientActivity & { id: string })[];
}

// How long a client may send nothing at all before it is taken for gone. A Quest that drops off
// the Wi-Fi sends no FIN, so without this its connection stayed open - a connected client, keeping
// its app's synchronized models alive - until the kernel gave up retransmitting to it, which takes
// many minutes. A live client is never anywhere near this quiet: colibri-unity echoes the 100 ms
// heartbeat from its receive thread, so even a main thread busy loading a scene keeps it talking.
//
// That holds only as long as the client finds heartbeats in what it reads, also while it is still
// reading a backlog: see HEARTBEAT_EVERY_BYTES and writeHeartbeat.
//
// A message larger than HEARTBEAT_EVERY_BYTES has no heartbeat inside it, though, so a client
// reading one can echo nothing until it is through: a 4 MiB broadcast takes about 21 s over a link
// of 200 KB/s. Nor can this server watch it being read. A write is done for Node.js once the kernel
// has taken it, and the kernel's buffers, and those of a proxy in between such as Docker's port
// forwarding, take megabytes at once: on loopback, all of that broadcast within 0.2 s. Such a client
// was disconnected 10 s in while reading all along, and once it had reconnected it never got the
// message. So until a client echoes a heartbeat sent after the latest such message written to it,
// it may stay quiet one more idle timeout for every HEARTBEAT_EVERY_BYTES of the largest one sent
// to it since it last did, the rate the heartbeats between messages already assume (6.4 KiB/s at
// the default), up to MAX_IDLE_ALLOWANCE_TIMEOUTS more (idleAllowanceMillis). The extra time ends
// once it echoes a heartbeat sent after the latest one; a client that never echoes heartbeats
// keeps it from its first such message on. The price is that a client that is gone by the time
// such a message is sent to it, or goes while it is being read, is noticed that much later.
export const DEFAULT_IDLE_TIMEOUT_MILLIS = 10_000;

// The most idle timeouts a client reading a large message may stay quiet on top of its own; see
// DEFAULT_IDLE_TIMEOUT_MILLIS. Each one keeps a client that has gone connected, and its app's models
// alive, that much longer, and behind Docker Desktop's port forwarding or another proxy nothing else
// notices it at all: the server's connection is to the proxy, so the kernel never gives up on it
// either. Without a limit that was up to 81 idle timeouts in all, 13.5 minutes, for a message of
// MAX_FRAME_LENGTH. With 6, 60 s at the default, a 4 MiB message still gets through at about
// 60 KB/s or faster (the link it was reproduced on did 200 KB/s), and a client that has gone is
// noticed within 7 idle timeouts at worst.
const MAX_IDLE_ALLOWANCE_TIMEOUTS = 6;

// After this many bytes of messages written to a client since its last heartbeat, it is sent one
// more ahead of the next message, between the ticks' heartbeats.
//
// A client that sends nothing of its own is kept connected by echoing heartbeats, and it can echo
// only those it has read. Everything written at once, the answer to a model::request for a large
// store say, used to have no heartbeat in it: the tick's next one queued behind all of it. On a
// slow link such a client, reading all along, went quiet for longer than the idle timeout and was
// disconnected, and asked for the whole store again when it reconnected. With a heartbeat every
// 64 KiB it echoes one at least every 10 s down to about 6.4 KiB/s. A single message larger than
// this still has none inside it; see DEFAULT_IDLE_TIMEOUT_MILLIS for those.
export const HEARTBEAT_EVERY_BYTES = 64 * 1024;

// If the worker's own 100 ms tick comes this late, the thread itself was stalled (a long GC, a
// starved CPU) and could not have read anything in the meantime. Every client would look idle for
// that long, so the idle check is skipped for that one tick: by the next, whatever the clients sent
// during the stall has been read.
const TICK_STALL_MILLIS = 2000;

// When the kernel starts probing a socket with nothing in flight; see handleConnection.
const KEEPALIVE_INITIAL_DELAY_MILLIS = 5000;

// How long a connection to the TLS port has to send its first bytes, and then, separately, to
// complete its TLS handshake. colibri-unity gives up on a connect after 5 s, handshake included.
export const TLS_HANDSHAKE_TIMEOUT_MILLIS = 10_000;

// With TCP_PROXY_PROTOCOL set: how long a connection has to send its PROXY protocol header, or, from
// a peer that is not a trusted proxy, enough of its first bytes to show that it sends none. The same
// as for a TLS handshake.
export const PROXY_HEADER_TIMEOUT_MILLIS = TLS_HANDSHAKE_TIMEOUT_MILLIS;

// What the log suggests when a client may not have accepted the certificate. The two settings are
// colibri-unity's, in its Colibri configuration.
const CERTIFICATE_HINT =
    'If it is a Unity app and the certificate is self-signed, tick \'Allow self-signed certificate\' in its Colibri ' +
    'configuration, or enter the certificate\'s SHA-256 fingerprint (logged at startup) as its \'Server certificate SHA-256\'. ' +
    'Otherwise check that the certificate has not expired and names the address the client connects to.';

// OpenSSL's alerts for a certificate the peer did not accept.
const CERTIFICATE_REFUSED_ALERT = /alert (bad certificate|unknown ca|certificate unknown|certificate expired|certificate revoked|unsupported certificate|access denied)/i;

// Socket error codes that say only that the peer is gone: it reset the connection (an app that
// was killed or crashed, a headset put to sleep), a write found it closed, or the network lost it
// (keepalive gave up, no route to it any more). On Wi-Fi these are part of normal operation, and
// the disconnect itself is logged anyway, so they are not errors of this server.
const PEER_GONE_ERRORS: ReadonlySet<string> = new Set([
    'ECONNRESET',
    'EPIPE',
    'ETIMEDOUT',
    'ECONNABORTED',
    'EHOSTUNREACH',
    'ENETUNREACH',
]);

// What a write still queued for a socket fails with once the socket is destroyed - one callback
// per queued write, and a client whose connection stalled can have thousands queued.
const WRITE_CANCELLED_ERRORS: ReadonlySet<string> = new Set(['ECANCELED', 'ERR_STREAM_DESTROYED']);

// A message size for the log: in MiB from 1 MiB, in KiB below.
const describeSize = function (bytes: number): string {
    const mebibyte = 1024 * 1024;
    return bytes >= mebibyte ? `${(bytes / mebibyte).toFixed(1)} MiB` : `${Math.round(bytes / 1024)} KiB`;
};

const errorCode = function (error: Error): string | undefined {
    const code = (error as NodeJS.ErrnoException).code;
    return typeof code === 'string' ? code : undefined;
};

// Why a TLS handshake failed, as a sentence for the log.
const describeTlsFailure = function (error: Error, timeoutMillis: number): string {
    const code = errorCode(error);
    if (code === 'ERR_TLS_HANDSHAKE_TIMEOUT') {
        return `it did not complete within ${timeoutMillis / 1000} s.`;
    }
    // A Node.js or .NET client that refuses the certificate closes the connection without a word.
    if (code === 'ECONNRESET' || code === 'EPIPE') {
        return `the client closed the connection during the handshake (${error.message}), as a client that does not ` +
            `accept this server's certificate does. ${CERTIFICATE_HINT}`;
    }
    if (CERTIFICATE_REFUSED_ALERT.test(error.message)) {
        return `the client refused this server's certificate (${error.message}). ${CERTIFICATE_HINT}`;
    }
    return `${error.message}.`;
};

// The TCP socket a connection came in on: for a TLS socket, the one underneath it, which Node.js
// keeps as TLSSocket._parent.
const tcpSocketOf = function (socket: net.Socket): net.Socket {
    return (socket as net.Socket & { _parent?: net.Socket | null })._parent ?? socket;
};

const NOTHING_READ = Buffer.alloc(0);

// What a connection that was read from before it got to handleConnection or handleTlsPortConnection
// gets there with: whatever followed its PROXY protocol header in the same read.
type ConnectionHandler = (socket: net.Socket, alreadyRead: Buffer) => void;

// The certificate (with its chain) and private key the TCP port serves TLS with, both PEM. Buffers
// on the main thread, plain Uint8Arrays once they have been cloned into this one.
export interface TcpTlsCredentials {
    cert: Uint8Array;
    key: Uint8Array;
}

// Settings the proxy sends along with 'm:start'; anything left out keeps its default.
export interface TcpServerOptions {
    // TCPServerProxy's backlog counter. Without it the backlog is neither counted nor limited.
    inboundBacklog?: Int32Array;
    // 0 turns the limit off.
    inboundBacklogLimit?: number;
    // Per client; see InboundRateLimiter.
    rateLimit?: RateLimit;
    // See DEFAULT_IDLE_TIMEOUT_MILLIS. 0 never times a client out.
    idleTimeoutMillis?: number;
    // Set, the port accepts only TLS connections, served with this certificate; see
    // handleTlsPortConnection. 'm:tlsCredentials' replaces it.
    tls?: TcpTlsCredentials;
    // The proxies whose PROXY protocol headers name the client, as TRUSTED_PROXIES lists them. The
    // list rather than the main thread's TrustProxy, which cannot be posted to this thread: compiled
    // here from the same list, it trusts the same peers.
    trustedProxies?: string[];
    // TCP_PROXY_PROTOCOL; see handleProxyProtocolConnection.
    proxyProtocol?: boolean;
    // TCP_TLS_AT_PROXY: a client whose connection started with a PROXY protocol header from a trusted
    // proxy reached that proxy over TLS. The header does not say so itself. Only with proxyProtocol,
    // so a connection that does not come through the proxy never counts.
    tlsAtProxy?: boolean;
}

// The worker thread only ever deals in raw payload bytes (straight off the wire, or
// destined for it) - the Payload memoization abstraction lives at the ConnectionPool
// layer on the main thread, on the other side of the postMessage boundary. Keeping the
// payload as a Buffer here means a byte-verbatim TCP->TCP relay never pays a utf8
// transcode; only a hook that actually inspects the payload (on the main thread) pays
// for decoding it.
export interface WireNetworkMessage {
    origin?: {
        id: string;
        app: string;
        name: string;
        version: string;
        metadata: Record<string, unknown>;
    };
    channel: string;
    command: string;
    payload: Buffer;
}

const toBuffer = function (value: Buffer | Uint8Array): Buffer {
    if (Buffer.isBuffer(value)) return value;
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
};

const secureContextOptions = function (credentials: TcpTlsCredentials): { cert: Buffer; key: Buffer } {
    return { cert: toBuffer(credentials.cert), key: toBuffer(credentials.key) };
};

interface TcpClient {
    id: string;
    socket: net.Socket;
    reader: FrameReader;
    address: string;
    app: string;
    version: string;
    name: string;
    // Guards handleSocketDisconnect against running twice for the same client - a socket
    // error is always followed by its own 'close' event, so without this both paths would
    // post a duplicate clientDisconnected$. Also set the moment this server ends a client
    // (closeClient), which is what stops it reading anything further from that socket.
    disconnected: boolean;
    // Destroys a socket closeClient ended if the peer never closes its side; see
    // CLOSE_GRACE_MILLIS.
    closeTimer: NodeJS.Timeout | undefined;
    // Set while writes to this client are being dropped for backpressure. Only the
    // transitions in and out of that state are logged: a stalled client in a busy app drops
    // many messages a second, and each dropped-packet warning is postMessage'd to the main
    // thread and re-broadcast to every admin UI, which WebLog can't dedupe because the
    // byte count is interpolated into the message.
    dropping: boolean;
    droppedSinceWarning: number;
    // Bytes of messages written to this client since its last heartbeat; see HEARTBEAT_EVERY_BYTES.
    bytesSinceHeartbeat: number;
    // Heartbeats handed to the socket that it has not flushed to the kernel yet; see handleHeartbeat.
    heartbeatsQueued: number;
    // Bytes of replies handed to the socket that it has not flushed to the kernel yet; see
    // MAX_REPLY_BACKLOG_BYTES. Taken off writableLength before it is compared with highWaterMark.
    replyBytesQueued: number;
    // The same as dropping and droppedSinceWarning, for replies past MAX_REPLY_BACKLOG_BYTES.
    droppingReplies: boolean;
    droppedRepliesSinceWarning: number;
    // performance.now() of the last bytes received, or of the connection if none have been yet.
    lastInboundAt: number;
    // The size of the largest message over HEARTBEAT_EVERY_BYTES written to this client since it
    // last showed it had read all such messages, 0 if there is none; and when the latest such
    // message was written, on the clock heartbeats carry. It has read them all once it echoes a
    // heartbeat from after that. See DEFAULT_IDLE_TIMEOUT_MILLIS.
    unreadLargeBytes: number;
    lastLargeWrittenAt: bigint;
    // Whether any bytes have been received from it yet; see handleSocketData.
    receivedAny: boolean;
    // Model updates over a limit, waiting for room; see HeldUpdates.
    held: HeldUpdates;
    // For the admin UI: Date.now() of the connection, the messages it sent and was sent, and the
    // limit that last refused one of its messages, and when (performance.now()).
    connectedAt: number;
    traffic: TrafficMeter;
    limitedBy: Refusal | undefined;
    limitedAt: number;
}

export class TCPServerWorker extends WorkerService {
    private server: net.Server | undefined;
    // With TLS on: never listens itself, but is handed each connection to the port that starts a TLS
    // handshake, and hands it on to handleConnection once the handshake is done.
    private tlsServer: tls.Server | undefined;
    private tlsCredentials: TcpTlsCredentials | undefined;
    private tlsHandshakeTimeoutMillis = TLS_HANDSHAKE_TIMEOUT_MILLIS;
    // The TCP sockets of every connection to the TLS port, from when it is accepted until it closes,
    // so that stop() can end those still in their handshake too.
    private readonly tlsPortSockets = new Set<net.Socket>();

    private proxyProtocol = false;
    private tlsAtProxy = false;
    private trustedProxies: string[] = [];
    private trustProxy: TrustProxy = trustNoProxy;
    private proxyHeaderTimeoutMillis = PROXY_HEADER_TIMEOUT_MILLIS;
    // The client addresses PROXY protocol headers named, by the TCP socket each came in on.
    private readonly proxiedAddresses = new WeakMap<net.Socket, string>();
    // The TCP sockets that started with a PROXY protocol header from a trusted proxy, whatever
    // address it named.
    private readonly throughProxy = new WeakSet<net.Socket>();
    // Connections yet to show whether they start with a PROXY protocol header, for stop().
    private readonly proxyHeaderSockets = new Set<net.Socket>();

    // waiting for client to specify app name
    private readonly waitingClients = new Map<string, TcpClient>();
    // properly connected clients
    private readonly clients = new Map<string, TcpClient>();
    // clients grouped by app, so broadcast() can resolve recipients without scanning
    // every connected client
    private readonly clientsByApp = new Map<string, Set<TcpClient>>();

    private heartbeatInterval: NodeJS.Timeout | undefined;

    private inboundBacklog = new InboundBacklog(undefined, DEFAULT_INBOUND_BACKLOG_LIMIT);
    // Logged once when the backlog has been overflowing for EPISODE_WARNING_MILLIS and once when it
    // has drained, however much is held back or dropped in between - not per message, which under
    // overload would itself be thousands of posts a second to the thread that is already behind. A
    // shorter episode is summed up in a single debug line.
    private readonly backlogEpisode = new LimitEpisode();
    // Clients with updates held back, for the tick to pass on as room frees up.
    private readonly clientsHolding = new Set<TcpClient>();

    // The backstop for one runaway client, which on its own can push the main thread into the
    // backlog limit above and so slow every other client's updates down too.
    private rateLimiter = this.createRateLimiter(DEFAULT_RATE_LIMIT);

    private idleTimeoutMillis = DEFAULT_IDLE_TIMEOUT_MILLIS;
    private lastTickAt: number | undefined;
    // When the clients' message rates were last sampled; see TrafficMeter.
    private trafficSampledAt = 0;

    // When a Colibri 1.x client at each remote address was last warned about.
    private readonly v1WarnedAt = new AddressThrottle();
    // The same for a client without TLS on the TLS port, a TLS client on an unencrypted one, and a
    // failed TLS handshake.
    private readonly withoutTlsWarnedAt = new AddressThrottle();
    private readonly tlsWithoutTlsPortWarnedAt = new AddressThrottle();
    private readonly tlsFailureLoggedAt = new AddressThrottle();
    // The same for a connection refused for its PROXY protocol header, by the address of the peer
    // that sent it (or did not).
    private readonly proxyHeaderWarnedAt = new AddressThrottle();

    public constructor() {
        super(true);

        // Anything thrown out of this subscriber escapes into the worker's own
        // uncaughtException path and takes the whole thread - and with it the entire TCP
        // transport - down, while HTTP and Socket.IO keep serving as if nothing happened.
        // One bad message must never cost more than that message.
        this.parentMessages$.subscribe((msg) => {
            try {
                this.handleParentMessage(msg);
            } catch (err) {
                this.logError(
                    `Error handling '${msg.channel}' from the main thread: ${err instanceof Error ? err.message : String(err)}`,
                    false
                );
            }
        });
    }

    private handleParentMessage(msg: WorkerMessage): void {
        switch (msg.channel) {
            case 'm:start':
                this.configure((msg.content.options as TcpServerOptions | undefined) ?? {});
                this.start(
                    msg.content.port as number,
                    msg.content.host as string
                );
                break;

            case 'm:stop':
                this.stop();
                break;

            case 'm:tlsCredentials':
                this.useTlsCredentials(msg.content.tls as TcpTlsCredentials);
                break;

            case 'm:clientActivity':
                this.postClientActivity(typeof msg.content.request === 'number' ? msg.content.request : 0, msg.content.history === true);
                break;

            case 'm:broadcast': {
                const ids = msg.content.clients as string[];
                const clients = ids
                    .map((id) => this.clients.get(id))
                    .filter((c): c is TcpClient => !!c);

                this.broadcast(msg.content.msg as WireNetworkMessage, clients, msg.content.reply === true);
                break;
            }

            case 'm:broadcastToApp': {
                const app = msg.content.app as string;
                const exclude = msg.content.exclude as string | undefined;
                const clients = Array.from(this.clientsByApp.get(app) ?? [])
                    .filter((c) => c.id !== exclude);

                this.broadcast(msg.content.msg as WireNetworkMessage, clients);
                break;
            }
        }
    }

    public configure(options: TcpServerOptions): void {
        this.inboundBacklog = new InboundBacklog(
            options.inboundBacklog,
            options.inboundBacklogLimit ?? DEFAULT_INBOUND_BACKLOG_LIMIT
        );
        this.rateLimiter = this.createRateLimiter(options.rateLimit ?? DEFAULT_RATE_LIMIT);
        this.idleTimeoutMillis = options.idleTimeoutMillis ?? DEFAULT_IDLE_TIMEOUT_MILLIS;
        this.tlsCredentials = options.tls;
        this.proxyProtocol = options.proxyProtocol ?? false;
        this.tlsAtProxy = options.tlsAtProxy ?? false;
        this.trustedProxies = options.trustedProxies ?? [];
        this.trustProxy = compileTrustedProxies(this.trustedProxies);
    }

    // A renewed certificate, for every connection from now on. Open ones keep the one they started
    // with: TLS has no way to change it under them.
    public useTlsCredentials(credentials: TcpTlsCredentials): void {
        this.tlsCredentials = credentials;
        if (!this.tlsServer) return;

        try {
            this.tlsServer.setSecureContext(secureContextOptions(credentials));
        } catch (err) {
            this.logError(
                `Could not switch the TCP server to the renewed TLS certificate: ${err instanceof Error ? err.message : String(err)}`,
                false
            );
        }
    }

    private createRateLimiter(limit: RateLimit): InboundRateLimiter<TcpClient> {
        const describe = (client: TcpClient) => `Unity client '${client.name}' (${client.id}, app '${client.app}', ${client.address})`;
        return new InboundRateLimiter<TcpClient>(limit, {
            started: (client) => this.logWarning(rateLimitStartWarning(describe(client), limit)),
            ended: (client, summary, left) => {
                const text = rateLimitEndWarning(describe(client), summary, left);
                if (warnsAtEnd(summary)) this.logWarning(text);
                else this.logDebug(text);
            },
        });
    }

    public start(port: number, host: string): void {
        const credentials = this.tlsCredentials;
        let handle: ConnectionHandler;
        if (credentials) {
            this.tlsServer = this.createTlsServer(credentials);
            handle = (socket, alreadyRead) => this.handleTlsPortConnection(socket, alreadyRead);
        } else {
            handle = (socket, alreadyRead) => this.handleConnection(socket, alreadyRead);
        }
        this.server = net.createServer((socket) => {
            if (this.proxyProtocol) this.handleProxyProtocolConnection(socket, handle);
            else handle(socket, NOTHING_READ);
        });
        this.server.listen(port, host);

        const proxyProtocol = this.proxyProtocol
            ? `, PROXY protocol header required from TRUSTED_PROXIES (${this.trustedProxies.join(', ')})` +
                (this.tlsAtProxy ? ', TLS terminated by proxy (TCP_TLS_AT_PROXY)' : '')
            : '';
        this.logInfo(`Starting Colibri TCP server on ${host}:${port}${credentials ? ', TLS only' : ''}${proxyProtocol}`);
        this.heartbeatInterval = setInterval(() => this.tick(), 100);
    }

    // With TCP_PROXY_PROTOCOL set, every connection starts here. One from a trusted proxy has to start
    // with a PROXY protocol header, and the client that names is the connection's client from then on:
    // in the log, and for every per-address limit. One from anywhere else is refused if it starts with
    // a header, since only a proxy sends one, and otherwise goes on as it would without
    // TCP_PROXY_PROTOCOL. Whatever follows the header goes on to `handle`, a TLS handshake included.
    private handleProxyProtocolConnection(socket: net.Socket, handle: ConnectionHandler): void {
        // Read now, which caches it for clientAddress.
        const peer = socket.remoteAddress || 'UNDEFINED';
        const trusted = this.trustProxy(peer, 0);
        const seconds = this.proxyHeaderTimeoutMillis / 1000;
        const noHeaderFix =
            'Turn on the PROXY protocol for this port in the proxy (nginx: proxy_protocol on; in its stream server). A ' +
            'client that connects directly from an address in TRUSTED_PROXIES is refused like this too.';
        this.proxyHeaderSockets.add(socket);

        let received: Buffer = NOTHING_READ;
        const stopReading = () => {
            clearTimeout(timeout);
            socket.off('data', onData);
            socket.off('close', stopReading);
            this.proxyHeaderSockets.delete(socket);
        };
        const onError = (error: Error) => {
            this.logDebug(`Lost the connection to ${peer} during the PROXY protocol check: ${error.message}`);
        };
        const onData = (chunk: Buffer) => {
            received = received.length === 0 ? chunk : Buffer.concat([received, chunk]);

            let header: ReturnType<typeof readProxyHeader>;
            try {
                header = readProxyHeader(received);
            } catch (err) {
                stopReading();
                const problem = err instanceof Error ? err.message : String(err);
                if (trusted) {
                    this.refuseProxyConnection(socket, peer, `its PROXY protocol header is invalid: ${problem}`);
                } else {
                    this.refuseUntrustedProxyHeader(socket, peer);
                }
                return;
            }
            if (header === 'incomplete') return;

            stopReading();
            if (header === 'none' && trusted) {
                this.refuseProxyConnection(
                    socket,
                    peer,
                    'it is in TRUSTED_PROXIES and TCP_PROXY_PROTOCOL is true, but the connection does not start with a PROXY protocol header',
                    noHeaderFix
                );
                return;
            }
            if (header !== 'none' && !trusted) {
                this.refuseUntrustedProxyHeader(socket, peer);
                return;
            }

            // In the same tick as `handle` adds its own listeners, so that nothing is missed in between.
            socket.off('error', onError);
            if (header === 'none') {
                handle(socket, received);
                return;
            }
            this.throughProxy.add(socket);
            if (header.sourceAddress) this.proxiedAddresses.set(socket, header.sourceAddress);
            handle(socket, received.subarray(header.length));
        };
        const timeout = setTimeout(() => {
            stopReading();
            if (trusted) {
                this.refuseProxyConnection(
                    socket,
                    peer,
                    `it is in TRUSTED_PROXIES and TCP_PROXY_PROTOCOL is true, but it sent no complete PROXY protocol header within ${seconds} s`,
                    noHeaderFix
                );
            } else {
                const sent = received.length === 0 ? 'nothing' : `only ${received.length} byte(s)`;
                this.logDebug(`Disconnecting ${peer}: it sent ${sent} within ${seconds} s of connecting`);
                socket.destroy();
            }
        }, this.proxyHeaderTimeoutMillis);
        timeout.unref();

        socket.on('data', onData);
        socket.on('error', onError);
        socket.on('close', stopReading);
    }

    private refuseUntrustedProxyHeader(socket: net.Socket, peer: string): void {
        this.refuseProxyConnection(
            socket,
            peer,
            'it starts with a PROXY protocol header, but its address is not in TRUSTED_PROXIES',
            'If it is the proxy in front of this server, add its address to TRUSTED_PROXIES.'
        );
    }

    // Logged like the other refusals: a warning at most once a minute per address, the rest at debug
    // level. Nothing is sent to the peer.
    private refuseProxyConnection(socket: net.Socket, peer: string, reason: string, fix?: string): void {
        if (!this.proxyHeaderWarnedAt.shouldWarn(peer, performance.now())) {
            this.logDebug(`Refusing a connection from ${peer}: ${reason} (warned about this address already)`);
        } else {
            this.logWarning(
                `Refusing a connection from ${peer}: ${reason}. ${fix ? `${fix} ` : ''}This is logged at most once a minute per address.`
            );
        }
        this.endRefused(socket);
    }

    // The client's address: the one its connection's PROXY protocol header named, if it had one, else
    // the address the connection comes from. The TLS socket of a failed handshake has usually been
    // destroyed already, and then no longer knows its peer's address, but the TCP socket underneath it
    // still does: the address was read when the connection was accepted, which cached it.
    private clientAddress(socket: net.Socket, unknown = 'UNDEFINED'): string {
        const tcpSocket = tcpSocketOf(socket);
        return this.proxiedAddresses.get(tcpSocket) || socket.remoteAddress || tcpSocket.remoteAddress || unknown;
    }

    // TLS wraps the same frames, unchanged: past the handshake, a TLS client is handled exactly like
    // an unencrypted one.
    private createTlsServer(credentials: TcpTlsCredentials): tls.Server {
        const server = tls.createServer({
            ...secureContextOptions(credentials),
            handshakeTimeout: this.tlsHandshakeTimeoutMillis,
        });
        server.on('secureConnection', (socket: tls.TLSSocket) => this.handleConnection(socket));
        server.on('tlsClientError', (error: Error, socket: tls.TLSSocket) => this.handleTlsClientError(error, socket));
        return server;
    }

    // A connection to the TLS port. Its first bytes say whether it starts a TLS handshake: if so, it
    // is handed to tlsServer; if not, it is refused, and the warning can name it and the fix. Handed
    // to tlsServer straight away, it would only fail its handshake with OpenSSL's "wrong version
    // number", which names neither.
    private handleTlsPortConnection(socket: net.Socket, alreadyRead: Buffer = NOTHING_READ): void {
        // Read now, which caches it for clientAddress.
        const address = this.clientAddress(socket);
        // Set on the TCP socket: the TLS socket on top of it does not pass either one down.
        socket.setNoDelay(true);
        socket.setKeepAlive(true, KEEPALIVE_INITIAL_DELAY_MILLIS);
        this.tlsPortSockets.add(socket);

        let firstBytes: Buffer = Buffer.alloc(0);
        const silence = setTimeout(() => {
            this.logDebug(`Disconnecting ${address}: it sent nothing within ${this.tlsHandshakeTimeoutMillis / 1000} s of connecting`);
            socket.destroy();
        }, this.tlsHandshakeTimeoutMillis);
        silence.unref();

        const onError = (error: Error) => {
            this.logDebug(`Lost the connection to ${address} before it started TLS: ${error.message}`);
        };
        const onData = (chunk: Buffer) => {
            firstBytes = firstBytes.length === 0 ? chunk : Buffer.concat([firstBytes, chunk]);
            if (firstBytes.length < TLS_HANDSHAKE_PREFIX_LENGTH) return;

            clearTimeout(silence);
            socket.off('data', onData);
            socket.pause();

            if (!looksLikeTlsHandshake(firstBytes)) {
                this.refuseClientWithoutTls(socket, address, firstBytes);
                return;
            }
            if (!this.tlsServer) {
                socket.destroy();
                return;
            }

            // The TLS socket reads what was read here from the TCP socket's buffer first, and reports
            // the TCP socket's errors from now on, as tlsClientError until the handshake is done.
            socket.unshift(firstBytes);
            socket.off('error', onError);
            this.tlsServer.emit('connection', socket);
        };

        socket.on('data', onData);
        socket.on('error', onError);
        socket.on('close', () => {
            clearTimeout(silence);
            this.tlsPortSockets.delete(socket);
        });
        if (alreadyRead.length > 0) onData(alreadyRead);
    }

    // Nothing is sent to such a client: it speaks neither TLS nor, necessarily, this protocol. A
    // Unity app sees the connection closed, and this warning is the diagnostic.
    private refuseClientWithoutTls(socket: net.Socket, address: string, firstBytes: Buffer): void {
        let v1 = false;
        let who = '';
        try {
            const handshake = new FrameReader(maxBufferSize).append(firstBytes).find(frame => frame.type === FrameType.Handshake);
            if (handshake) who = ` (Unity client '${handshake.name}', app '${handshake.app}')`;
        } catch (err) {
            v1 = err instanceof V1FramingError;
        }

        if (!this.withoutTlsWarnedAt.shouldWarn(address, performance.now())) {
            this.logDebug(`Refusing a connection without TLS from ${address}${who} (warned about this address already)`);
        } else if (v1) {
            this.logWarning(
                `Refusing a connection from ${address}: it looks like a Colibri 1.x client, which cannot use TLS, and this ` +
                    'server\'s TCP port accepts only TLS connections (TLS_CERT and TLS_KEY are set). Upgrade the Colibri Unity ' +
                    'package (de.uni.kn.colibri) in that app to 2.x, and tick \'Server supports SSL/TLS?\' in its Colibri ' +
                    'configuration. This is logged at most once a minute per address.'
            );
        } else {
            this.logWarning(
                `Refusing a connection from ${address}${who}: it does not use TLS, and this server's TCP port accepts only TLS ` +
                    'connections (TLS_CERT and TLS_KEY are set). Tick \'Server supports SSL/TLS?\' in that Unity app\'s Colibri ' +
                    'configuration. This is logged at most once a minute per address.'
            );
        }

        this.endRefused(socket);
    }

    // Ended rather than destroyed, so the client sees the connection closed, not reset. Whatever else it
    // sends is read and dropped, so that its own close is seen.
    private endRefused(socket: net.Socket): void {
        socket.resume();
        socket.end();
        const grace = setTimeout(() => socket.destroy(), CLOSE_GRACE_MILLIS);
        grace.unref();
        socket.once('close', () => clearTimeout(grace));
    }

    // At info, not as an error: a client that does not accept the certificate, or gives up on a slow
    // network, is no fault of this server.
    private handleTlsClientError(error: Error, socket: tls.TLSSocket): void {
        // tls.Server leaves a socket whose handshake timed out open.
        socket.destroy();

        const address = this.clientAddress(socket, 'an unknown address');
        const text = `TLS handshake with ${address} failed: ${describeTlsFailure(error, this.tlsHandshakeTimeoutMillis)}`;
        if (this.tlsFailureLoggedAt.shouldWarn(address, performance.now())) {
            this.logInfo(`${text} This is logged at most once a minute per address.`);
        } else {
            this.logDebug(text);
        }
    }

    private tick(): void {
        this.handleHeartbeat();

        const now = performance.now();
        this.drainAllHeld(now);
        this.rateLimiter.sweep(now);

        const backlogSummary = this.backlogEpisode.endIfQuiet(now);
        if (backlogSummary?.warned) {
            this.logWarning(
                `The main thread has caught up with TCP messages again; ${describeEpisode(backlogSummary)} while it was behind.` +
                    lostUpdatesNote(backlogSummary)
            );
        } else if (backlogSummary) {
            const text =
                `The main thread was briefly ${this.inboundBacklog.limit} TCP messages behind (TCP_INBOUND_BACKLOG_LIMIT) and has ` +
                `caught up; ${describeEpisode(backlogSummary)} while it was behind.` +
                lostUpdatesNote(backlogSummary);
            if (warnsAtEnd(backlogSummary)) this.logWarning(text);
            else this.logDebug(text);
        }

        const stalled = this.lastTickAt !== undefined && now - this.lastTickAt > TICK_STALL_MILLIS;
        this.lastTickAt = now;
        if (!stalled) this.endIdleClients(now);

        if (now - this.trafficSampledAt >= RATE_WINDOW_MILLIS) {
            this.trafficSampledAt = now;
            for (const client of this.clients.values()) client.traffic.sample(now);
        }
    }

    // Answers TCPServerProxy.clientActivity(): one compact report on every handshaked client. Never
    // posted unasked, so a server without an admin UI page open pays nothing for it beyond the
    // counting itself.
    private postClientActivity(request: number, history: boolean): void {
        const now = performance.now();
        const wallNow = Date.now();
        const clients: TcpClientActivityReport['clients'] = [];
        for (const client of this.clients.values()) {
            clients.push({
                id: client.id,
                in: client.traffic.receivedPerSecond,
                out: client.traffic.sentPerSecond,
                limit: this.limitOf(client, now),
                held: client.held.size,
                ...(history ? { history: client.traffic.history(now, wallNow) } : {}),
            });
        }
        const report: TcpClientActivityReport = { request, clients };
        this.postMessage('clientActivity$', report as unknown as { [key: string]: unknown });
    }

    // The limit holding the client's updates back now: the one that last refused one of its
    // messages, as long as it still has updates held back or was refused within the last
    // EPISODE_QUIET_MILLIS (a client that only sends broadcasts never has anything held).
    private limitOf(client: TcpClient, now: number): Refusal | null {
        if (!client.limitedBy) return null;
        if (client.held.size > 0 || now - client.limitedAt < EPISODE_QUIET_MILLIS) return client.limitedBy;
        return null;
    }

    // Ends every client that has sent nothing for idleTimeoutMillis, plus its idleAllowanceMillis,
    // exactly as if it had disconnected: out of every index, clientDisconnected$ posted, and so its
    // app's models dropped once it was the app's last client. Destroyed rather than ended - a peer
    // that is gone will neither read what is still queued for it nor answer a FIN.
    //
    // A client still waiting for its handshake is held to the same limit, counted from when it
    // connected: a real client handshakes at once, and since nothing is sent to a waiting client
    // any more, nothing else would ever notice one that never does.
    private endIdleClients(now: number): void {
        if (this.idleTimeoutMillis <= 0) return;

        for (const client of [...this.clients.values(), ...this.waitingClients.values()]) {
            const allowance = this.idleAllowanceMillis(client);
            if (client.lastInboundAt > now - this.idleTimeoutMillis - allowance) continue;

            const seconds = Math.round((now - client.lastInboundAt) / 1000);
            if (this.clients.has(client.id)) {
                const reading = allowance > 0
                    ? `, and ${Math.round(allowance / 1000)} s more for reading a ${describeSize(client.unreadLargeBytes)} message sent to it`
                    : '';
                const tooSlow = allowance > 0 ? ', and so does a link too slow to read that message in that time' : '';
                this.logWarning(
                    `Unity client '${client.name}' (${client.id}, app '${client.app}', ${client.address}) has sent nothing for ` +
                        `${seconds} s (TCP_IDLE_TIMEOUT_SECONDS${reading}); disconnecting it as gone. A headset that left the ` +
                        `Wi-Fi or went to sleep without closing its connection looks like this${tooSlow}.`
                );
            } else {
                this.logDebug(`Disconnecting client ${client.id} from ${client.address}: no handshake within ${seconds} s`);
            }

            this.handleSocketDisconnect(client);
            client.socket.destroy();
        }
    }

    // How much longer than idleTimeoutMillis the client may stay quiet: one more idle timeout for
    // every HEARTBEAT_EVERY_BYTES of the message unreadLargeBytes measures, the time it takes at the
    // rate the heartbeats already assume, but no more than MAX_IDLE_ALLOWANCE_TIMEOUTS. See
    // DEFAULT_IDLE_TIMEOUT_MILLIS.
    private idleAllowanceMillis(client: TcpClient): number {
        return this.idleTimeoutMillis * Math.min(client.unreadLargeBytes / HEARTBEAT_EVERY_BYTES, MAX_IDLE_ALLOWANCE_TIMEOUTS);
    }

    // Tolerates being called before start() (an 'm:stop' racing startup) and destroys live
    // sockets rather than leaving them to the terminate() that usually follows - so a stop
    // without a terminate, or a restart in the same thread, doesn't leak connections or
    // leave stale entries in the client indexes.
    public stop(): void {
        clearInterval(this.heartbeatInterval);
        this.server?.close();
        this.tlsServer = undefined;

        for (const client of [...this.clients.values(), ...this.waitingClients.values()]) {
            client.socket.destroy();
        }
        // And those still in their TLS handshake, or yet to start it, or to send a PROXY protocol header.
        for (const socket of [...this.tlsPortSockets, ...this.proxyHeaderSockets]) {
            socket.destroy();
        }
        this.clients.clear();
        this.waitingClients.clear();
        this.clientsByApp.clear();
        this.tlsPortSockets.clear();
        this.proxyHeaderSockets.clear();
    }

    // `reply`: the server's answer to the recipients' own request; see MAX_REPLY_BACKLOG_BYTES.
    public broadcast(
        msg: WireNetworkMessage,
        clients: ReadonlyArray<TcpClient>,
        reply = false
    ): void {
        if (clients.length === 0) {
            return;
        }

        let packet: Buffer;
        try {
            packet = encodeMessageFrame({
                channel: msg.channel,
                command: msg.command,
                payload: toBuffer(msg.payload),
            }, maxBufferSize);
        } catch (err) {
            // An unrepresentable frame (channel/command over 64 KiB, or a body over
            // maxBufferSize) is dropped as a single bad message. Emitting it anyway would
            // produce a frame this server's own FrameReader would reject.
            this.logError(
                `Dropping unencodable message (${msg.channel} / ${msg.command}): ${err instanceof Error ? err.message : String(err)}`,
                false
            );
            return;
        }

        for (const client of clients) {
            this.writeToClient(client, packet, reply);
        }
    }

    private writeToClient(client: TcpClient, packet: Buffer, reply = false): void {
        // Writing after end() is an error that destroys the socket - logged twice, and able to
        // cut off a refusal frame that was still being flushed. A socket gets here ended
        // between the peer's FIN (which ends our side too) and its 'close' event.
        if (client.socket.writableEnded || client.socket.destroyed) {
            return;
        }

        if (reply ? !this.admitReply(client) : !this.admitRelayed(client)) {
            return;
        }

        if (client.bytesSinceHeartbeat >= HEARTBEAT_EVERY_BYTES) {
            this.writeHeartbeat(client, encodeHeartbeatFrame(process.hrtime.bigint()));
        }
        // After the heartbeat just written ahead of it, which comes before it on the wire, so an
        // echo of that one does not count as the client having read it.
        if (packet.length > HEARTBEAT_EVERY_BYTES) {
            client.unreadLargeBytes = Math.max(client.unreadLargeBytes, packet.length);
            client.lastLargeWrittenAt = process.hrtime.bigint();
        }
        client.bytesSinceHeartbeat += packet.length;
        client.traffic.sent += 1;
        this.write(client, packet, reply ? 'reply' : 'relayed');
    }

    // A heartbeat is never dropped for a client that is behind, as relayed traffic is past
    // highWaterMark: a client that sends nothing of its own is kept connected only by echoing
    // heartbeats (see endIdleClients), so one dropped from what a live client is still reading made
    // it look gone. What bounds them instead: the ones between messages come one per
    // HEARTBEAT_EVERY_BYTES of messages admitted, and the tick's own are not queued behind one
    // still waiting (handleHeartbeat).
    private writeHeartbeat(client: TcpClient, packet: Buffer): void {
        if (client.socket.writableEnded || client.socket.destroyed) {
            return;
        }

        client.bytesSinceHeartbeat = 0;
        this.write(client, packet, 'heartbeat');
    }

    private write(client: TcpClient, packet: Buffer, kind: 'relayed' | 'reply' | 'heartbeat'): void {
        if (kind === 'reply') client.replyBytesQueued += packet.length;
        else if (kind === 'heartbeat') client.heartbeatsQueued += 1;
        client.socket.write(packet, (err) => {
            // Called once the kernel has taken the packet, or the write failed: either way it is
            // no longer waiting.
            if (kind === 'reply') client.replyBytesQueued -= packet.length;
            else if (kind === 'heartbeat') client.heartbeatsQueued -= 1;
            if (!err) return;

            // A peer that is gone fails every write still queued for it, each with a callback of
            // its own: one warning per queued message, thousands for a client whose Wi-Fi dropped
            // with model updates backed up. The socket's own 'error' event, or this server's
            // closing it, already reports the connection once (handleSocketError).
            const code = errorCode(err);
            if (code && (PEER_GONE_ERRORS.has(code) || WRITE_CANCELLED_ERRORS.has(code))) return;

            this.logWarning(
                `Failed to send message to client ${client.id}: ${err.message} `
            );
        });
    }

    // Whether relayed traffic may still be queued for the client: not once more than highWaterMark
    // of it is waiting. Replies waiting ahead of it do not count, so a client
    // still reading the answer to its model::request gets the updates made meanwhile too.
    private admitRelayed(client: TcpClient): boolean {
        const relayedBytes = client.socket.writableLength - client.replyBytesQueued;
        if (relayedBytes > highWaterMark) {
            client.droppedSinceWarning += 1;
            if (!client.dropping) {
                client.dropping = true;
                this.logWarning(
                    `Dropping messages to client ${client.id}: writable buffer exceeds high-water mark (${relayedBytes} bytes)`
                );
            }
            return false;
        }

        if (client.dropping) {
            client.dropping = false;
            this.logWarning(
                `Client ${client.id} caught up; dropped ${client.droppedSinceWarning} message(s) while backed up`
            );
            client.droppedSinceWarning = 0;
        }
        return true;
    }

    // Whether one more reply may be queued for the client: always, unless MAX_REPLY_BACKLOG_BYTES of
    // replies are waiting already.
    private admitReply(client: TcpClient): boolean {
        if (client.replyBytesQueued > MAX_REPLY_BACKLOG_BYTES) {
            client.droppedRepliesSinceWarning += 1;
            if (!client.droppingReplies) {
                client.droppingReplies = true;
                this.logWarning(
                    `Dropping answers to Unity client '${client.name}' (${client.id}, app '${client.app}', ${client.address}): ` +
                        `more than ${MAX_REPLY_BACKLOG_BYTES / (1024 * 1024)} MiB of answers to its own requests (model::request) ` +
                        'are still waiting to be sent to it. The models it asked for from here on are missing on it until they ' +
                        'change. A client that keeps asking for every model without reading the answers looks like this.'
                );
            }
            return false;
        }

        if (client.droppingReplies) {
            client.droppingReplies = false;
            this.logWarning(
                `Unity client '${client.name}' (${client.id}) is taking answers again; dropped ${client.droppedRepliesSinceWarning} ` +
                    'answer(s) to its requests while too many were waiting'
            );
            client.droppedRepliesSinceWarning = 0;
        }
        return true;
    }

    private handleConnection(socket: net.Socket, alreadyRead: Buffer = NOTHING_READ): void {
        const id = randomUUID();
        const address = this.clientAddress(socket);
        const tcpSocket = tcpSocketOf(socket);
        const through = this.proxiedAddresses.has(tcpSocket) ? ` through ${tcpSocket.remoteAddress}` : '';
        this.logDebug(
            `New client (${id}) connected from ${address}${through}, waiting for app name`,
            CONNECTION_LINE
        );
        socket.setNoDelay(true);
        // The kernel's own dead-peer detection, for a socket with nothing in flight - one waiting
        // for its handshake, say. A handshaked client is written to every 100 ms, which keeps
        // keepalive from ever probing it; the idle timeout in endIdleClients covers that case.
        socket.setKeepAlive(true, KEEPALIVE_INITIAL_DELAY_MILLIS);

        const tcpClient: TcpClient = {
            id,
            socket,
            reader: new FrameReader(maxBufferSize),
            address,
            app: '',
            name: '',
            version: '0',
            disconnected: false,
            closeTimer: undefined,
            dropping: false,
            droppedSinceWarning: 0,
            bytesSinceHeartbeat: 0,
            heartbeatsQueued: 0,
            replyBytesQueued: 0,
            droppingReplies: false,
            droppedRepliesSinceWarning: 0,
            lastInboundAt: performance.now(),
            unreadLargeBytes: 0,
            lastLargeWrittenAt: 0n,
            receivedAny: false,
            held: new HeldUpdates(),
            connectedAt: Date.now(),
            traffic: new TrafficMeter(performance.now()),
            limitedBy: undefined,
            limitedAt: 0,
        };
        this.waitingClients.set(tcpClient.id, tcpClient);

        socket.on('data', (data) => {
            this.handleSocketData(tcpClient, data);
        });

        socket.on('error', (error) => {
            this.handleSocketError(tcpClient, error);
        });

        // 'close' always fires exactly once, whether the socket ended gracefully, errored,
        // or was destroyed outright - unlike 'end', which never fires on an abrupt
        // disconnect (e.g. a client that vanishes without sending FIN), which used to leak
        // that client in `clients`/`clientsByApp` forever.
        socket.on('close', () => {
            clearTimeout(tcpClient.closeTimer);
            this.handleSocketDisconnect(tcpClient);
        });

        if (alreadyRead.length > 0) this.handleSocketData(tcpClient, alreadyRead);
    }

    private handleSocketData(client: TcpClient, data: Buffer): void {
        // A client this server has already refused or cut off: the peer can keep sending
        // until it notices our FIN, and none of it is meant to be acted on.
        if (client.disconnected) return;

        const now = performance.now();
        client.lastInboundAt = now;

        // A TLS client on an unencrypted port. Its handshake would otherwise go into the frame
        // reader, which reads a length field of 790 bytes or more from it and waits, silently, for
        // the rest of a frame that never comes, until the idle timeout; or rejects it as an invalid
        // frame, which names neither the client's setting nor the server's.
        if (!client.receivedAny) {
            client.receivedAny = true;
            if (!(client.socket as tls.TLSSocket).encrypted && looksLikeTlsHandshake(data)) {
                this.reportTlsClientWithoutTlsPort(client);
                this.closeClient(client);
                return;
            }
        }

        let frames;
        try {
            frames = client.reader.append(data);
        } catch (err) {
            if (err instanceof V1FramingError) {
                this.reportV1Client(client);
            } else {
                const reason = err instanceof FrameError ? err.message : String(err);
                this.logError(
                    `Invalid frame from client ${client.id}, discarding buffer and terminating connection: ${reason}`,
                    false
                );
            }
            client.reader.reset();
            this.closeClient(client);
            return;
        }

        for (const frame of frames) {
            // A handshake earlier in this same chunk may have refused the client; the frames
            // queued behind it must not be relayed or logged as orphans.
            if (client.disconnected) return;

            switch (frame.type) {
                case FrameType.Handshake:
                    // A re-handshake can move the client to another app; what it sent in the old
                    // one has to reach the main thread while it is still in the old one.
                    this.releaseHeld(client);
                    try {
                        this.assignApp(client, frame.app, frame.name, frame.version);
                    } catch (err) {
                        this.logError(
                            `Invalid handshake packet received from client ${client.id}`,
                            false
                        );
                        if (err instanceof Error) this.logError(err.stack || '', false);
                        else console.error(err);
                    }
                    break;

                case FrameType.Heartbeat:
                    // One written after the client's large messages: it has read them all.
                    if (frame.pingTimestamp > client.lastLargeWrittenAt) client.unreadLargeBytes = 0;
                    this.handlePong(client, frame.pingTimestamp);
                    break;

                case FrameType.Message:
                    if (!client.app) {
                        this.logError(
                            `Ignoring message (${frame.channel} / ${frame.command}) from client ${client.id} without app`,
                            false
                        );
                        break;
                    }

                    client.traffic.received += 1;
                    if (!isLimitable(frame.channel, frame.command)) {
                        // Nothing may overtake what the client sent before it, so whatever of its
                        // updates is held back goes first - a model::delete must not arrive ahead
                        // of an update to the same object and have that update bring it back.
                        this.releaseHeld(client);
                        this.postClientMessage(client, frame.channel, frame.command, frame.payload);
                    } else {
                        this.acceptLimitable(client, frame.channel, frame.command, frame.payload, now);
                    }
                    break;
            }
        }
    }

    private assignApp(client: TcpClient, app: string, name: string, version: string): void {
        // Refuse before the client is indexed, so a mismatched client never reaches an app's
        // broadcast set, never posts clientConnected$, and never shows up in the admin UI as
        // a half-connected ghost.
        if (version !== PROTOCOL_VERSION) {
            this.rejectProtocolVersion(client, name, version);
            return;
        }

        // A second handshake frame with a different app would otherwise leave the client in
        // its previous app's Set forever - removeFromAppIndex only ever looks at the
        // client's *current* app - so a disconnected socket would keep receiving
        // writeToClient calls for the app it first announced.
        if (client.app) {
            this.removeFromAppIndex(client);
        }

        client.app = app;
        client.name = name;
        client.version = version;
        this.logDebug(
            `Setting app of new colibri client '${name}' (${client.id}, v${version}) to "${app}"`,
            {
                clientApp: client.app,
                clientName: client.name,
                clientId: client.id,
                ...CONNECTION_LINE,
            }
        );
        this.waitingClients.delete(client.id);
        this.clients.set(client.id, client);
        this.addToAppIndex(client);
        const connected: TcpClientConnected = {
            id: client.id,
            app,
            name,
            version,
            address: client.address,
            tls: (client.socket as tls.TLSSocket).encrypted === true,
            tlsAtProxy: this.tlsAtProxy && this.throughProxy.has(tcpSocketOf(client.socket)),
            connectedAt: client.connectedAt,
        };
        this.postMessage('clientConnected$', connected as unknown as { [key: string]: unknown });
    }

    // Tells the client why it was refused and closes the connection. Only a client that speaks
    // this server's *framing* gets here - one whose handshake frame decoded, but announced another
    // protocol version - so it can read the refusal. A Colibri 1.x client never reaches this
    // method: its handshake is not a valid frame in the current framing, so FrameReader throws a
    // V1FramingError on its first bytes and reportV1Client names it instead (it could not decode
    // a refusal anyway). Either way the log line is the diagnostic an integrator will look at.
    //
    // end(packet) rather than write-then-end: it queues the rejection and the FIN together,
    // so the frame cannot be lost to a close that races the write callback.
    private rejectProtocolVersion(client: TcpClient, name: string, version: string): void {
        const rejection = protocolRejection(version);
        this.logError(
            `Refusing client '${name}' (${client.id}, ${client.address}): ${rejection.reason}`,
            false
        );

        let packet: Buffer | undefined;
        try {
            packet = encodeMessageFrame({
                channel: COLIBRI_CHANNEL,
                command: PROTOCOL_REJECTED_COMMAND,
                payload: Buffer.from(JSON.stringify(rejection), 'utf8'),
            }, maxBufferSize);
        } catch {
            // Nothing useful to say if even the refusal cannot be encoded - the socket is
            // going away either way.
        }
        this.closeClient(client, packet);
    }

    // A 1.x client cannot be sent a refusal it would understand - the framing itself differs -
    // so this warning is the whole diagnostic. Before it, all the log said was an anonymous
    // "Invalid frame length: 1744830464" once a second, which names neither the client nor
    // the fix.
    private reportV1Client(client: TcpClient): void {
        if (!this.v1WarnedAt.shouldWarn(client.address, performance.now())) {
            this.logDebug(`Refusing Colibri 1.x client ${client.id} from ${client.address} (warned about this address already)`);
            return;
        }

        this.logWarning(
            `Refusing a connection from ${client.address}: it looks like a Colibri 1.x client (it speaks the 1.x wire format), ` +
                `but this server speaks protocol v${PROTOCOL_VERSION}. Upgrade the Colibri Unity package (de.uni.kn.colibri) ` +
                'in that app to 2.x. This is logged at most once a minute per address.'
        );
    }

    private reportTlsClientWithoutTlsPort(client: TcpClient): void {
        if (!this.tlsWithoutTlsPortWarnedAt.shouldWarn(client.address, performance.now())) {
            this.logDebug(`Refusing TLS client ${client.id} from ${client.address} (warned about this address already)`);
            return;
        }

        this.logWarning(
            `Refusing a connection from ${client.address}: it starts a TLS handshake, but this server's TCP port does not use ` +
                'TLS (TLS_CERT and TLS_KEY are not set). Untick \'Server supports SSL/TLS?\' in that Unity app\'s Colibri ' +
                'configuration, or set TLS_CERT and TLS_KEY on this server. This is logged at most once a minute per address.'
        );
    }

    // Ends a connection from this side: drops the client from every index *now*, rather than
    // when its 'close' event eventually arrives. Until then it used to stay listed, so the next
    // 100ms heartbeat wrote to the ended socket - "write after end", logged twice, and a destroy
    // that could truncate the refusal frame still being flushed.
    //
    // end(finalPacket) queues that frame ahead of the FIN, so it is still delivered. The timer
    // only matters for a peer that never closes its side; a well-behaved one closes first and
    // the socket's 'close' handler clears it.
    private closeClient(client: TcpClient, finalPacket?: Buffer): void {
        if (client.disconnected) return;

        this.handleSocketDisconnect(client);
        if (finalPacket) {
            client.socket.end(finalPacket);
        } else {
            client.socket.end();
        }

        client.closeTimer = setTimeout(() => client.socket.destroy(), CLOSE_GRACE_MILLIS);
        // Never the reason a worker thread stays alive.
        client.closeTimer.unref();
    }

    // A client echoes a server-sent heartbeat frame's timestamp back verbatim; relay it
    // into the normal clientMessage$ pipeline as a 'colibri'/'latency' message so
    // MeasureLatency's existing round-trip math (unchanged) handles it exactly as it
    // would a message-level ping reply. hrtime is a system-wide monotonic clock, so a
    // timestamp this worker generated remains valid to diff against once it reaches the
    // main thread. The difference from before is purely in what it cost to get here: one
    // fixed 13-byte frame each way instead of a full channel/command/payload message.
    private handlePong(client: TcpClient, pingTimestamp: bigint): void {
        if (!client.app) return;

        // ownBytes: a Buffer.from() this small is a view into the 64 KiB Buffer pool, and
        // postMessage would clone all of it - ten times a second per client.
        this.postClientMessage(client, 'colibri', 'latency', ownBytes(Buffer.from(pingTimestamp.toString(), 'utf8')));
    }

    // Every message for the main thread's hooks goes through here, so each one is counted in the
    // backlog that TCPServerProxy counts back down once it has been dispatched.
    private postClientMessage(client: TcpClient, channel: string, command: string, payload: Buffer): void {
        this.inboundBacklog.posted();
        this.postMessage('clientMessage$', {
            channel,
            command,
            payload,
            origin: {
                id: client.id,
                app: client.app,
                name: client.name,
                version: client.version,
                metadata: {},
            },
        });
    }

    // A model::update or broadcast::* (see isLimitable). It passes straight on if neither limit is
    // in the way and none of this client's updates are being held back - that is every message,
    // as long as the server keeps up. Otherwise an update is held back and merged with the
    // client's other updates to the same object, and a broadcast is dropped.
    //
    // Past the backlog limit the main thread is further behind than it can make up while clients
    // keep sending at this rate, and every further message would only sit in the queue - in
    // memory, getting older. Holding updates back here, where each object's pile up into one,
    // is what keeps both bounded without losing any field's latest value.
    private acceptLimitable(client: TcpClient, channel: string, command: string, payload: Buffer, now: number): void {
        // Held updates go first, so this message cannot overtake them; if they cannot all go,
        // neither can it.
        const refusedBy = this.drainHeld(client, now) ?? this.admit(client, now);
        if (!refusedBy) {
            this.postClientMessage(client, channel, command, payload);
            return;
        }

        // A broadcast is dropped; see hold() for an update.
        const limited = command === MODEL_UPDATE_COMMAND ? this.hold(client, channel, payload) : 'dropped';
        this.recordLimited(client, refusedBy, limited, now);
    }

    // Which limit, if any, keeps a client from passing on one more limitable message now. The
    // backlog first, so a token is only spent on a message that then goes on: a token taken for
    // one held back by the backlog, and another when it finally goes, would have had a client at a
    // legitimate 720 updates a second over its own limit of 1000 whenever the server is behind.
    private admit(client: TcpClient, now: number): Refusal | undefined {
        if (this.inboundBacklog.full) return 'backlog';
        if (!this.rateLimiter.take(client, now)) return 'rate';
        return undefined;
    }

    // Holds a model update back. It is dropped if the server could not apply it anyway (not a JSON
    // object with a string id, which ModelSynchronization refuses), and lost if it is for one object
    // too many (see Limited).
    private hold(client: TcpClient, channel: string, payload: Buffer): Limited {
        let model;
        try {
            model = asModelUpdate(JSON.parse(payload.toString('utf8')));
        } catch {
            return 'dropped';
        }
        if (!model) return 'dropped';
        if (!client.held.hold(channel, model)) return 'lost';

        this.clientsHolding.add(client);
        return 'held';
    }

    // Passes on as many of the client's held updates as the limits allow, oldest first. Returns
    // the limit that stopped it, or undefined once nothing is held any more.
    private drainHeld(client: TcpClient, now: number): Refusal | undefined {
        // The case for every message while the server keeps up.
        if (client.held.size === 0) return undefined;

        while (client.held.size > 0) {
            // The backlog first, so a full one does not cost the client a token.
            if (this.inboundBacklog.full) return 'backlog';
            if (!this.rateLimiter.take(client, now)) return 'rate';
            this.postHeld(client, client.held.shift()!);
        }
        this.clientsHolding.delete(client);
        return undefined;
    }

    // Every held update, regardless of the limits: before something from the same client that
    // must not overtake them, and when it leaves. There are at most MAX_HELD_OBJECTS of them.
    private releaseHeld(client: TcpClient): void {
        if (client.held.size === 0) return;

        for (const update of client.held.takeAll()) this.postHeld(client, update);
        this.clientsHolding.delete(client);
    }

    // The tick's share-out of whatever room there is: one update per holding client per round,
    // so under a sustained overload every client's objects keep moving, instead of the first
    // clients in line taking all of it.
    private drainAllHeld(now: number): void {
        let progressed = true;
        while (progressed && this.clientsHolding.size > 0) {
            progressed = false;
            for (const client of this.clientsHolding) {
                if (this.inboundBacklog.full) return;
                if (!this.rateLimiter.take(client, now)) continue;

                const update = client.held.shift();
                if (update) {
                    this.postHeld(client, update);
                    progressed = true;
                }
                if (client.held.size === 0) this.clientsHolding.delete(client);
            }
        }
    }

    private postHeld(client: TcpClient, update: HeldUpdate): void {
        const payload = ownBytes(Buffer.from(JSON.stringify(update.model), 'utf8'));
        this.postClientMessage(client, update.channel, MODEL_UPDATE_COMMAND, payload);
    }

    private recordLimited(client: TcpClient, refusedBy: Refusal, limited: Limited, now: number): void {
        client.limitedBy = refusedBy;
        client.limitedAt = now;
        if (refusedBy === 'rate') {
            this.rateLimiter.record(client, now, limited);
            return;
        }

        if (this.backlogEpisode.record(now, limited)) {
            // The limit rather than a fresh read of the counter, which the main thread may have
            // counted down a little since `full` read it - "1998 behind, limit 2000" just confuses.
            this.logWarning(
                `The main thread has kept falling ${this.inboundBacklog.limit} TCP messages behind (TCP_INBOUND_BACKLOG_LIMIT) for a ` +
                    'second now: the server is taking in more than it can process. Until it catches up, for every Unity client ' +
                    `${LIMITED_TRAFFIC}, ` +
                    'so synced objects move less smoothly. Fewer synced objects, a lower sync rate or fewer clients per app reduce the load.'
            );
        }
    }

    private handleSocketError(client: TcpClient, error: Error): void {
        const who = `client ${client.id} (${client.address}${client.name ? `, '${client.name}'` : ''})`;
        const code = errorCode(error);

        // A peer that closed abruptly - an EPIPE as much as an ECONNRESET - is not this server's
        // error. Matched by code: it used to be the message, which let EPIPE through at ERROR.
        if (code && PEER_GONE_ERRORS.has(code)) {
            this.logDebug(`Lost the connection to ${who}: ${error.message}`, CONNECTION_LINE);
        } else {
            this.logError(`Socket error on ${who}: ${error.message}`, false);
        }

        // No need to call handleSocketDisconnect here - a socket's 'close' event always
        // fires directly after 'error', and that already handles cleanup.
    }

    private handleSocketDisconnect(client: TcpClient): void {
        if (client.disconnected) return;
        client.disconnected = true;

        this.logDebug(`Colibri client ${client.address} disconnected`, {
            clientApp: client.app,
            clientName: client.name,
            clientId: client.id,
            ...CONNECTION_LINE,
        });
        this.clients.delete(client.id);
        this.waitingClients.delete(client.id);
        this.removeFromAppIndex(client);
        // Ahead of clientDisconnected$, so the main thread still knows whose they are: the last
        // state a client sent is applied even if it was held back when it left.
        this.releaseHeld(client);
        this.rateLimiter.forget(client);
        this.postMessage('clientDisconnected$', { id: client.id });
    }

    private addToAppIndex(client: TcpClient): void {
        let clients = this.clientsByApp.get(client.app);
        if (!clients) {
            clients = new Set();
            this.clientsByApp.set(client.app, clients);
        }
        clients.add(client);
    }

    private removeFromAppIndex(client: TcpClient): void {
        const clients = this.clientsByApp.get(client.app);
        if (!clients) return;

        clients.delete(client);
        if (clients.size === 0) {
            this.clientsByApp.delete(client.app);
        }
    }

    // Only clients whose handshake was accepted. colibri-unity counts a session as connected from
    // the first frame it decodes, so heartbeating a client still waiting for its handshake to be
    // checked made one this server was about to refuse fire OnConnected first, and
    // ProtocolMismatch a moment later. Nothing else needed the early ones: a waiting client's echo
    // was discarded (handlePong) anyway.
    //
    // So nothing at all is written to a client before its handshake is accepted: it is neither
    // heartbeated nor in any app's recipients. A client refused for its protocol version is sent
    // protocol::rejected and nothing else; one cut off for a malformed frame, nothing at all. An
    // accepted one is sent, first, whichever of these comes first - any of them means "connected",
    // which is all colibri-unity needs:
    // - its own colibri::clients / client::connected, which ClientBroadcast sends the whole app,
    //   the joiner included, once the main thread has the clientConnected$ posted from assignApp -
    //   usually first, a few milliseconds after acceptance;
    // - another client's broadcast::* or model message relayed to the app: assignApp adds the
    //   client to the app's recipients here at once, before the main thread knows about it, so
    //   with other TCP clients in the app this can arrive ahead of client::connected;
    // - the next heartbeat, within 100 ms.
    // Answers to its own model::request or client::request come after client::connected, since the
    // main thread handles its clientConnected$ before anything it sends.
    //
    // A client with an earlier heartbeat still waiting in its socket is skipped. A client that keeps
    // sending but never reads (a send-only script, or one whose receive loop has died) is kept
    // connected by what it sends, and used to be queued every tick's heartbeat on top: ten writes a
    // second, a few hundred bytes of memory each, for as long as it stayed. A client that is reading
    // loses nothing by the skip: it finds the heartbeat already waiting, and is sent the next one on
    // the first tick after that has gone to the kernel.
    private handleHeartbeat(): void {
        const packet = encodeHeartbeatFrame(process.hrtime.bigint());
        for (const client of this.clients.values()) {
            if (client.heartbeatsQueued > 0) continue;
            this.writeHeartbeat(client, packet);
        }
    }
}

if (!threads.isMainThread && (threads.workerData as { role?: string } | null)?.role === TCP_SERVER_WORKER_ROLE) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const server = new TCPServerWorker();
}
