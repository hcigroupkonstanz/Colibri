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

    private readonly proxyProtocolGate = new ProxyProtocolGate({
        logDebug: (msg) => this.logDebug(msg),
        logWarning: (msg) => this.logWarning(msg),
    });

    // waiting for client to specify app name
    private readonly waitingClients = new Map<string, TcpClient>();
    // properly connected clients
    private readonly clients = new Map<string, TcpClient>();
    // clients grouped by app, so 'm:broadcastToApp' resolves its recipients without scanning
    // every connected client
    private readonly clientsByApp = new AppIndex<TcpClient>();

    private heartbeatInterval: NodeJS.Timeout | undefined;

    private readonly inboundGate = new InboundGate({
        postMessage: (channel, content) => this.postMessage(channel, content),
        logDebug: (msg) => this.logDebug(msg),
        logWarning: (msg) => this.logWarning(msg),
    });

    private readonly idleWatch = new IdleWatch({
        handleSocketDisconnect: (client) => this.handleSocketDisconnect(client),
        logDebug: (msg) => this.logDebug(msg),
        logWarning: (msg) => this.logWarning(msg),
    });

    // Not used by closeClient, which ends the socket with its refusal frame itself.
    private readonly clientWriter = new ClientWriter({
        logWarning: (msg) => this.logWarning(msg),
    });

    // performance.now() of the last TrafficMeter sample of the clients.
    private trafficSampledAt = 0;

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

        // An exception escaping this subscriber would take the worker thread, and with it the whole
        // TCP transport, down while HTTP and Socket.IO keep serving. One bad message costs only itself.
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

    // Answers TCPServerProxy.clientActivity() with a report on every handshaked client. Posted only on
    // request, so with no admin UI page open the counting is the only cost.
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

    // Callable before start() (an 'm:stop' racing startup). Destroys the sockets itself rather than
    // relying on the terminate() that usually follows, so a stop without one leaks no connections.
    public stop(): void {
        clearInterval(this.heartbeatInterval);
        this.server?.close();
        this.tlsPort.stop();

        for (const client of [...this.clients.values(), ...this.waitingClients.values()]) {
            client.socket.destroy();
        }
        // Also those still in their TLS handshake, yet to start one, or yet to send a PROXY protocol header.
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
            // An unrepresentable frame (channel or command over 64 KiB, or a body over MAX_FRAME_LENGTH)
            // is dropped alone: sent anyway, this server's own FrameReader would reject it.
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
        // Kernel dead-peer detection for a socket with nothing in flight, such as one waiting for its
        // handshake. A handshaked client gets a heartbeat every 100 ms, so keepalive never probes it;
        // IdleWatch.endIdleClients covers that case.
        socket.setKeepAlive(true, KEEPALIVE_INITIAL_DELAY_MILLIS);

        const tcpClient = createTcpClient(id, socket, address);
        this.waitingClients.set(tcpClient.id, tcpClient);

        socket.on('data', (data) => {
            this.inboundHandler.handleSocketData(tcpClient, data);
        });

        socket.on('error', (error) => {
            this.handleSocketError(tcpClient, error);
        });

        // 'close' fires exactly once however the socket ends, unlike 'end', which never fires when
        // a client vanishes without sending FIN.
        socket.on('close', () => {
            clearTimeout(tcpClient.closeTimer);
            this.handleSocketDisconnect(tcpClient);
        });

        if (alreadyRead.length > 0) this.inboundHandler.handleSocketData(tcpClient, alreadyRead);
    }

    // Ends a connection from this side. The client leaves every index now, not when 'close' arrives,
    // up to CLOSE_GRACE_MILLIS later. end(finalPacket) queues that frame ahead of the FIN; the timer
    // destroys the socket of a peer that never closes its side, else 'close' clears it.
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

        // A peer that closed abruptly (EPIPE as much as ECONNRESET) is not an error of this server.
        if (code && PEER_GONE_ERRORS.has(code)) {
            this.logDebug(`Lost the connection to ${who}: ${error.message}`, CONNECTION_LINE);
        } else {
            this.logError(`Socket error on ${who}: ${error.message}`, false);
        }

        // No handleSocketDisconnect here: 'close' always follows 'error' and does the cleanup.
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
        // Ahead of clientDisconnected$, so the main thread still knows the client: the last state it
        // sent is applied even if it was held back when it left.
        this.inboundGate.clientLeft(client);
        this.postMessage('clientDisconnected$', { id: client.id });
    }

    private removeFromAppIndex(client: TcpClient): void {
        this.clientsByApp.remove(client.app, client);
    }

    // Only handshaked clients. colibri-unity counts a session as connected from the first frame it
    // decodes, so nothing is written to a client before its handshake is accepted (one refused for its
    // protocol version gets only protocol::rejected), or it would fire OnConnected and then ProtocolMismatch.
    // An accepted client's first frame is whichever comes first of its client::connected, a message
    // relayed to its app, and the next heartbeat.
    // Answers to its own model::request or client::request come after its client::connected: the
    // main thread handles its clientConnected$ before anything it sends.
    // A client whose earlier heartbeat is still queued is skipped; see ClientWriter.writeTickHeartbeat.
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
