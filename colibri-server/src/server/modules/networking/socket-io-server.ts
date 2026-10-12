import { Server as SocketIoServer, Socket as SocketIoSocket, Event as SocketIoEvent } from 'socket.io';
import { Server as HttpServer } from 'http';
import { Observable, Subject } from 'rxjs';

import { CONNECTION_LINE, Metadata, Payload, Service } from '../core/index.js';
import { NetworkClient, NetworkMessage, NetworkServer } from '../command-hooks/index.js';
import {
    COLIBRI_CHANNEL,
    MAX_FIELD_LENGTH,
    MAX_FRAME_LENGTH,
    PROTOCOL_ACCEPTED_COMMAND,
    PROTOCOL_REJECTED_COMMAND,
    PROTOCOL_VERSION,
    protocolAcceptance,
    protocolRejection,
} from './protocol.js';
import {
    DEFAULT_RATE_LIMIT,
    HeldUpdate,
    HeldUpdates,
    InboundRateLimiter,
    MODEL_UPDATE_COMMAND,
    RateLimit,
    asModelUpdate,
    isLimitable,
    rateLimitEndWarning,
    rateLimitStartWarning,
    warnsAtEnd,
} from './inbound-limits.js';
import { TrustProxy, forwardedClientAddress, forwardedTls, trustNoProxy } from './trusted-proxies.js';
import { ClientActivity, RATE_WINDOW_MILLIS, TrafficMeter } from './client-activity.js';

// How often held-back updates are passed on as a limited client's tokens refill, and finished
// episodes reported.
const RATE_LIMIT_SWEEP_MILLIS = 100;

// For a line about one client: the admin UI shows its app, and lists the line when it shows only
// that app. A refused client's error used to appear only in the unfiltered log.
const aboutClient = function (client: { app: string; name: string; id: string }): Metadata {
    return { clientApp: client.app, clientName: client.name, clientId: client.id };
};

export interface SocketIoServerOptions {
    // Per client; see InboundRateLimiter.
    rateLimit?: RateLimit;
    // The proxies whose X-Forwarded-For names the client, and whose X-Forwarded-Proto says whether it
    // used TLS; see TRUSTED_PROXIES. None if left out.
    trustProxy?: TrustProxy;
}

// The largest packet a web client may send. engine.io's default is 1e6 bytes, past which the
// client is disconnected outright - while a TCP client may send frames of up to MAX_FRAME_LENGTH
// (5 MiB), so a web client was cut off for sending a fifth of what a Unity client can. This fits a
// MAX_FRAME_LENGTH payload plus the Socket.IO envelope around it: the event name (the channel)
// and the command, each at most MAX_FIELD_LENGTH as on TCP, and some JSON punctuation.
const MAX_SOCKET_IO_PACKET_BYTES = MAX_FRAME_LENGTH + 2 * MAX_FIELD_LENGTH + 1024;

export interface SocketIoClient extends NetworkClient {
    socket: SocketIoSocket;
    version: string;
    // Whether it reached a trusted proxy over TLS, by the proxy's X-Forwarded-Proto (see
    // forwardedTls). Its connection to this server is in socket.handshake.secure.
    tlsAtProxy: boolean;
}

// A web client's messages, for the admin UI. What it sends is counted as it arrives. What it is
// sent through its app's room (broadcastToApp) is counted once per room, not per member, so the
// room's single encode stays a single step: the client was sent every room message since it joined,
// less those it was the one left out of.
interface WebTraffic {
    readonly meter: TrafficMeter;
    // Messages emitted to it alone (broadcast()).
    direct: number;
    // Room messages it was left out of, as their sender.
    excluded: number;
    // The room's count when it joined.
    readonly roomBase: number;
}

export class SocketIOServer extends Service implements NetworkServer {
    public readonly serviceName = 'SocketIO';
    public readonly groupName = 'networking';

    private ioServer!: SocketIoServer;

    private readonly clients: SocketIoClient[] = [];
    // Mirrors the Socket.IO room membership we join below, so broadcastToApp can answer
    // "does this app have any recipient at all?" without touching the adapter or the
    // payload. Ids rather than a plain count, so the very common "the only member of this
    // app is the client the message came from" case can early-out too.
    private readonly clientIdsByApp = new Map<string, Set<string>>();
    private readonly clientsById = new Map<string, SocketIoClient>();
    private readonly clientStream = new Subject<SocketIoClient[]>();
    private readonly clientConnectedStream = new Subject<SocketIoClient>();
    private readonly clientDisconnectedStream = new Subject<SocketIoClient>();
    private readonly messageStream = new Subject<NetworkMessage>();

    // The same per-client backstop as the TCP worker's, against a web client's runaway send loop,
    // with the same treatment of what is over it: updates held back and merged, broadcasts dropped.
    private rateLimiter = this.createRateLimiter(DEFAULT_RATE_LIMIT);
    private readonly heldUpdates = new Map<SocketIoClient, HeldUpdates>();
    private rateLimitSweep: NodeJS.Timeout | undefined;
    private trustProxy: TrustProxy = trustNoProxy;

    // See WebTraffic. Messages on the 'colibri' channel itself, the latency pings and their echoes
    // and the protocol messages, are not counted, as heartbeats are not on TCP.
    private readonly traffic = new Map<string, WebTraffic>();
    // Messages emitted to each app's room, while it has clients.
    private readonly roomEmits = new Map<string, number>();
    private trafficSampledAt = 0;

    public start(server: HttpServer, options: SocketIoServerOptions = {}): void {
        this.rateLimiter = this.createRateLimiter(options.rateLimit ?? DEFAULT_RATE_LIMIT);
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

    // Tolerates never having been started - a signal (or a crash) arriving while startup()
    // is still running must not throw here and skip the shutdown steps behind it.
    public stop(): void {
        clearInterval(this.rateLimitSweep);
        if (!this.ioServer) return;

        this.ioServer.close();
        this.logInfo('Stopped SocketIO server');
    }

    private createRateLimiter(limit: RateLimit): InboundRateLimiter<SocketIoClient> {
        const describe = (client: SocketIoClient) => `Web client ${client.id} (app '${client.app}', ${client.name})`;
        return new InboundRateLimiter<SocketIoClient>(limit, {
            started: (client) => this.logWarning(rateLimitStartWarning(describe(client), limit), aboutClient(client)),
            ended: (client, summary, left) => {
                const text = rateLimitEndWarning(describe(client), summary, left);
                if (warnsAtEnd(summary)) this.logWarning(text, aboutClient(client));
                else this.logDebug(text, aboutClient(client));
            },
        });
    }

    // A model::update or broadcast::* (see isLimitable) from a client: on at once while it is
    // under its rate limit and has nothing held back, otherwise an update is held back and merged
    // per object (see HeldUpdates) and a broadcast dropped. Mirrors TCPServerWorker, minus the
    // backlog limit: a Socket.IO message is handled as it is read, so there is no queue to bound.
    private acceptLimitable(msg: NetworkMessage & { origin: SocketIoClient }, value: unknown, now: number): void {
        const client = msg.origin;
        if (this.drainHeld(client, now) && this.rateLimiter.take(client, now)) {
            this.messageStream.next(msg);
            return;
        }

        // A broadcast, or an update the server could not apply anyway, is dropped; an update for one
        // object too many is lost (see Limited).
        const model = msg.command === MODEL_UPDATE_COMMAND ? asModelUpdate(value) : undefined;
        if (!model) {
            this.rateLimiter.record(client, now, 'dropped');
            return;
        }

        let held = this.heldUpdates.get(client);
        if (!held) {
            held = new HeldUpdates();
            this.heldUpdates.set(client, held);
        }
        this.rateLimiter.record(client, now, held.hold(msg.channel, model) ? 'held' : 'lost');
    }

    // Passes on as many of the client's held updates as its rate limit allows, oldest first.
    // True once nothing is held any more.
    private drainHeld(client: SocketIoClient, now: number): boolean {
        const held = this.heldUpdates.get(client);
        if (!held) return true;

        while (held.size > 0) {
            if (!this.rateLimiter.take(client, now)) return false;
            this.emitHeld(client, held.shift()!);
        }
        this.heldUpdates.delete(client);
        return true;
    }

    // Every held update regardless of the limit: before something from the same client that must
    // not overtake them, and when it leaves.
    private releaseHeld(client: SocketIoClient): void {
        const held = this.heldUpdates.get(client);
        if (!held) return;

        this.heldUpdates.delete(client);
        for (const update of held.takeAll()) this.emitHeld(client, update);
    }

    private emitHeld(client: SocketIoClient, update: HeldUpdate): void {
        this.messageStream.next({
            origin: client,
            channel: update.channel,
            command: MODEL_UPDATE_COMMAND,
            payload: Payload.fromValue(update.model),
        });
    }

    private sweepRateLimit(now: number): void {
        for (const client of Array.from(this.heldUpdates.keys())) this.drainHeld(client, now);
        this.rateLimiter.sweep(now);

        if (now - this.trafficSampledAt >= RATE_WINDOW_MILLIS) {
            this.trafficSampledAt = now;
            for (const client of this.clients) {
                const traffic = this.traffic.get(client.id);
                traffic?.meter.sample(now, this.sentTo(client, traffic));
            }
        }
    }

    private sentTo(client: SocketIoClient, traffic: WebTraffic): number {
        return traffic.direct + (this.roomEmits.get(client.app) ?? 0) - traffic.roomBase - traffic.excluded;
    }

    // What the admin UI's client view shows of a web client's traffic, with `history` its rate
    // history too. A web client has only the rate limit: there is no queue to the main thread to
    // fall behind on.
    public activityOf(client: SocketIoClient, history = false): ClientActivity {
        const traffic = this.traffic.get(client.id);
        const held = this.heldUpdates.get(client)?.size ?? 0;
        return {
            in: traffic?.meter.receivedPerSecond ?? null,
            out: traffic?.meter.sentPerSecond ?? null,
            limit: held > 0 || this.rateLimiter.isLimited(client) ? 'rate' : null,
            held,
            ...(history ? { history: traffic?.meter.history(performance.now()) ?? [] } : {}),
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

    // O(1) alternative to scanning currentClients, for hooks that hold a NetworkClient (or
    // just an id) and need the concrete client back to send to it.
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
            if (counted) {
                const traffic = this.traffic.get(client.id);
                if (traffic) traffic.direct += 1;
            }
        }
    }

    // Every client of an app shares a Socket.IO room named after that app, so this
    // encodes the packet once for the whole room instead of once per recipient.
    public broadcastToApp(msg: NetworkMessage, app: string, exceptClientId?: string): void {
        // Checked before resolvePayload(), which for a TCP-origin payload is a full
        // JSON.parse: a TCP-only deployment would otherwise pay a parse plus an adapter
        // encode per model::update with no web client to receive any of it.
        if (!this.hasRecipients(app, exceptClientId)) return;

        const payload = this.resolvePayload(msg);
        const room = exceptClientId ? this.ioServer.to(app).except(exceptClientId) : this.ioServer.to(app);

        room.emit(msg.channel, {
            command: msg.command,
            payload
        });
        if (msg.channel !== COLIBRI_CHANNEL) this.countRoomEmit(app, exceptClientId);
    }

    private countRoomEmit(app: string, exceptClientId: string | undefined): void {
        this.roomEmits.set(app, (this.roomEmits.get(app) ?? 0) + 1);
        if (exceptClientId === undefined || !this.clientIdsByApp.get(app)?.has(exceptClientId)) return;

        const traffic = this.traffic.get(exceptClientId);
        if (traffic) traffic.excluded += 1;
    }

    public hasRecipients(app: string, exceptClientId?: string): boolean {
        const ids = this.clientIdsByApp.get(app);
        if (!ids || ids.size === 0) return false;
        if (exceptClientId !== undefined && ids.size === 1 && ids.has(exceptClientId)) return false;
        return true;
    }

    private resolvePayload(msg: NetworkMessage): unknown {
        // Cross-transport (TCP-origin) payloads are only guaranteed to be a wire string;
        // fall back to the raw string if it doesn't happen to be valid JSON. Web-origin
        // payloads already have a resolved value here, so this costs nothing for the
        // common web-to-web relay case.
        try {
            return msg.payload?.asValue();
        } catch {
            return msg.payload?.asString();
        }
    }

    private handleNewClient(socket: SocketIoSocket): void {
        // engine.io builds the query from the URL's search params, so a value is a string or
        // absent. An absent version becomes '' rather than undefined: the refusal below
        // promises a string clientVersion (docs/protocol.md), and JSON drops an undefined
        // field altogether.
        const version = socket.handshake.query.version;
        // Behind a trusted proxy, the client's own address, from the X-Forwarded-For of the
        // request that opened the connection. It is the client's name in colibri::clients, sent
        // to the admin UI and to every client of its app.
        const peer = socket.handshake.address;
        const address = forwardedClientAddress(peer, socket.handshake.headers['x-forwarded-for'], this.trustProxy);
        const client: SocketIoClient = {
            id: socket.id,
            app: socket.handshake.query.app as string,
            version: typeof version === 'string' ? version : '',
            name: address,
            metadata: {},
            socket,
            tlsAtProxy: forwardedTls(peer, socket.handshake.headers['x-forwarded-proto'], this.trustProxy),
        };

        if (!client.app) {
            this.logError('Websocket connection has no app specified; aborting connection', false);
            socket.disconnect();
            return;
        }

        // The admin UI is served by this same process and therefore can never be out of step
        // with it, so it is warned about rather than refused - a version check that can lock
        // you out of your own console is worse than the mismatch it detects.
        if (client.version !== PROTOCOL_VERSION) {
            const rejection = protocolRejection(client.version);
            if (client.app === COLIBRI_CHANNEL) {
                this.logWarning(`Admin UI client ${client.id} announced protocol version '${client.version || '(none)'}'; expected v${PROTOCOL_VERSION}`);
            } else {
                this.logError(`Refusing client ${client.id} from ${address}: ${rejection.reason}`, false, aboutClient(client));
                socket.emit(COLIBRI_CHANNEL, { command: PROTOCOL_REJECTED_COMMAND, payload: rejection });
                // Not disconnect(true): forcing the transport shut can truncate the rejection
                // that was just queued. The unforced form writes the namespace disconnect
                // behind it on the same transport, so the client sees both, in order.
                socket.disconnect();
                return;
            }
        }

        if (client.app !== 'colibri') { // ignore colibri web interface clients
            // One line: a Socket.IO client names its app as it connects, unlike a TCP client, so
            // "waiting for app name" followed by the app, as the TCP server logs it, was noise.
            const through = address === peer ? '' : ` through ${peer}`;
            this.logDebug(
                `New client '${client.name}' (${client.id}, v${client.version}) connected to app "${client.app}" from ${address}${through}`,
                { ...aboutClient(client), ...CONNECTION_LINE }
            );
        }

        // Announced to everyone that got this far, before any application traffic. A client
        // waiting for this is how it tells a current server from one predating the version
        // check, which cannot announce itself - see protocolAcceptance.
        socket.emit(COLIBRI_CHANNEL, { command: PROTOCOL_ACCEPTED_COMMAND, payload: protocolAcceptance() });

        const traffic: WebTraffic = {
            meter: new TrafficMeter(performance.now()),
            direct: 0,
            excluded: 0,
            roomBase: this.roomEmits.get(client.app) ?? 0,
        };
        this.traffic.set(client.id, traffic);
        this.clients.push(client);
        this.addToAppIndex(client);
        void socket.join(client.app);
        this.clientConnectedStream.next(client);
        this.clientStream.next(this.clients);

        socket.use(([channel, content]: SocketIoEvent, next) => {
            // An event emitted with no argument at all (`socket.emit('foo')`) leaves
            // `content` undefined; reading `.command` off it used to throw, and while
            // Socket.IO catches that synchronously it still drops the client.
            const body = (content ?? {}) as { command?: unknown; payload?: unknown };
            if (typeof body.command !== 'string') {
                this.logError(`Ignoring malformed event on channel '${channel}' from client ${client.id}: no command`, false, aboutClient(client));
                next();
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
                this.acceptLimitable(msg, body.payload, performance.now());
            } else {
                // Held-back updates first: a model::delete must not arrive ahead of an update
                // to the same object and have that update bring it back.
                this.releaseHeld(client);
                this.messageStream.next(msg);
            }
            next();
        });

        socket.on('error', error => {
            this.logError(JSON.stringify(error), false);
        });

        socket.on('disconnect', () => {
            this.handleSocketDisconnect(socket);
        });
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
            this.releaseHeld(rc);
            this.rateLimiter.forget(rc);
            this.traffic.delete(rc.id);
            if (rc.app !== 'colibri') { // ignore colibri web interface clients
                this.logDebug(`Colibri client '${rc.name}' (${rc.id}) disconnected`, { ...aboutClient(rc), ...CONNECTION_LINE });
            }
            this.clientDisconnectedStream.next(rc);
        }
    }

    private addToAppIndex(client: SocketIoClient): void {
        this.clientsById.set(client.id, client);

        let ids = this.clientIdsByApp.get(client.app);
        if (!ids) {
            ids = new Set();
            this.clientIdsByApp.set(client.app, ids);
        }
        ids.add(client.id);
    }

    private removeFromAppIndex(client: SocketIoClient): void {
        this.clientsById.delete(client.id);

        const ids = this.clientIdsByApp.get(client.app);
        if (!ids) return;

        ids.delete(client.id);
        if (ids.size === 0) {
            this.clientIdsByApp.delete(client.app);
            this.roomEmits.delete(client.app);
        }
    }
}
