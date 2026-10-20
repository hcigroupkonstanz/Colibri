import { Subject } from 'rxjs';
import { Socket, connect } from 'socket.io-client';
import { ColibriError, ProtocolMismatchError } from './ColibriError';
import { colibriCreated, colibriDisconnected, colibriHeardFrom, colibriReconnected } from './lifecycle';

/**
 * The wire protocol version this client speaks, sent in the handshake query. Must match the
 * server's `PROTOCOL_VERSION` (`src/server/modules/networking/protocol.ts`); a server refuses a
 * client that announces another version.
 */
export const PROTOCOL_VERSION = '2';

// Accept of every REST request, and Content-Type of setRestObject. colibri-server 2.x refuses a
// value sent as plain application/json. The version in it lets a reverse proxy route by Accept.
const REST_MEDIA_TYPE = `application/vnd.colibri.v${PROTOCOL_VERSION}+json`;

const COLIBRI_CHANNEL = 'colibri';
// The app name of the server's admin UI. Unrelated to the channel above, though spelt the same.
const ADMIN_APP = 'colibri';
const PROTOCOL_REJECTED_COMMAND = 'protocol::rejected';
const PROTOCOL_ACCEPTED_COMMAND = 'protocol::accepted';
const LATENCY_COMMAND = 'latency';

// How long to wait for `colibri`/`protocol::accepted` before concluding the server predates the
// version check. A 2.0.0+ server sends it immediately on connect; the window only covers an
// event-loop stall on a loaded server.
//
// Not inferred from the 100ms `latency` broadcast: 1.2.x and 1.3.x servers send it but speak v1.
const OLD_SERVER_TIMEOUT_MS = 5000;

// The protocol of every release before 2.0.0, none of which announce themselves.
const OLD_SERVER_PROTOCOL_VERSION = '1';

interface ProtocolRejection {
    reason?: string;
    serverVersion?: string;
    clientVersion?: string;
}

// The "dom" lib declares these as non-optional, but under plain Node (samples, e2e) they are
// absent. Shadowed so the types say so.
declare const window: Window | undefined;
declare const document: Document | undefined;

// The default server: the host that served the page. `typeof` rather than `window?.`, since under
// Node `window` is undeclared and reading it throws a ReferenceError.
const pageHostname = (): string =>
    typeof window !== 'undefined' ? ((window.location as Location | undefined)?.hostname ?? '') : '';

// Every scheme a server address may use, mapped to the socket and REST schemes, which have to
// agree on TLS. http(s) is accepted because a browser's address bar shows it for the same server.
const SCHEMES: Partial<Record<string, { socket: string; rest: string }>> = {
    ws: { socket: 'ws', rest: 'http' },
    http: { socket: 'ws', rest: 'http' },
    wss: { socket: 'wss', rest: 'https' },
    https: { socket: 'wss', rest: 'https' }
};

const parseServerAddress = (server: string) => {
    const address = server.trim();
    const match = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(address);
    const schemes = match ? SCHEMES[match[1].toLowerCase()] : SCHEMES.ws;
    if (!schemes) {
        throw new ColibriError(
            `Unsupported scheme in server address '${server}' - use ws://, wss://, http://, https:// or none.`
        );
    }

    // Trailing slashes come from copying an address bar; they would put the port after the slash.
    const authority = (match ? match[2] : address).replace(/\/+$/, '');
    if (authority.length === 0) {
        throw new ColibriError('Server Address missing or empty!');
    }

    // Rejected rather than dropped: the URLs are host and port only, so a path would land before
    // the port, and dropping it would connect to something other than what was asked for.
    if (/[/?#]/.test(authority)) {
        throw new ColibriError(
            `Server address '${server}' has a path or query after the host - pass only the host and, optionally, the port, e.g. 'http://example.com:9211'.`
        );
    }

    // Host, then an optional port. An IPv6 host is bracketed to tell its colons from the port's.
    const hostAndPort = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(authority);
    if (!hostAndPort) {
        throw new ColibriError(
            `Server address '${server}' is not a host, or a host and a numeric port - an IPv6 address goes in brackets.`
        );
    }

    // `at`: an optional group that did not match is undefined, which indexing's type hides.
    const portText = hostAndPort.at(2);
    return { ...schemes, host: hostAndPort[1], port: portText === undefined ? undefined : Number(portText) };
};

// colibri-server 2.x's default web port. 1.x's was 9011: they differ so that a client of one
// version does not reach a server of the other by default.
const DEFAULT_PORT = 9211;

const checkPort = (port: number) => {
    // isInteger also rejects NaN, which passes the range check below.
    if (!Number.isInteger(port)) {
        throw new ColibriError(`Port must be a whole number (1 - 65535): ${port}`);
    }
    if (port < 1 || port > 65535) {
        throw new ColibriError(`Port out of allowed range (1 - 65535): ${port}`);
    }
};

// Plain JavaScript callers, query strings and environment variables give the port as a string.
// 1.x accepted '9011', so a digit string still means that port; anything else is left for
// checkPort to refuse.
const coercePort = (port: unknown): number | undefined =>
    typeof port === 'string' && /^\s*\d+\s*$/.test(port) ? Number(port) : (port as number | undefined);

// The port may come from the address, from the argument, or from both if they agree. Two
// different ports are a mistake, and picking either would hide it.
const resolvePort = (server: string, fromAddress: number | undefined, given: number | undefined): number => {
    if (given !== undefined) checkPort(given);
    if (fromAddress === undefined) return given ?? DEFAULT_PORT;

    checkPort(fromAddress);
    if (given !== undefined && given !== fromAddress) {
        throw new ColibriError(
            `Server address '${server}' has port ${fromAddress}, but port ${given} was passed as well - give the port once.`
        );
    }
    return fromAddress;
};

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

    private oldServerTimer: ReturnType<typeof setTimeout> | undefined;
    // Once per instance, not per connection, so a reconnect does not repeat the warning.
    private hasReportedOldServer = false;
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

        const address = parseServerAddress(server);
        this.port = resolvePort(server, address.port, coercePort(port));
        this.uri = `${address.socket}://${address.host}:${this.port}`;
        // Encoded like the key in getRestUri; the server decodes it back to the handshake's app name.
        this.uriRestApi = `${address.rest}://${address.host}:${this.port}/api/store/${encodeURIComponent(app)}/`;

        // there is already an instance running
        if (Colibri.instance) throw new ColibriError('A Colibri instance already exists!');
        else Colibri.instance = this;

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

        this.socket = connect(this.uri, {
            query: { app, version: PROTOCOL_VERSION },
            transports: ['websocket']
        });
        this.socket.on('connect', this.onSocketConnect.bind(this));
        this.socket.on('disconnect', this.onSocketDisconnect.bind(this));
        this.socket.on('connect_error', this.onSocketConnectError.bind(this));
        this.socket.onAny(this.onSocketAny.bind(this));

        // latency statistics
        this.registerChannel(COLIBRI_CHANNEL, msg => {
            if (msg.command === LATENCY_COMMAND) {
                SendMessage(COLIBRI_CHANNEL, LATENCY_COMMAND, msg.payload);
            }
        });

        // Everything registered before this instance existed, in registration order.
        for (const { channel, handler, once } of pendingRegistrations.splice(0)) {
            if (once) this.registerOnce(channel, handler);
            else this.registerChannel(channel, handler);
        }
        colibriCreated(this);
    }

    private onSocketConnect() {
        console.debug(`Connected to colibri server on ${this.server}`);
        this.hasReportedOutage = false;
        this.waitForServerHello();

        // The server relays without replaying, so whatever it relayed while this client was away is
        // lost. Whoever has state to catch up on is told now. Socket.IO has already flushed what
        // was queued while disconnected, so a catch-up goes out after it.
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

    /*
     *  Detecting a server that predates the protocol version check.
     *
     *  Such a server neither refuses this client nor says what it speaks, so a current one
     *  announces itself unprompted and the missing announcement is the signal. The timer only
     *  observes; it does not gate message delivery.
     */

    private waitForServerHello() {
        if (this.hasReportedOldServer) return;

        clearTimeout(this.oldServerTimer);
        this.oldServerTimer = setTimeout(() => {
            this.onServerHelloMissing();
        }, OLD_SERVER_TIMEOUT_MS);
    }

    private stopWaitingForServerHello() {
        clearTimeout(this.oldServerTimer);
        this.oldServerTimer = undefined;
    }

    private onServerHelloMissing() {
        // A disconnected socket explains the silence by itself, and a reconnect re-arms this.
        if (!this.socket.connected) return;

        // A frozen or backgrounded tab stops draining the socket while timers keep running, so this
        // can fire ahead of the queued announcement. Wait another window.
        //
        // `typeof` rather than `document?.`: under Node `document` is undeclared, which throws a
        // ReferenceError that optional chaining does not catch.
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
            this.waitForServerHello();
            return;
        }

        this.hasReportedOldServer = true;
        this.stopWaitingForServerHello();

        const error = new ProtocolMismatchError(
            `The server did not identify itself within ${OLD_SERVER_TIMEOUT_MS / 1000}s, so it predates ` +
                `colibri-server 2.0.0 and speaks protocol v1; this client speaks v${PROTOCOL_VERSION}.`,
            // A protocol version, as in the refusal. Inferred, not received: every 2.0.0+ server
            // announces itself, and everything older speaks v1.
            OLD_SERVER_PROTOCOL_VERSION,
            PROTOCOL_VERSION,
            false
        );

        // Not disconnected: the Socket.IO envelope is the same in v1 and v2, so the connection works.
        // Tearing it down over a suspicion would turn a warning into an outage.
        console.warn(`Colibri: ${error.message} The connection still works; upgrade the server when you can.`);
        this.protocolMismatchSubject.next(error);
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
            this.stopWaitingForServerHello();
            return;
        }

        this.messageSubject.next({ channel, command, payload });
    }

    // `rejection` is optional because it comes off the wire, and a bare `protocol::rejected` must
    // still give a usable error rather than a TypeError.
    private onProtocolRejected(rejection: ProtocolRejection | undefined) {
        // The server has said what is wrong; the old-server guess five seconds later would contradict it.
        this.stopWaitingForServerHello();
        this.hasReportedOldServer = true;

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
    public async getRestObject(key: string): Promise<any> {
        const uri = this.getRestUri(key);
        if (!uri) return null;

        const response = await fetch(uri, {
            method: 'GET',
            headers: {
                Accept: REST_MEDIA_TYPE
            }
        });

        if (response.status >= 400) return null;
        else return response.json();
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
    public async setRestObject(key: string, data: unknown): Promise<boolean> {
        const uri = this.getRestUri(key);
        if (!uri) return false;

        const response = await fetch(uri, {
            method: 'PUT',
            headers: {
                Accept: REST_MEDIA_TYPE,
                'Content-Type': REST_MEDIA_TYPE
            },
            body: JSON.stringify(data)
        });

        return response.status >= 200 && response.status < 300;
    }

    /**
     * Deletes the object identified by `key` from the REST API.
     *
     * Rejects when the server cannot be reached (wrong address, server down, no network).
     * @param key REST API storage key
     * @returns true if the server deleted the value; false if `key` is empty or the server answered
     *   with any other status, such as 404 for a key that holds no value
     */
    public async deleteRestObject(key: string): Promise<boolean> {
        const uri = this.getRestUri(key);
        if (!uri) return false;

        const response = await fetch(uri, {
            method: 'DELETE',
            headers: {
                Accept: REST_MEDIA_TYPE
            }
        });

        return response.status >= 200 && response.status < 300;
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
