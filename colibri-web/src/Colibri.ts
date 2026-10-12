import { Subject } from 'rxjs';
import { Socket, connect } from 'socket.io-client';
import { ColibriError, ProtocolMismatchError } from './ColibriError';
import { colibriCreated, colibriDisconnected, colibriHeardFrom, colibriReconnected } from './lifecycle';

/**
 * The wire protocol this client speaks, announced in the Socket.IO handshake query. Must
 * match `PROTOCOL_VERSION` in the server's `src/server/modules/networking/protocol.ts`; a
 * server speaking anything else refuses the connection rather than downgrading.
 */
export const PROTOCOL_VERSION = '2';

const COLIBRI_CHANNEL = 'colibri';
// The app name the server's admin UI connects with. Not the channel above, though spelt the same.
const ADMIN_APP = 'colibri';
const PROTOCOL_REJECTED_COMMAND = 'protocol::rejected';
const PROTOCOL_ACCEPTED_COMMAND = 'protocol::accepted';
const LATENCY_COMMAND = 'latency';

/**
 * How long to wait for the server to announce itself before concluding it predates the protocol
 * version check.
 *
 * A 2.0.0+ server sends `colibri`/`protocol::accepted` immediately on connect, before any
 * application traffic, so this is not a race - it is waiting for something that either comes
 * straight away or is never coming at all. The window is this generous only to survive an
 * event-loop stall on a loaded server.
 *
 * Deliberately not inferred from the 100ms `latency` broadcast, which looks like the same signal
 * and is not: that was added in colibri-server 1.2.0, so every 1.2.x and 1.3.x server sends it
 * while still speaking the old protocol. Verified against the published 1.1.1 and 1.3.1 images.
 */
const OLD_SERVER_TIMEOUT_MS = 5000;

/** What a server that never announced itself is speaking, since every release before 2.0.0 did. */
const OLD_SERVER_PROTOCOL_VERSION = '1';

interface ProtocolRejection {
    reason?: string;
    serverVersion?: string;
    clientVersion?: string;
}

// `window` and `document` are declared globally as non-optional by the "dom" lib, but
// colibri-web also runs under plain Node (samples, e2e); shadow them here so the types
// reflect that they're genuinely absent outside a browser.
declare const window: Window | undefined;
declare const document: Document | undefined;

// The default server: the host that served the page. `typeof` rather than `window?.`, for the
// reason given in onServerHelloMissing - under Node, `window` was never declared at all, so
// reading it is a ReferenceError rather than undefined, and that escaped the constructor instead
// of the ColibriError that says what is actually missing.
const pageHostname = (): string =>
    typeof window !== 'undefined' ? ((window.location as Location | undefined)?.hostname ?? '') : '';

// Every scheme a server address may be written with, mapped to the pair this client needs: the
// socket and the REST API have to agree on whether the connection is encrypted. http(s) is here
// because it is what a browser's address bar shows for the very same server.
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

    // A trailing slash is what copying a URL out of an address bar gives you; left in, it put
    // the port after the slash.
    const authority = (match ? match[2] : address).replace(/\/+$/, '');
    if (authority.length === 0) {
        throw new ColibriError('Server Address missing or empty!');
    }

    // The URLs built from this are the host, the port and nothing else, so a path used to land in
    // front of the port ('wss://host/colibri:9011') - and the admin UI's own URL ends in '/log'.
    // Dropping it instead would quietly connect somewhere other than what was asked for.
    if (/[/?#]/.test(authority)) {
        throw new ColibriError(
            `Server address '${server}' has a path or query after the host - pass only the host and, optionally, the port, e.g. 'http://example.com:9211'.`
        );
    }

    // Host, then an optional port, as in any URL; an IPv6 host has to be in brackets to tell its
    // colons from the port's. The port used to be kept as part of the host, so the admin UI's
    // 'http://host:9011' connected to 'ws://host:9011:9011'.
    const hostAndPort = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(authority);
    if (!hostAndPort) {
        throw new ColibriError(
            `Server address '${server}' is not a host, or a host and a numeric port - an IPv6 address goes in brackets.`
        );
    }

    // `at`, because an optional group that did not match is undefined, which indexing's type hides.
    const portText = hostAndPort.at(2);
    return { ...schemes, host: hostAndPort[1], port: portText === undefined ? undefined : Number(portText) };
};

// colibri-server 2.x's default web port. 1.x's was 9011: the defaults differ so that a client of one
// version does not reach a server of the other by them.
const DEFAULT_PORT = 9211;

const checkPort = (port: number) => {
    // Number.isInteger also rejects NaN, which every comparison lets through - and
    // `Number(process.argv[3])` is exactly how a sample ends up passing one.
    if (!Number.isInteger(port)) {
        throw new ColibriError(`Port must be a whole number (1 - 65535): ${port}`);
    }
    if (port < 1 || port > 65535) {
        throw new ColibriError(`Port out of allowed range (1 - 65535): ${port}`);
    }
};

// Plain JavaScript callers - and anything read from a query string or an environment variable -
// can pass the port as a numeric string. 1.x accepted '9011' (its range checks coerced it), so a
// string of digits still means that port; anything else is left for checkPort to refuse.
const coercePort = (port: unknown): number | undefined =>
    typeof port === 'string' && /^\s*\d+\s*$/.test(port) ? Number(port) : (port as number | undefined);

// The port may come from the address, from the constructor's argument, or from both if they
// agree. Two different ports are a mistake, and picking either would hide it.
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

// Handlers given to RegisterChannel/RegisterOnce before `new Colibri()`, attached by the
// constructor. Module-level rather than static, since there is no instance to hang them on yet.
const pendingRegistrations: { channel: string; handler: (payload: Message) => void; once: boolean }[] = [];

export class Colibri {
    private static instance: Colibri | null = null;

    private readonly socket: Socket;
    private readonly messageSubject = new Subject<Message>();
    public readonly messages = this.messageSubject.asObservable();
    private readonly protocolMismatchSubject = new Subject<ProtocolMismatchError>();
    /**
     * Reports that this client and the server do not speak the same wire protocol. There are two
     * kinds, told apart by {@link ProtocolMismatchError.fatal `fatal`}, and each is emitted **at
     * most once per instance**:
     *
     * - `fatal: true` - the server **refused** this client. The connection is dead and will not
     *   be retried, so this is the only notification an application gets.
     * - `fatal: false` - the server did not announce itself within 5s of connecting, so it is
     *   **suspected** to predate colibri-server 2.0.0. The connection stays up and keeps working;
     *   this is a warning to upgrade the server, not a reason to tear anything down.
     *
     * A suspicion can be followed by a refusal (say, the server is replaced by a newer one while
     * this client is connected), but never the other way round. Nothing is replayed to a late
     * subscriber, so subscribe right after construction; either kind is also logged, so the
     * error is not lost without a subscriber.
     */
    public readonly protocolMismatch = this.protocolMismatchSubject.asObservable();
    public readonly uri: string;
    public readonly uriRestApi: string;
    /** The port connected to: the one in the server address, else the one passed, else 9211. */
    public readonly port: number;

    private oldServerTimer: ReturnType<typeof setTimeout> | undefined;
    // Once per instance, not once per connection: a server does not get newer between two
    // reconnects, and repeating the warning on every one would bury it in its own noise.
    private hasReportedOldServer = false;
    // Likewise for a refusal, which is otherwise reported once per `protocol::rejected` received.
    private hasReportedRefusal = false;

    // Whether any connect has happened yet, so that the next one is known to be a reconnect.
    private hasConnected = false;

    // Whether the current outage - from a failed connection attempt to the next connect - has
    // been reported yet.
    private hasReportedOutage = false;

    /**
     * Connects to a Colibri server. Only one instance may exist.
     * @param app the application name; clients only see each other's messages within one app
     * @param server the host, optionally after `ws://`, `wss://`, `http://` or `https://` (the
     *   secure ones mean `wss` for the socket and `https` for the REST API) and optionally with a
     *   port, as in `'http://example.com:9211'`; nothing after the host and port. Defaults to the
     *   host that served the page, and is required outside a browser.
     * @param port the server port, if the address does not have one; 9211 if neither does. When
     *   both have one, they must agree.
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

        // Only ws(s):// used to be recognised, so 'https://host' became 'ws://https://host:9011'.
        const address = parseServerAddress(server);
        this.port = resolvePort(server, address.port, coercePort(port));
        this.uri = `${address.socket}://${address.host}:${this.port}`;
        // Encoded, like the key in getRestUri: the server decodes each path segment back to the
        // very name the socket's handshake carries, so the two still name the same app.
        this.uriRestApi = `${address.rest}://${address.host}:${this.port}/api/store/${encodeURIComponent(app)}/`;

        // there is already an instance running
        if (Colibri.instance) throw new ColibriError('A Colibri instance already exists!');
        else Colibri.instance = this;

        // The server tells the admin UI from an application by this name alone, so an app called
        // 'colibri' connects - and is treated - as an admin UI, with nothing else to show for it.
        // Only warned about: an app already relying on it keeps working as it did.
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

        // Everything registered before this instance existed - through the wrappers below, and so
        // through Sync and RegisterModelSync - in the order it was registered.
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

        // The server relays, it does not replay: whatever it relayed while this client was away
        // never reached it, so whoever has state to catch up on is told now. Socket.IO has
        // already sent what this client queued while disconnected, so a catch-up sees that too.
        if (this.hasConnected) colibriReconnected(this);
        this.hasConnected = true;
    }

    // From here until the next connect, whatever is sent waits in Socket.IO's buffer - and goes out
    // on that connect ahead of anything a catch-up sends, which is the wrong order for some of it.
    private onSocketDisconnect() {
        colibriDisconnected(this);
    }

    // Socket.IO retries a failed connection by itself, for as long as it takes, and said nothing
    // about it: a mistyped address, a server that is down and a firewall all looked like a
    // connection that was merely slow. Reported once per outage, on its first failed attempt -
    // not on every retry, which comes every few seconds for as long as the outage lasts.
    private onSocketConnectError(error: Error & { description?: unknown }) {
        if (this.hasReportedOutage) return;
        this.hasReportedOutage = true;

        // Under Node the message is only 'websocket error', and what went wrong (ECONNREFUSED,
        // ENOTFOUND) is the underlying error's; a browser hides that, and has only the message.
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
     *  The check is server-side, so a server too old to have it neither refuses this client nor
     *  says what it speaks. A current server therefore announces itself unprompted, and the
     *  absence of that announcement is the signal. Nothing here gates message delivery: the timer
     *  only observes, and ordinary traffic neither sets nor clears it.
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

        // A frozen or backgrounded tab stops draining the socket while timers keep their own
        // schedule, so on resume this can fire ahead of anything already queued. Waiting another
        // window costs nothing and removes the likeliest false positive there is.
        //
        // `typeof` rather than `document?.` - optional chaining does not save you from an
        // identifier that was never declared, and under Node (samples, e2e) this would be a
        // ReferenceError rather than undefined.
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
            this.waitForServerHello();
            return;
        }

        this.hasReportedOldServer = true;
        this.stopWaitingForServerHello();

        const error = new ProtocolMismatchError(
            `The server did not identify itself within ${OLD_SERVER_TIMEOUT_MS / 1000}s, so it predates ` +
                `colibri-server 2.0.0 and speaks protocol v1; this client speaks v${PROTOCOL_VERSION}.`,
            // A protocol version, like the refusal path reports - not the '<2.0.0' release range
            // the message describes. Inferred rather than received, but not a guess: the
            // announcement is sent by every 2.0.0+ server, and everything older speaks v1.
            OLD_SERVER_PROTOCOL_VERSION,
            PROTOCOL_VERSION,
            false
        );

        // Not disconnected, and deliberately so: the Socket.IO envelope did not change between
        // v1 and v2, so this connection works. Tearing it down over a suspicion would turn a
        // warning into an outage.
        console.warn(`Colibri: ${error.message} The connection still works; upgrade the server when you can.`);
        this.protocolMismatchSubject.next(error);
    }

    private onSocketAny(channel: string, msg: unknown) {
        colibriHeardFrom(this);
        const { command, payload } = msg as Pick<Message, 'command' | 'payload'>;

        if (channel === COLIBRI_CHANNEL && command === PROTOCOL_REJECTED_COMMAND) {
            this.onProtocolRejected(payload as ProtocolRejection | undefined);
            return;
        }

        // The server identifying itself, which is the whole point of the old-server check.
        // Kept off `messages` for the same reason as the rejection: Colibri's own plumbing.
        if (channel === COLIBRI_CHANNEL && command === PROTOCOL_ACCEPTED_COMMAND) {
            this.stopWaitingForServerHello();
            return;
        }

        this.messageSubject.next({ channel, command, payload });
    }

    // Kept off `messages` deliberately: this is Colibri's own plumbing, and surfacing it as
    // an ordinary message would leave every application to recognize it for itself.
    // Typed optional on purpose: the rejection comes off the wire, so a server that sends a
    // bare `protocol::rejected` with no body must still produce a usable error rather than a
    // TypeError that hides the real problem.
    private onProtocolRejected(rejection: ProtocolRejection | undefined) {
        // The server has just told us exactly what is wrong, so the guess that would otherwise
        // land five seconds later would only contradict it.
        this.stopWaitingForServerHello();
        this.hasReportedOldServer = true;

        // A mismatch cannot resolve itself, so retrying only produces a reconnect loop that
        // buries the one log line explaining what is wrong.
        this.socket.io.reconnection(false);
        this.socket.disconnect();

        // A second refusal can only repeat the first, so it still hangs up but says nothing.
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
     * Returns the REST API Endpoint for a given `key`, or null if the key is empty - or is `.` or
     * `..`, which a URL cannot carry as a name. Any other key is stored under exactly that name,
     * `#`, `?`, `/`, `%` and spaces included, after surrounding whitespace and leading slashes are
     * stripped.
     * @param key REST API storage key
     * @returns
     */
    public getRestUri(key: string): string | null {
        key = key.trim();
        while (key.startsWith('/')) key = key.substring(1);

        // A URL parser resolves a path segment of '.' or '..' - percent-encoded or not - as a
        // directory step, so '..' would address the app's parent instead of a key.
        if (key.length === 0 || key === '.' || key === '..') return null;

        // Encoded, since the key is a single path segment: written in as it was, a '#' or '?' cut
        // the key short (the rest became a fragment or a query), a '/' split it into a path the
        // server has no route for, and a '%' made a URL the server could not decode.
        return this.uriRestApi + encodeURIComponent(key);
    }

    /**
     * Queries an object from the REST API identified by `key`.
     *
     * Not every failure resolves to null: when the server cannot be reached at all (a wrong
     * address, the server down, no network), `fetch` rejects, and so does this - typically with a
     * `TypeError` - as it does when the server's answer is not JSON. Catch it where that matters.
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
                'Content-Type': 'application/json'
            }
        });

        if (response.status >= 400) return null;
        else return response.json();
    }

    /**
     * Sets or updates an object in the REST API identified by `key`.
     *
     * Not every failure resolves to false: when the server cannot be reached at all (a wrong
     * address, the server down, no network), `fetch` rejects, and so does this - typically with a
     * `TypeError` - as it does when `data` cannot be turned into JSON (a circular structure, a
     * BigInt). Catch it where that matters.
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
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
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
 * Works before `new Colibri()` too: the handler is then attached as soon as the instance is
 * constructed. This used to do nothing at all in that case, which also left every `Sync.receive*`
 * made before `new Colibri()` listening to nothing.
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
 * {@link RegisterOnce} was still holding on to.
 */
export const UnregisterChannel = (channel: string, handler: (payload: Message) => void): void => {
    const colibri = Colibri.getInstance(false);
    if (colibri) {
        colibri.unregisterChannel(channel, handler);
        return;
    }

    // One per call, like Socket.IO's own off(): a handler registered twice is unregistered twice.
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
