import * as net from 'net';
import { AppIndex } from '../../core/app-index.js';
import { errorMessage } from '../../core/error-message.js';
import { CONNECTION_LINE } from '../../core/log-message.js';
import type { WorkerMessage } from '../../core/worker/worker-message.js';
import { WorkerService } from '../../core/worker/worker-service.js';
import * as threads from 'worker_threads';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import {
    MAX_FRAME_LENGTH,
    encodeHeartbeatFrame,
    encodeMessageFrame,
} from '../../protocol/protocol.js';
import { ClientWriter } from './client-writer.js';
import { CLOSE_GRACE_MILLIS } from './end-refused.js';
import { IdleWatch } from './idle-watch.js';
import { InboundGate } from './inbound-gate.js';
import { InboundHandler } from './inbound-handler.js';
import { KEEPALIVE_INITIAL_DELAY_MILLIS } from './keepalive.js';
import { TlsPort } from './tls-port.js';
import { createTcpClient } from './tcp-client.js';
import type { TcpClient } from './tcp-client.js';
import { fellBackToIPv4, hostPort, ipv4OnlyWarning, listenHost, normalizeAddress } from '../../net/addresses.js';
import { RATE_WINDOW_MILLIS } from '../../limits/client-activity.js';
import { toBuffer } from '../../protocol/to-buffer.js';
import { NOTHING_READ, ProxyProtocolGate } from './proxy-protocol-gate.js';
import type { ConnectionHandler } from './proxy-protocol-gate.js';
import { PEER_GONE_ERRORS, errorCode, tcpSocketOf } from './socket-errors.js';
import type {
    TcpClientActivityReport,
    TcpServerOptions,
    TcpTlsCredentials,
    WireNetworkMessage,
} from '../worker-messages.js';
import { TCP_SERVER_WORKER_ROLE } from '../worker-messages.js';

export const TCP_SERVER_WORKER = fileURLToPath(import.meta.url);

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

    // Every client message for the main thread's hooks is posted through it; configure() sets its
    // limits.
    private readonly inboundGate = new InboundGate({
        postMessage: (channel, content) => this.postMessage(channel, content),
        logDebug: (msg) => this.logDebug(msg),
        logWarning: (msg) => this.logWarning(msg),
    });

    // Ends the clients that have gone quiet; configure() sets its timeout.
    private readonly idleWatch = new IdleWatch({
        handleSocketDisconnect: (client) => this.handleSocketDisconnect(client),
        logDebug: (msg) => this.logDebug(msg),
        logWarning: (msg) => this.logWarning(msg),
    });

    // Relayed messages, replies and heartbeats go through it; closeClient ends the socket with its refusal directly.
    private readonly clientWriter = new ClientWriter({
        logWarning: (msg) => this.logWarning(msg),
    });

    // When the clients' message rates were last sampled; see TrafficMeter.
    private trafficSampledAt = 0;

    // Reads what every client sends; handleConnection passes it each socket's data.
    private readonly inboundHandler = new InboundHandler(
        {
            waitingClients: this.waitingClients,
            clients: this.clients,
            clientsByApp: this.clientsByApp,
            proxyProtocolGate: this.proxyProtocolGate,
            inboundGate: this.inboundGate,
        },
        {
            closeClient: (client, finalPacket) => this.closeClient(client, finalPacket),
            postMessage: (channel, content) => this.postMessage(channel, content),
            logDebug: (msg, metadata) => this.logDebug(msg, metadata),
            logWarning: (msg) => this.logWarning(msg),
            logError: (msg, printStacktrace) => this.logError(msg, printStacktrace),
        }
    );

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
        this.inboundGate.configure(options);
        this.idleWatch.configure(options);
        this.tlsPort.configure(options.tls);
        this.proxyProtocolGate.configure(options);
    }

    // Switches the TLS port to a renewed certificate; TlsPort.useTlsCredentials has the details.
    public useTlsCredentials(credentials: TcpTlsCredentials): void {
        this.tlsPort.useTlsCredentials(credentials);
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
        this.inboundGate.tick(now);

        this.idleWatch.tick(now, this.clients, this.waitingClients);

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
                limit: this.inboundGate.limitOf(client, now),
                held: this.inboundGate.heldSize(client),
                ...(history ? { history: client.traffic.history(now, wallNow) } : {}),
            });
        }
        const report: TcpClientActivityReport = { request, clients };
        this.postMessage('clientActivity$', report as unknown as { [key: string]: unknown });
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
            this.clientWriter.writeToClient(client, packet, reply);
        }
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
        // keepalive from ever probing it; the idle timeout in IdleWatch.endIdleClients covers that case.
        socket.setKeepAlive(true, KEEPALIVE_INITIAL_DELAY_MILLIS);

        const tcpClient = createTcpClient(id, socket, address);
        this.waitingClients.set(tcpClient.id, tcpClient);

        socket.on('data', (data) => {
            this.inboundHandler.handleSocketData(tcpClient, data);
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

        if (alreadyRead.length > 0) this.inboundHandler.handleSocketData(tcpClient, alreadyRead);
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
        this.inboundGate.clientLeft(client);
        this.postMessage('clientDisconnected$', { id: client.id });
    }

    private removeFromAppIndex(client: TcpClient): void {
        this.clientsByApp.remove(client.app, client);
    }

    // Only clients whose handshake was accepted. colibri-unity counts a session as connected from
    // the first frame it decodes, so heartbeating a client still waiting for its handshake to be
    // checked made one this server was about to refuse fire OnConnected first, and
    // ProtocolMismatch a moment later. Nothing else needed the early ones: a waiting client's echo
    // was discarded (InboundHandler.handlePong) anyway.
    //
    // So nothing at all is written to a client before its handshake is accepted: it is neither
    // heartbeated nor in any app's recipients. A client refused for its protocol version is sent
    // protocol::rejected and nothing else; one cut off for a malformed frame, nothing at all. An
    // accepted one is sent, first, whichever of these comes first - any of them means "connected",
    // which is all colibri-unity needs:
    // - its own colibri::clients / client::connected, which ClientBroadcast sends the whole app,
    //   the joiner included, once the main thread has the clientConnected$ posted from
    //   InboundHandler.assignApp - usually first, a few milliseconds after acceptance;
    // - another client's broadcast::* or model message relayed to the app: assignApp adds the
    //   client to the app's recipients here at once, before the main thread knows about it, so
    //   with other TCP clients in the app this can arrive ahead of client::connected;
    // - the next heartbeat, within 100 ms.
    // Answers to its own model::request or client::request come after client::connected, since the
    // main thread handles its clientConnected$ before anything it sends.
    //
    // A client with an earlier heartbeat still waiting in its socket is skipped; see
    // ClientWriter.writeTickHeartbeat.
    private handleHeartbeat(): void {
        const packet = encodeHeartbeatFrame(process.hrtime.bigint());
        for (const client of this.clients.values()) {
            this.clientWriter.writeTickHeartbeat(client, packet);
        }
    }
}

if (!threads.isMainThread && (threads.workerData as { role?: string } | null)?.role === TCP_SERVER_WORKER_ROLE) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const server = new TCPServerWorker();
}
