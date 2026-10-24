import type { Socket as SocketIoSocket, Event as SocketIoEvent } from 'socket.io';
import { Server as SocketIoServer } from 'socket.io';
import type { Server as HttpServer } from 'http';
import type { Observable } from 'rxjs';
import { Subject } from 'rxjs';

import { AppIndex } from '../core/app-index.js';
import { CONNECTION_LINE } from '../core/log-message.js';
import { MAX_PAYLOAD_DEPTH, Payload, nestsDeeperThan } from '../protocol/payload.js';
import { errorMessage } from '../core/error-message.js';
import { Service } from '../core/service.js';
import type { NetworkClient, NetworkMessage, NetworkServer } from '../protocol/network.js';
import { abbreviate } from '../hooks/connection-pool.js';
import { ADMIN_APP } from '../admin/admin-app.js';
import {
    COLIBRI_CHANNEL,
    MAX_FIELD_LENGTH,
    MAX_FRAME_LENGTH,
    PROTOCOL_ACCEPTED_COMMAND,
    PROTOCOL_REJECTED_COMMAND,
    PROTOCOL_VERSION,
    protocolAcceptance,
    protocolRejection,
} from '../protocol/protocol.js';
import type { RateLimit } from '../limits/inbound-limits.js';
import { DEFAULT_RATE_LIMIT, isLimitable } from '../limits/inbound-limits.js';
import type { TrustProxy } from '../net/trusted-proxies.js';
import { forwardedClientAddress, forwardedTls, trustNoProxy } from '../net/trusted-proxies.js';
import { normalizeAddress } from '../net/addresses.js';
import type { ClientActivity } from '../limits/client-activity.js';
import type { WebTraffic } from './web-traffic-counter.js';
import { WebTrafficCounter } from './web-traffic-counter.js';
import { WebInboundGate } from './web-inbound-gate.js';
import { aboutClient } from './about-client.js';

// How often held-back updates are passed on as a limited client's tokens refill, and finished
// episodes reported.
const RATE_LIMIT_SWEEP_MILLIS = 100;

export interface SocketIoServerOptions {
    // Per client; see InboundRateLimiter.
    rateLimit?: RateLimit;
    // The proxies whose X-Forwarded-For names the client, and whose X-Forwarded-Proto says whether it
    // used TLS; see TRUSTED_PROXIES. None if left out.
    trustProxy?: TrustProxy;
}

// The largest packet a web client may send. engine.io disconnects a client whose packet is over
// maxHttpBufferSize (1e6 bytes by default), while a TCP frame can be MAX_FRAME_LENGTH. This fits such a
// payload plus the Socket.IO envelope: the event name (the channel) and the command, each at most
// MAX_FIELD_LENGTH as on TCP, and some JSON punctuation.
const MAX_SOCKET_IO_PACKET_BYTES = MAX_FRAME_LENGTH + 2 * MAX_FIELD_LENGTH + 1024;

export interface SocketIoClient extends NetworkClient {
    socket: SocketIoSocket;
    version: string;
    // Whether it reached a trusted proxy over TLS, by the proxy's X-Forwarded-Proto (see
    // forwardedTls). Its connection to this server is in socket.handshake.secure.
    tlsAtProxy: boolean;
}

export class SocketIOServer extends Service implements NetworkServer {
    public readonly serviceName = 'SocketIO';
    public readonly groupName = 'networking';

    private ioServer!: SocketIoServer;

    private readonly clients: SocketIoClient[] = [];
    // Mirrors the Socket.IO room membership, so broadcastToApp can tell whether an app has a
    // recipient without touching the adapter or the payload. Ids rather than a count, so that a
    // message from the app's only member can early-out too.
    private readonly clientIdsByApp = new AppIndex<string>();
    private readonly clientsById = new Map<string, SocketIoClient>();
    private readonly clientStream = new Subject<SocketIoClient[]>();
    private readonly clientConnectedStream = new Subject<SocketIoClient>();
    private readonly clientDisconnectedStream = new Subject<SocketIoClient>();
    private readonly messageStream = new Subject<NetworkMessage>();

    private readonly inboundGate = new WebInboundGate({
        emit: (msg) => this.messageStream.next(msg),
        logDebug: (msg, metadata) => this.logDebug(msg, metadata),
        logWarning: (msg, metadata) => this.logWarning(msg, metadata),
    });
    private rateLimitSweep: NodeJS.Timeout | undefined;
    private trustProxy: TrustProxy = trustNoProxy;

    // See WebTraffic. Messages on the 'colibri' channel (latency pings and their echoes, protocol
    // messages) are not counted, as heartbeats are not on TCP.
    private readonly trafficCounter = new WebTrafficCounter({
        isInApp: (app, clientId) => this.clientIdsByApp.get(app)?.has(clientId) ?? false,
    });

    public start(server: HttpServer, options: SocketIoServerOptions = {}): void {
        this.inboundGate.configure(options.rateLimit ?? DEFAULT_RATE_LIMIT);
        this.trustProxy = options.trustProxy ?? trustNoProxy;
        // Never the reason the process stays alive.
        this.rateLimitSweep = setInterval(() => this.sweepRateLimit(performance.now()), RATE_LIMIT_SWEEP_MILLIS);
        this.rateLimitSweep.unref();

        this.ioServer = new SocketIoServer(server, {
            cors: {
                origin: '*'
            },
            maxHttpBufferSize: MAX_SOCKET_IO_PACKET_BYTES,
        });

        this.ioServer.on('connection', (socket) => {
            this.handleNewClient(socket);
        });

        this.logInfo('Successfully attached SocketIO to webserver');
        this.clientStream.next(this.clients);
    }

    // Tolerates never having been started: a signal during startup() must not throw here and skip
    // the shutdown steps behind it.
    public stop(): void {
        clearInterval(this.rateLimitSweep);
        if (!this.ioServer) return;

        // Not awaited, so stop() stays synchronous; the promise only reports the HTTP server closing.
        void this.ioServer.close();
        this.logInfo('Stopped SocketIO server');
    }

    private sweepRateLimit(now: number): void {
        this.inboundGate.sweep(now);
        this.trafficCounter.sample(this.clients, now);
    }

    // What the admin UI's client view shows of a web client's traffic, with its rate history if
    // `history`. The limit is only ever 'rate': there is no queue to the main thread to fall behind on.
    public activityOf(client: SocketIoClient, history = false): ClientActivity {
        const meter = this.trafficCounter.meterOf(client.id);
        const held = this.inboundGate.heldSize(client);
        return {
            in: meter?.receivedPerSecond ?? null,
            out: meter?.sentPerSecond ?? null,
            limit: held > 0 || this.inboundGate.isLimited(client) ? 'rate' : null,
            held,
            ...(history ? { history: meter?.history(performance.now()) ?? [] } : {}),
        };
    }

    public get clients$(): Observable<SocketIoClient[]> {
        return this.clientStream.asObservable();
    }

    public get clientConnected$(): Observable<NetworkClient> {
        return this.clientConnectedStream.asObservable();
    }

    public get clientDisconnected$(): Observable<NetworkClient> {
        return this.clientDisconnectedStream.asObservable();
    }

    public get currentClients(): ReadonlyArray<SocketIoClient> {
        return this.clients;
    }

    // O(1) alternative to scanning currentClients, for hooks that hold a NetworkClient or an id and
    // need the SocketIoClient to send to.
    public getClient(id: string): SocketIoClient | undefined {
        return this.clientsById.get(id);
    }

    public get messages$(): Observable<NetworkMessage> {
        return this.messageStream.asObservable();
    }


    public broadcast(msg: NetworkMessage, clients: ReadonlyArray<SocketIoClient>): void {
        const payload = this.resolvePayload(msg);
        const counted = msg.channel !== COLIBRI_CHANNEL;

        for (const client of clients) {
            client.socket.emit(msg.channel, {
                command: msg.command,
                payload
            });
            if (counted) this.trafficCounter.countDirect(client.id);
        }
    }

    // Every client of an app shares a Socket.IO room named after that app, so this
    // encodes the packet once for the whole room instead of once per recipient.
    public broadcastToApp(msg: NetworkMessage, app: string, exceptClientId?: string): void {
        // Before resolvePayload(), which JSON-parses a TCP-origin payload: a TCP-only deployment
        // would otherwise pay that per model::update with no web client to receive it.
        if (!this.hasRecipients(app, exceptClientId)) return;

        const payload = this.resolvePayload(msg);
        const room = exceptClientId ? this.ioServer.to(app).except(exceptClientId) : this.ioServer.to(app);

        room.emit(msg.channel, {
            command: msg.command,
            payload
        });
        if (msg.channel !== COLIBRI_CHANNEL) this.trafficCounter.countRoomEmit(app, exceptClientId);
    }

    public hasRecipients(app: string, exceptClientId?: string): boolean {
        return this.clientIdsByApp.hasRecipients(app, exceptClientId);
    }

    private resolvePayload(msg: NetworkMessage): unknown {
        // A TCP-origin payload is only guaranteed to be a wire string, so fall back to it if it is
        // not valid JSON. A web-origin payload already holds its value, so web-to-web costs nothing.
        try {
            return msg.payload?.asValue();
        } catch {
            return msg.payload?.asString();
        }
    }

    private handleNewClient(socket: SocketIoSocket): void {
        const peer = normalizeAddress(socket.handshake.address);
        const client = this.clientFromHandshake(socket, peer);
        if (this.refuse(client)) return;

        if (client.app !== ADMIN_APP) { // ignore colibri web interface clients
            // One line: a Socket.IO client names its app as it connects, unlike a TCP client.
            const through = client.name === peer ? '' : ` through ${peer}`;
            this.logDebug(
                `New client '${client.name}' (${client.id}, v${client.version}) connected to app "${client.app}" from ${client.name}${through}`,
                { ...aboutClient(client), ...CONNECTION_LINE }
            );
        }

        // Before any application traffic. A client tells a current server from one predating the
        // version check by waiting for this (see protocolAcceptance).
        socket.emit(COLIBRI_CHANNEL, { command: PROTOCOL_ACCEPTED_COMMAND, payload: protocolAcceptance() });

        const traffic = this.register(client);
        this.readEvents(client, traffic);

        // Only Socket.IO's own errors get here (see socket.use in readEvents).
        socket.on('error', (error: unknown) => {
            this.logError(`Socket.IO error for client ${client.id}: ${errorMessage(error)}`, false, aboutClient(client));
        });

        socket.on('disconnect', () => {
            this.handleSocketDisconnect(socket);
        });
    }

    // `peer` is the address the connection came from, normalized.
    private clientFromHandshake(socket: SocketIoSocket, peer: string): SocketIoClient {
        // An absent version becomes '' rather than undefined: the refusal below promises a string
        // clientVersion (docs/dev/protocol.md), and JSON drops an undefined field.
        const version = socket.handshake.query.version;
        // Behind a trusted proxy, the client's own address from the X-Forwarded-For of the request
        // that opened the connection. It is the client's name in colibri::clients. An IPv4 client is
        // named by its IPv4 address, also on a dual-stack WEBSERVER_HOST.
        const address = normalizeAddress(forwardedClientAddress(peer, socket.handshake.headers['x-forwarded-for'], this.trustProxy));
        return {
            id: socket.id,
            app: socket.handshake.query.app as string,
            version: typeof version === 'string' ? version : '',
            name: address,
            metadata: {},
            socket,
            tlsAtProxy: forwardedTls(peer, socket.handshake.headers['x-forwarded-proto'], this.trustProxy),
        };
    }

    // Disconnects a client that names no app or another protocol version than this server's,
    // except the admin UI, which is only warned about on a mismatch. True if it disconnected.
    private refuse(client: SocketIoClient): boolean {
        const { socket } = client;
        if (!client.app) {
            this.logError('Websocket connection has no app specified; aborting connection', false);
            socket.disconnect();
            return true;
        }

        // The admin UI is served by this same process, so it is warned about rather than refused:
        // a version check must not lock you out of your own console.
        if (client.version !== PROTOCOL_VERSION) {
            const rejection = protocolRejection(client.version);
            if (client.app === COLIBRI_CHANNEL) {
                this.logWarning(`Admin UI client ${client.id} announced protocol version '${client.version || '(none)'}'; expected v${PROTOCOL_VERSION}`);
            } else {
                this.logError(`Refusing client ${client.id} from ${client.name}: ${rejection.reason}`, false, aboutClient(client));
                socket.emit(COLIBRI_CHANNEL, { command: PROTOCOL_REJECTED_COMMAND, payload: rejection });
                // Not disconnect(true): closing the transport could truncate the rejection just queued.
                socket.disconnect();
                return true;
            }
        }
        return false;
    }

    private register(client: SocketIoClient): WebTraffic {
        const traffic = this.trafficCounter.register(client, performance.now());
        this.clients.push(client);
        this.addToAppIndex(client);
        void client.socket.join(client.app);
        this.clientConnectedStream.next(client);
        this.clientStream.next(this.clients);
        return traffic;
    }

    private readEvents(client: SocketIoClient, traffic: WebTraffic): void {
        const ignoreMalformed = this.malformedReporter(client);

        // `next` is never called, so no client event reaches Socket.IO's own listeners: a client
        // naming its event 'error' or 'disconnect' would otherwise run the handlers of
        // handleNewClient with its payload.
        client.socket.use(([channel, content]: SocketIoEvent) => {
            // socket.io-parser takes any JSON value as the event name, a number say, but every
            // handler expects a string.
            if (typeof channel !== 'string' || channel === '') {
                ignoreMalformed(`the channel must be a non-empty string, not ${typeof channel === 'string' ? 'empty' : typeof channel}`);
                return;
            }

            // An event emitted with no argument (`socket.emit('foo')`) leaves `content` undefined.
            const body = (content ?? {}) as { command?: unknown; payload?: unknown };
            if (typeof body.command !== 'string') {
                ignoreMalformed(`an event on channel '${abbreviate(channel)}' has no command`);
                return;
            }
            // Relayed, stored or logged, a payload is written out with JSON.stringify or Socket.IO's
            // encoder, which overflow the stack on deep nesting (see MAX_PAYLOAD_DEPTH).
            if (nestsDeeperThan(body.payload)) {
                ignoreMalformed(`a payload on channel '${abbreviate(channel)}' nests deeper than ${MAX_PAYLOAD_DEPTH} levels`);
                return;
            }

            if (channel !== COLIBRI_CHANNEL) traffic.meter.received += 1;

            const msg = {
                origin: client,
                channel: channel,
                command: body.command,
                payload: Payload.fromValue(body.payload)
            };
            if (isLimitable(channel, body.command)) {
                this.inboundGate.acceptLimitable(msg, body.payload, performance.now());
            } else {
                // Held-back updates first: a model::delete must not overtake an update to the same
                // object, which would bring it back.
                this.inboundGate.releaseHeld(client);
                this.messageStream.next(msg);
            }
        });
    }

    // Once per client: a client that sends one malformed event usually sends it in a loop.
    private malformedReporter(client: SocketIoClient): (reason: string) => void {
        let reportedMalformed = false;
        return (reason: string): void => {
            if (reportedMalformed) return;
            reportedMalformed = true;
            this.logError(
                `Ignoring malformed events from client '${client.name}' (${client.id}, app '${client.app}'): ${reason}. Logged once per client.`,
                false,
                aboutClient(client)
            );
        };
    }

    private handleSocketDisconnect(socket: SocketIoSocket): void {
        const removedClients: SocketIoClient[] = [];
        for (let i = this.clients.length - 1; i >= 0; i--) {
            if (this.clients[i]?.socket === socket) {
                removedClients.push(...this.clients.splice(i, 1));
            }
        }
        this.clientStream.next(this.clients);

        for (const rc of removedClients) {
            this.removeFromAppIndex(rc);
            // Before clientDisconnected$: the last state a client sent is applied even if it was
            // held back when it left.
            this.inboundGate.clientLeft(rc);
            this.trafficCounter.forget(rc.id);
            if (rc.app !== ADMIN_APP) { // ignore colibri web interface clients
                this.logDebug(`Colibri client '${rc.name}' (${rc.id}) disconnected`, { ...aboutClient(rc), ...CONNECTION_LINE });
            }
            this.clientDisconnectedStream.next(rc);
        }
    }

    private addToAppIndex(client: SocketIoClient): void {
        this.clientsById.set(client.id, client);
        this.clientIdsByApp.add(client.app, client.id);
    }

    private removeFromAppIndex(client: SocketIoClient): void {
        this.clientsById.delete(client.id);

        if (this.clientIdsByApp.remove(client.app, client.id) === 0) {
            this.trafficCounter.forgetRoom(client.app);
        }
    }
}
