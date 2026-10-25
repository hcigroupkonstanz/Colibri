import { Subject } from 'rxjs';
import type { Socket } from 'socket.io-client';
import { connect } from 'socket.io-client';
import { ColibriError, ProtocolMismatchError } from './ColibriError';
import { colibriCreated, colibriDisconnected, colibriHeardFrom, colibriReconnected } from './lifecycle';
import { OldServerDetector } from './OldServerDetector';
import { RestStore } from './RestStore';
import { pageHostname, resolveServer } from './serverAddress';

/**
 * The wire protocol version this client speaks, sent in the handshake query. Must match the
 * server's `PROTOCOL_VERSION` (`src/server/modules/protocol/protocol.ts`); a server refuses a
 * client that announces another version.
 */
export const PROTOCOL_VERSION = '2';

const COLIBRI_CHANNEL = 'colibri';
// The app name of the server's admin UI. Unrelated to the channel above, though spelt the same.
const ADMIN_APP = 'colibri';
const PROTOCOL_REJECTED_COMMAND = 'protocol::rejected';
const PROTOCOL_ACCEPTED_COMMAND = 'protocol::accepted';
const LATENCY_COMMAND = 'latency';

interface ProtocolRejection {
    reason?: string;
    serverVersion?: string;
    clientVersion?: string;
}

// The "dom" lib declares `window` as always present, but it is absent under plain Node (samples,
// e2e). Shadowed so the type says so.
declare const window: Window | undefined;

export interface Message {
    channel: string;
    command: string;
    payload: unknown;
}

// Handlers given to RegisterChannel/RegisterOnce before `new Colibri()`; the constructor attaches them.
const pendingRegistrations: { channel: string; handler: (payload: Message) => void; once: boolean }[] = [];

export class Colibri {
    private static instance: Colibri | null = null;

    private readonly socket: Socket;
    private readonly messageSubject = new Subject<Message>();
    public readonly messages = this.messageSubject.asObservable();
    private readonly protocolMismatchSubject = new Subject<ProtocolMismatchError>();
    /**
     * Reports that this client and the server do not speak the same wire protocol. Two kinds,
     * told apart by {@link ProtocolMismatchError.fatal `fatal`}, each emitted at most once per
     * instance:
     *
     * - `fatal: true`: the server refused this client. The connection is closed and not retried.
     * - `fatal: false`: the server did not announce itself within 5s of connecting, so it is
     *   suspected to predate colibri-server 2.0.0. The connection stays up.
     *
     * A suspicion can be followed by a refusal, never the other way round. Nothing is replayed to
     * a late subscriber, so subscribe right after construction. Both kinds are also logged.
     */
    public readonly protocolMismatch = this.protocolMismatchSubject.asObservable();
    public readonly uri: string;
    public readonly uriRestApi: string;
    /** The port connected to: the one in the server address, else the one passed, else 9211. */
    public readonly port: number;
    private readonly restStore: RestStore;

    private readonly oldServerDetector = new OldServerDetector(
        PROTOCOL_VERSION,
        () => this.socket.connected,
        error => {
            this.protocolMismatchSubject.next(error);
        }
    );
    // Once per instance, not once per `protocol::rejected` received.
    private hasReportedRefusal = false;

    private hasConnected = false;

    // An outage runs from a failed connection attempt to the next connect.
    private hasReportedOutage = false;

    /**
     * Connects to a Colibri server. Only one instance may exist.
     * @param app the application name; clients only see each other's messages within one app
     * @param server the host, optionally after `ws://`, `wss://`, `http://` or `https://` (the
     *   secure ones mean `wss` for the socket and `https` for REST) and optionally with a port,
     *   as in `'http://example.com:9211'`; no path. Defaults to the host that served the page,
     *   and is required outside a browser.
     * @param port the server port, if the address has none; 9211 if neither does. When both have
     *   one, they must agree.
     * @throws ColibriError for an address or port this client cannot connect to, or when an
     *   instance already exists
     */
    public constructor(
        public readonly app: string,
        public readonly server: string = pageHostname(),
        port?: number
    ) {
        if (server.trim().length <= 0) {
            throw new ColibriError(
                typeof window === 'undefined'
                    ? 'Server Address missing or empty! Outside a browser there is no page to take it from, so pass it as the second argument.'
                    : 'Server Address missing or empty!'
            );
        }

        const resolved = resolveServer(app, server, port);
        this.port = resolved.port;
        this.uri = resolved.uri;
        this.uriRestApi = resolved.uriRestApi;
        this.restStore = new RestStore(key => this.getRestUri(key), PROTOCOL_VERSION);

        // there is already an instance running
        if (Colibri.instance) throw new ColibriError('A Colibri instance already exists!');
        else Colibri.instance = this;

        this.warnIfAdminApp(app);
        this.socket = this.openSocket();
        this.relayLatency();
        this.attachPendingRegistrations();
        colibriCreated(this);
    }

    private warnIfAdminApp(app: string) {
        // The server tells the admin UI from an application by this name alone. Only warned about,
        // so an app already named 'colibri' keeps working.
        if (app === ADMIN_APP) {
            console.warn(
                `Colibri: the app name '${ADMIN_APP}' is reserved for the server's admin UI, and the server ` +
                    `treats this client as one: it sends it the server's log as it is written and every ` +
                    `client's connects and disconnects, shares its messages with every open admin UI, and ` +
                    `skips the protocol version check. Give your app a name of its own.`
            );
        }
    }

    // Returns the socket instead of assigning it: the field is readonly, so only the constructor may.
    private openSocket() {
        const socket = connect(this.uri, {
            query: { app: this.app, version: PROTOCOL_VERSION },
            transports: ['websocket']
        });
        socket.on('connect', this.onSocketConnect.bind(this));
        socket.on('disconnect', this.onSocketDisconnect.bind(this));
        socket.on('connect_error', this.onSocketConnectError.bind(this));
        socket.onAny(this.onSocketAny.bind(this));
        return socket;
    }

    private relayLatency() {
        // latency statistics
        this.registerChannel(COLIBRI_CHANNEL, msg => {
            if (msg.command === LATENCY_COMMAND) {
                SendMessage(COLIBRI_CHANNEL, LATENCY_COMMAND, msg.payload);
            }
        });
    }

    private attachPendingRegistrations() {
        // Everything registered before this instance existed, in registration order.
        for (const { channel, handler, once } of pendingRegistrations.splice(0)) {
            if (once) this.registerOnce(channel, handler);
            else this.registerChannel(channel, handler);
        }
    }

    private onSocketConnect() {
        console.debug(`Connected to colibri server on ${this.server}`);
        this.hasReportedOutage = false;
        this.oldServerDetector.start();

        // The server relays without replaying, so what it relayed while this client was away is lost;
        // whoever has state to catch up on is told now. Socket.IO has already flushed its send
        // buffer, so a catch-up goes out after it.
        if (this.hasConnected) colibriReconnected(this);
        this.hasConnected = true;
    }

    // Until the next connect, sends wait in Socket.IO's buffer and go out ahead of anything a
    // catch-up sends, which is the wrong order for some of them.
    private onSocketDisconnect() {
        colibriDisconnected(this);
    }

    // Socket.IO retries silently, so a mistyped address, a server that is down and a firewall all
    // look like a slow connection. Reported once per outage, on its first failed attempt, not on
    // every retry.
    private onSocketConnectError(error: Error & { description?: unknown }) {
        if (this.hasReportedOutage) return;
        this.hasReportedOutage = true;

        // Under Node the message is only 'websocket error'; the cause (ECONNREFUSED, ENOTFOUND) is
        // the underlying error's. A browser hides it.
        const cause = (error.description as { message?: unknown } | undefined)?.message;
        const reason = typeof cause === 'string' && cause.length > 0 ? `${error.message}: ${cause}` : error.message;

        console.warn(
            `Colibri: could not connect to ${this.uri} (${reason}). ` +
                (this.socket.active
                    ? 'Retrying until it answers - check the server address and that the server is running.'
                    : 'Not retrying.')
        );
    }

    private onSocketAny(channel: string, msg: unknown) {
        colibriHeardFrom(this);
        const { command, payload } = msg as Pick<Message, 'command' | 'payload'>;

        // Colibri's own plumbing: kept off `messages` so applications need not recognize it.
        if (channel === COLIBRI_CHANNEL && command === PROTOCOL_REJECTED_COMMAND) {
            this.onProtocolRejected(payload as ProtocolRejection | undefined);
            return;
        }

        // The server announcing itself; kept off `messages` likewise.
        if (channel === COLIBRI_CHANNEL && command === PROTOCOL_ACCEPTED_COMMAND) {
            this.oldServerDetector.stop();
            return;
        }

        this.messageSubject.next({ channel, command, payload });
    }

    // `rejection` is optional because it comes off the wire, and a bare `protocol::rejected` must
    // still give a usable error rather than a TypeError.
    private onProtocolRejected(rejection: ProtocolRejection | undefined) {
        // The server has said what is wrong; the old-server guess five seconds later would contradict it.
        this.oldServerDetector.giveUp();

        // A mismatch cannot resolve itself; retrying only buries the log line that explains it.
        this.socket.io.reconnection(false);
        this.socket.disconnect();

        // A second refusal repeats the first: hang up, say nothing.
        if (this.hasReportedRefusal) return;
        this.hasReportedRefusal = true;

        const serverVersion = rejection?.serverVersion ?? 'unknown';
        const error = new ProtocolMismatchError(
            rejection?.reason ??
                `Server refused the connection: it speaks protocol v${serverVersion}, this client speaks v${PROTOCOL_VERSION}.`,
            serverVersion,
            rejection?.clientVersion ?? PROTOCOL_VERSION
        );

        console.error(
            `Colibri: ${error.message} Update colibri-web and colibri-server to matching versions. Not reconnecting.`
        );
        this.protocolMismatchSubject.next(error);
    }

    /**
     * Returns the existing Colibri instance or null if there's none yet
     * @param warnIfNotInitialized true => print Log message if Colibri has not been initialized yet
     * @returns
     */
    public static getInstance(warnIfNotInitialized: boolean = true): Colibri | null {
        if (warnIfNotInitialized && !Colibri.instance) {
            console.warn('Colibri not initialized yet! (Instance is null)');
        }
        return Colibri.instance;
    }

    /**
     * Sends a single message in the given `channel`.
     * @param channel message channel
     * @param command message command
     * @param payload message payload
     */
    public sendMessage(channel: string, command: string, payload: unknown = {}) {
        this.socket.emit(channel, {
            command,
            payload
        });
    }

    // #region Socket Events
    /**
     * Adds a `handler` function listening for messages in `channel`.
     * @param channel message channel
     * @param handler handler to be executed when a message is received
     */
    public registerChannel(channel: string, handler: (payload: Message) => void) {
        this.socket.on(channel, handler);
    }

    /**
     * Removes the `handler` function listening for messages in `channel`.
     * @param channel message channel
     * @param handler handler to be executed when a message is received
     */
    public unregisterChannel(channel: string, handler: (payload: Message) => void) {
        this.socket.off(channel, handler);
    }

    /**
     * Adds a one-time `handler` function listening for the next message in `channel`.
     * @param channel message channel
     * @param handler handler to be executed when a message is received
     */
    public registerOnce(channel: string, handler: (payload: Message) => void) {
        this.socket.once(channel, handler);
    }
    // #endregion

    // #region Rest API
    /**
     * Returns the REST API Endpoint for a given `key`, or null if the key is empty, `.` or `..`.
     * Any other key is stored under exactly that name (`#`, `?`, `/`, `%` and spaces included)
     * after surrounding whitespace and leading slashes are stripped.
     * @param key REST API storage key
     * @returns
     */
    public getRestUri(key: string): string | null {
        key = key.trim();
        while (key.startsWith('/')) key = key.substring(1);

        // A URL parser resolves a path segment of '.' or '..', percent-encoded or not, as a
        // directory step, so '..' would address the app's parent instead of a key.
        if (key.length === 0 || key === '.' || key === '..') return null;

        // Encoded because the key is one path segment: raw, '#' and '?' would cut it short, '/' would
        // split it, and '%' would not decode on the server.
        return this.uriRestApi + encodeURIComponent(key);
    }

    /**
     * Queries an object from the REST API identified by `key`.
     *
     * Rejects when the server cannot be reached (wrong address, server down, no network) or an
     * answer with a success status is not JSON.
     * @param key REST API storage key
     * @returns the stored value; or null if `key` is empty or the server answered with an error
     *   status, such as 404 for a key that was never stored. A stored `null` looks the same.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public getRestObject(key: string): Promise<any> {
        return this.restStore.getRestObject(key);
    }

    /**
     * Sets or updates an object in the REST API identified by `key`.
     *
     * Rejects when the server cannot be reached (wrong address, server down, no network) or
     * `data` cannot be serialized to JSON (circular structure, BigInt).
     * @param key REST API storage key
     * @param data JSON data to write
     * @returns true if the server stored the data; false if `key` is empty or the server answered
     *   with any other status
     */
    public setRestObject(key: string, data: unknown): Promise<boolean> {
        return this.restStore.setRestObject(key, data);
    }

    /**
     * Deletes the object identified by `key` from the REST API.
     *
     * Rejects when the server cannot be reached (wrong address, server down, no network).
     * @param key REST API storage key
     * @returns true if the server deleted the value; false if `key` is empty or the server answered
     *   with any other status, such as 404 for a key that holds no value
     */
    public deleteRestObject(key: string): Promise<boolean> {
        return this.restStore.deleteRestObject(key);
    }
    // #endregion
}

/////////////////////////////////////
///     Wrapper Functions
// (also for backward compatibility)
/////////////////////////////////////

/**
 * @see {@link Colibri.sendMessage `Colibri.sendMessage()`}
 * @returns undefined if {@link Colibri `Colibri`} has not been initialized yet
 */
export const SendMessage = (channel: string, command: string, payload: unknown = {}) =>
    Colibri.getInstance()?.sendMessage(channel, command, payload);

/**
 * @see {@link Colibri.registerChannel `Colibri.registerChannel()`}
 *
 * Works before `new Colibri()` too: the handler is attached once the instance is constructed.
 */
export const RegisterChannel = (channel: string, handler: (payload: Message) => void): void => {
    const colibri = Colibri.getInstance(false);
    if (colibri) colibri.registerChannel(channel, handler);
    else pendingRegistrations.push({ channel, handler, once: false });
};

/**
 * @see {@link Colibri.unregisterChannel `Colibri.unregisterChannel()`}
 *
 * Before `new Colibri()`, takes back a handler that {@link RegisterChannel} or
 * {@link RegisterOnce} queued.
 */
export const UnregisterChannel = (channel: string, handler: (payload: Message) => void): void => {
    const colibri = Colibri.getInstance(false);
    if (colibri) {
        colibri.unregisterChannel(channel, handler);
        return;
    }

    // Removes one registration per call, like Socket.IO's off().
    const index = pendingRegistrations.findIndex(p => p.channel === channel && p.handler === handler);
    if (index >= 0) pendingRegistrations.splice(index, 1);
};

/**
 * @see {@link Colibri.registerOnce `Colibri.registerOnce()`}
 *
 * Works before `new Colibri()` too, like {@link RegisterChannel}.
 */
export const RegisterOnce = (channel: string, handler: (payload: Message) => void): void => {
    const colibri = Colibri.getInstance(false);
    if (colibri) colibri.registerOnce(channel, handler);
    else pendingRegistrations.push({ channel, handler, once: true });
};

/**
 * @see {@link Colibri.getRestObject `Colibri.getRestObject()`}
 * @returns undefined if {@link Colibri `Colibri`} has not been initialized yet
 */
export const GetRestApi = (key: string) => Colibri.getInstance()?.getRestObject(key);

/**
 * @see {@link Colibri.setRestObject `Colibri.setRestObject()`}
 * @returns undefined if {@link Colibri `Colibri`} has not been initialized yet
 */
export const PutRestApi = (key: string, data: unknown) => Colibri.getInstance()?.setRestObject(key, data);

/**
 * @see {@link Colibri.deleteRestObject `Colibri.deleteRestObject()`}
 * @returns undefined if {@link Colibri `Colibri`} has not been initialized yet
 */
export const DeleteRestApi = (key: string) => Colibri.getInstance()?.deleteRestObject(key);
