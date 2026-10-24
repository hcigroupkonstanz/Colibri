import * as net from 'net';
import type * as tls from 'tls';
import { AppIndex } from '../../core/app-index.js';
import { errorMessage } from '../../core/error-message.js';
import { CONNECTION_LINE } from '../../core/log-message.js';
import type { WorkerMessage } from '../../core/worker/worker-message.js';
import { WorkerService } from '../../core/worker/worker-service.js';
import * as threads from 'worker_threads';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import {
    COLIBRI_CHANNEL,
    FrameError,
    FrameType,
    MAX_FRAME_LENGTH,
    PROTOCOL_REJECTED_COMMAND,
    PROTOCOL_VERSION,
    V1FramingError,
    encodeHeartbeatFrame,
    encodeMessageFrame,
    looksLikeTlsHandshake,
    ownBytes,
    protocolRejection,
} from '../../protocol/protocol.js';
import type { DecodedFrame } from '../../protocol/protocol.js';
import type {
    HeldUpdate,
    Limited,
    RateLimit,
} from '../../limits/inbound-limits.js';
import {
    DEFAULT_RATE_LIMIT,
    EPISODE_QUIET_MILLIS,
    InboundBacklog,
    InboundRateLimiter,
    LIMITED_TRAFFIC,
    LimitEpisode,
    MODEL_UPDATE_COMMAND,
    asModelUpdate,
    describeEpisode,
    isLimitable,
    lostUpdatesNote,
    rateLimitEndWarning,
    rateLimitStartWarning,
    warnsAtEnd,
} from '../../limits/inbound-limits.js';
import { AddressThrottle } from './address-throttle.js';
import { CLOSE_GRACE_MILLIS } from './end-refused.js';
import { HEARTBEAT_EVERY_BYTES } from './heartbeat-every-bytes.js';
import { KEEPALIVE_INITIAL_DELAY_MILLIS } from './keepalive.js';
import { TlsPort } from './tls-port.js';
import { createTcpClient } from './tcp-client.js';
import type { Refusal, TcpClient } from './tcp-client.js';
import { fellBackToIPv4, hostPort, ipv4OnlyWarning, listenHost, normalizeAddress } from '../../net/addresses.js';
import { RATE_WINDOW_MILLIS } from '../../limits/client-activity.js';
import { toBuffer } from '../../protocol/to-buffer.js';
import { NOTHING_READ, ProxyProtocolGate } from './proxy-protocol-gate.js';
import type { ConnectionHandler } from './proxy-protocol-gate.js';
import { PEER_GONE_ERRORS, WRITE_CANCELLED_ERRORS, errorCode, tcpSocketOf } from './socket-errors.js';
import type {
    TcpClientActivityReport,
    TcpClientConnected,
    TcpServerOptions,
    TcpTlsCredentials,
    WireNetworkMessage,
} from '../worker-messages.js';
import { TCP_SERVER_WORKER_ROLE } from '../worker-messages.js';

export const TCP_SERVER_WORKER = fileURLToPath(import.meta.url);

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

// A channel or command may be up to 64 KiB; a log line names only this much of one.
const abbreviateName = (name: string): string => (name.length > 200 ? `${name.slice(0, 200)}...` : name);

// How many TCP messages may be waiting for the main thread before the worker starts holding back
// model updates and dropping broadcasts (see isLimitable). At the main thread's saturation point on
// a 4-core test machine (about 15k model::update/s) 2000 is roughly 130 ms of work: well clear of a
// normal burst, and short enough that what does get through is not seconds old.
export const DEFAULT_INBOUND_BACKLOG_LIMIT = 2000;

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

// If the worker's own 100 ms tick comes this late, the thread itself was stalled (a long GC, a
// starved CPU) and could not have read anything in the meantime. Every client would look idle for
// that long, so the idle check is skipped for that one tick: by the next, whatever the clients sent
// during the stall has been read.
const TICK_STALL_MILLIS = 2000;

// A message size for the log: in MiB from 1 MiB, in KiB below.
const describeSize = function (bytes: number): string {
    const mebibyte = 1024 * 1024;
    return bytes >= mebibyte ? `${(bytes / mebibyte).toFixed(1)} MiB` : `${Math.round(bytes / 1024)} KiB`;
};

type FrameOf<T extends FrameType> = Extract<DecodedFrame, { type: T }>;

export class TCPServerWorker extends WorkerService {
    private server: net.Server | undefined;
    private readonly tlsPort = new TlsPort({
        clientAddress: (socket, unknown) => this.proxyProtocolGate.clientAddress(socket, unknown),
        handleConnection: (socket) => this.handleConnection(socket),
        logDebug: (msg) => this.logDebug(msg),
        logInfo: (msg) => this.logInfo(msg),
        logWarning: (msg) => this.logWarning(msg),
        logError: (msg, printStacktrace) => this.logError(msg, printStacktrace),
    });

    // One for the worker's lifetime: configure() only updates its settings, so the sockets it has
    // seen keep what their PROXY protocol headers named.
    private readonly proxyProtocolGate = new ProxyProtocolGate({
        logDebug: (msg) => this.logDebug(msg),
        logWarning: (msg) => this.logWarning(msg),
    });

    // waiting for client to specify app name
    private readonly waitingClients = new Map<string, TcpClient>();
    // properly connected clients
    private readonly clients = new Map<string, TcpClient>();
    // clients grouped by app, so broadcast() can resolve recipients without scanning
    // every connected client
    private readonly clientsByApp = new AppIndex<TcpClient>();

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
    // The same for a TLS client on an unencrypted port.
    private readonly tlsWithoutTlsPortWarnedAt = new AddressThrottle();
    // The same for a connection closed for a message before its handshake.
    private readonly noHandshakeWarnedAt = new AddressThrottle();

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
                    `Error handling '${msg.channel}' from the main thread: ${errorMessage(err)}`,
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
        this.tlsPort.configure(options.tls);
        this.proxyProtocolGate.configure(options);
    }

    // Switches the TLS port to a renewed certificate; TlsPort.useTlsCredentials has the details.
    public useTlsCredentials(credentials: TcpTlsCredentials): void {
        this.tlsPort.useTlsCredentials(credentials);
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
        const tlsOnly = this.tlsPort.start();
        let handle: ConnectionHandler;
        if (tlsOnly) {
            handle = (socket, alreadyRead) => this.tlsPort.handleTlsPortConnection(socket, alreadyRead);
        } else {
            handle = (socket, alreadyRead) => this.handleConnection(socket, alreadyRead);
        }
        this.server = net.createServer((socket) => this.proxyProtocolGate.accept(socket, handle));
        const server = this.server;
        server.once('listening', () => {
            if (fellBackToIPv4(host, server.address())) this.logWarning(ipv4OnlyWarning('TCP_HOST', 'Unity port'));
        });
        server.listen(port, listenHost(host));

        const proxyProtocol = this.proxyProtocolGate.describeSetup();
        this.logInfo(`Starting Colibri TCP server on ${hostPort(host, port)}${tlsOnly ? ', TLS only' : ''}${proxyProtocol}`);
        this.heartbeatInterval = setInterval(() => this.tick(), 100);
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
            if (client.reading.lastInboundAt > now - this.idleTimeoutMillis - allowance) continue;

            const seconds = Math.round((now - client.reading.lastInboundAt) / 1000);
            if (this.clients.has(client.id)) {
                const reading = allowance > 0
                    ? `, and ${Math.round(allowance / 1000)} s more for reading a ${describeSize(client.reading.unreadLargeBytes)} message sent to it`
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
        return this.idleTimeoutMillis * Math.min(client.reading.unreadLargeBytes / HEARTBEAT_EVERY_BYTES, MAX_IDLE_ALLOWANCE_TIMEOUTS);
    }

    // Tolerates being called before start() (an 'm:stop' racing startup) and destroys live
    // sockets rather than leaving them to the terminate() that usually follows - so a stop
    // without a terminate, or a restart in the same thread, doesn't leak connections or
    // leave stale entries in the client indexes.
    public stop(): void {
        clearInterval(this.heartbeatInterval);
        this.server?.close();
        this.tlsPort.stop();

        for (const client of [...this.clients.values(), ...this.waitingClients.values()]) {
            client.socket.destroy();
        }
        // And those still in their TLS handshake, or yet to start it, or to send a PROXY protocol header.
        this.tlsPort.destroySockets();
        this.proxyProtocolGate.destroySockets();
        this.clients.clear();
        this.waitingClients.clear();
        this.clientsByApp.clear();
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
            }, MAX_FRAME_LENGTH);
        } catch (err) {
            // An unrepresentable frame (channel/command over 64 KiB, or a body over
            // MAX_FRAME_LENGTH) is dropped as a single bad message. Emitting it anyway would
            // produce a frame this server's own FrameReader would reject.
            this.logError(
                `Dropping unencodable message (${msg.channel} / ${msg.command}): ${errorMessage(err)}`,
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
            client.reading.unreadLargeBytes = Math.max(client.reading.unreadLargeBytes, packet.length);
            client.reading.lastLargeWrittenAt = process.hrtime.bigint();
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
        const address = this.proxyProtocolGate.clientAddress(socket);
        const tcpSocket = tcpSocketOf(socket);
        const through = this.proxyProtocolGate.hasProxiedAddress(tcpSocket) ? ` through ${normalizeAddress(tcpSocket.remoteAddress || 'UNDEFINED')}` : '';
        this.logDebug(
            `New client (${id}) connected from ${address}${through}, waiting for app name`,
            CONNECTION_LINE
        );
        socket.setNoDelay(true);
        // The kernel's own dead-peer detection, for a socket with nothing in flight - one waiting
        // for its handshake, say. A handshaked client is written to every 100 ms, which keeps
        // keepalive from ever probing it; the idle timeout in endIdleClients covers that case.
        socket.setKeepAlive(true, KEEPALIVE_INITIAL_DELAY_MILLIS);

        const tcpClient = createTcpClient(id, socket, address);
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
        if (!this.acceptChunk(client, data, now)) return;

        const frames = this.readFrames(client, data);
        if (!frames) return;

        for (const frame of frames) {
            // A handshake earlier in this same chunk may have refused the client; the frames
            // queued behind it must not be relayed or logged as orphans.
            if (client.disconnected) return;

            switch (frame.type) {
                case FrameType.Handshake:
                    this.onHandshakeFrame(client, frame);
                    break;

                case FrameType.Heartbeat:
                    this.onHeartbeatFrame(client, frame);
                    break;

                case FrameType.Message:
                    if (!this.onMessageFrame(client, frame, now)) return;
                    break;
            }
        }
    }

    // False if it closed the client: nothing in the chunk is read.
    private acceptChunk(client: TcpClient, data: Buffer, now: number): boolean {
        client.reading.lastInboundAt = now;

        // A TLS client on an unencrypted port. Its handshake would otherwise go into the frame
        // reader, which reads a length field of 790 bytes or more from it and waits, silently, for
        // the rest of a frame that never comes, until the idle timeout; or rejects it as an invalid
        // frame, which names neither the client's setting nor the server's.
        if (!client.receivedAny) {
            client.receivedAny = true;
            if (!(client.socket as tls.TLSSocket).encrypted && looksLikeTlsHandshake(data)) {
                this.reportTlsClientWithoutTlsPort(client);
                this.closeClient(client);
                return false;
            }
        }
        return true;
    }

    // Undefined if the bytes are no valid frames and it closed the client.
    private readFrames(client: TcpClient, data: Buffer): DecodedFrame[] | undefined {
        try {
            return client.reader.append(data);
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
            return undefined;
        }
    }

    private onHandshakeFrame(client: TcpClient, frame: FrameOf<FrameType.Handshake>): void {
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
    }

    private onHeartbeatFrame(client: TcpClient, frame: FrameOf<FrameType.Heartbeat>): void {
        // One written after the client's large messages: it has read them all.
        if (frame.pingTimestamp > client.reading.lastLargeWrittenAt) client.reading.unreadLargeBytes = 0;
        this.handlePong(client, frame.pingTimestamp);
    }

    // False if it closed the client: the rest of the chunk is not read.
    private onMessageFrame(client: TcpClient, frame: FrameOf<FrameType.Message>, now: number): boolean {
        // A Colibri client handshakes before it sends anything else, so this is no
        // Colibri client, or not one this server can serve. Each such message used to
        // log an ERROR line, and a peer that kept sending was never closed: what it
        // sent kept it from looking idle. A loop of them stalled the main thread with
        // log lines.
        if (!client.app) {
            if (this.noHandshakeWarnedAt.shouldWarn(client.address, now)) {
                this.logWarning(
                    `Closing the connection of client ${client.id} from ${client.address}: it sent a message ` +
                        `(${abbreviateName(frame.channel)} / ${abbreviateName(frame.command)}) before a handshake naming its app. ` +
                        'Logged at most once a minute per address.'
                );
            }
            this.closeClient(client);
            return false;
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
        return true;
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
            tlsAtProxy: this.proxyProtocolGate.tlsAtProxyFor(client.socket),
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
            }, MAX_FRAME_LENGTH);
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
        this.postClientMessage(client, COLIBRI_CHANNEL, 'latency', ownBytes(Buffer.from(pingTimestamp.toString(), 'utf8')));
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
        // asModelUpdate keeps the nesting that overflows JSON.stringify out of `held`. Should
        // anything else make it throw, one update is lost, not the worker and every Unity client
        // on it.
        let json: string;
        try {
            json = JSON.stringify(update.model);
        } catch (err) {
            this.logWarning(
                `Dropped a held model::update for '${update.model.id}' on channel '${update.channel}' from client ${client.id}: ` +
                    `it could not be written out again (${errorMessage(err)})`
            );
            return;
        }
        this.postClientMessage(client, update.channel, MODEL_UPDATE_COMMAND, ownBytes(Buffer.from(json, 'utf8')));
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
        this.clientsByApp.add(client.app, client);
    }

    private removeFromAppIndex(client: TcpClient): void {
        this.clientsByApp.remove(client.app, client);
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
