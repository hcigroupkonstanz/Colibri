import { Observable, merge } from 'rxjs';
import { Payload, Service } from '../core/index.js';

export interface NetworkMessage {
    origin?: NetworkClient;
    channel: string;
    command: string;
    payload?: Payload;
}

export interface NetworkClient {
    id: string;
    app: string;
    name: string;
    version: string;
    metadata: Record<string, unknown>;
}

// What a transport may do with a message for a client that is not keeping up with what it is sent.
// - 'relay', the default: traffic relayed between clients, the latest of which is all that counts.
//   It may be dropped for a recipient too far behind (see TCPServerWorker.writeToClient).
// - 'reply': the server's answer to one client's own request, such as the models a model::request
//   asked for. Nothing would ever send it again, so it is queued rather than dropped.
export type Delivery = 'relay' | 'reply';

export abstract class NetworkServer {
    public abstract get currentClients(): ReadonlyArray<NetworkClient>;
    public abstract get messages$(): Observable<NetworkMessage>;
    public abstract get clientConnected$(): Observable<NetworkClient>;
    public abstract get clientDisconnected$(): Observable<NetworkClient>;
    public abstract broadcast(message: NetworkMessage, clients: ReadonlyArray<NetworkClient>, delivery?: Delivery): void;

    // Optional fast path for "broadcast to every client of one app": transports that can
    // group clients server-side (Socket.IO rooms) encode the packet once for the whole
    // group instead of once per recipient. Transports without such a grouping simply don't
    // implement this, and ConnectionPool falls back to the per-client broadcast() above.
    //
    // Implementations must early-out on an app with no recipient *before* touching
    // message.payload - resolving a payload across transports costs a JSON parse or
    // stringify, and every client connect/disconnect broadcasts to app 'colibri', which
    // in practice has clients on exactly one of the two transports.
    public broadcastToApp?(message: NetworkMessage, app: string, exceptClientId?: string): void;
}

export type MessageHandler = (message: NetworkMessage) => void;

// Past this many clients in one app, the pool warns that the app may be shared by accident. A
// typical app has a handful of devices plus a browser or two; separate projects that all kept the
// same App Name (a sample's default, say) end up as one app of dozens of clients instead.
export const DEFAULT_APP_CLIENT_WARNING_THRESHOLD = 8;

// The app the admin UI joins. However many are open, they are not an application's clients.
const ADMIN_APP = 'colibri';

// Colibri's own channels: 'colibri' (latency replies, protocol messages) and 'colibri::*' (the
// client list, and the log requests WebLog takes straight off the Socket.IO server). Messages on
// them are plumbing, whichever hook does or does not handle them.
const COLIBRI_CHANNEL = 'colibri';
const COLIBRI_CHANNEL_PREFIX = 'colibri::';

// How many distinct (app, channel, command) combinations the pool warns about as unhandled before
// it says it stops - a bound on the memory behind "once per combination", and on the log, for a
// client that makes up a new command for every message.
export const MAX_UNHANDLED_COMMAND_WARNINGS = 1000;

// A channel or command may be up to 64 KiB. Only this much of one is remembered or logged, so the
// bound above bounds memory too; two names that only differ further on count as one.
const MAX_NAME_IN_WARNING = 200;

const abbreviate = function (name: string): string {
    return name.length > MAX_NAME_IN_WARNING ? `${name.slice(0, MAX_NAME_IN_WARNING)}...` : name;
};

interface WildcardHandler {
    predicate: (message: NetworkMessage) => boolean;
    handler: MessageHandler;
}

export class ConnectionPool extends Service {
    public serviceName = 'ConnectionPool';
    public groupName = 'colibri';

    // See DEFAULT_APP_CLIENT_WARNING_THRESHOLD; 0 turns the warning off.
    public appClientWarningThreshold = DEFAULT_APP_CLIENT_WARNING_THRESHOLD;
    // Apps warned about since they last had appClientWarningThreshold clients or fewer, so the
    // warning is given once each time an app grows past the threshold, not once per client.
    private readonly appsOverThreshold = new Set<string>();

    private readonly servers: NetworkServer[];
    // Maintained from clientConnected$/clientDisconnected$ so emit() can find a client's
    // owning server in O(1) instead of an O(servers * clients) scan-and-find.
    private readonly serverByClientId = new Map<string, NetworkServer>();
    // Same source, keyed by app: the broadcast() fallback for a transport without
    // broadcastToApp resolves its recipients from here instead of scanning that
    // transport's entire client list per broadcast.
    private readonly clientsByApp = new Map<string, Set<NetworkClient>>();
    // The client object each id was last reported connected as. A transport may report the
    // same id connected again in another app (a TCP re-handshake); the object it replaces has
    // to leave its app's Set, which only this lookup can find.
    private readonly clientById = new Map<string, NetworkClient>();

    // Every command-hook used to subscribe to the `messages$` getter below independently,
    // each rebuilding its own merge() of every transport's messages$ - N subscribers meant
    // N independent merge/filter chains evaluated per message. Now there is exactly one
    // merge() subscription (in the constructor), dispatching into these handler lists:
    // handlersByCommand gives hooks that only care about an exact command O(1) routing,
    // and wildcardHandlers covers the few that need a channel filter or command prefix.
    private readonly handlersByCommand = new Map<string, MessageHandler[]>();
    private readonly wildcardHandlers: WildcardHandler[] = [];

    // Per app, the "channel \0 command" pairs already warned about as unhandled, and how many
    // that is across every app (see MAX_UNHANDLED_COMMAND_WARNINGS). An app's entries go when its
    // last client leaves, so the next run of an app that still sends them is told again.
    private readonly unhandledWarned = new Map<string, Set<string>>();
    private unhandledWarnedCount = 0;
    // Set once the count reached the bound and that was said; cleared when apps leaving bring it
    // back under the bound.
    private unhandledWarningsStopped = false;

    public get clientConnected$(): Observable<NetworkClient> {
        return merge(...this.servers.map(c => c.clientConnected$));
    }

    public get clientDisconnected$(): Observable<NetworkClient> {
        return merge(...this.servers.map(c => c.clientDisconnected$));
    }

    public get currentClients(): NetworkClient[] {
        return this.servers.flatMap(c => c.currentClients);
    }

    public constructor(...servers: NetworkServer[]) {
        super();
        this.servers = servers;

        for (const connection of servers) {
            connection.clientConnected$.subscribe(client => {
                const previous = this.clientById.get(client.id);
                if (previous) {
                    this.removeFromAppIndex(previous);
                }
                this.clientById.set(client.id, client);
                this.serverByClientId.set(client.id, connection);
                this.addToAppIndex(client);
            });
            connection.clientDisconnected$.subscribe(client => {
                this.clientById.delete(client.id);
                this.serverByClientId.delete(client.id);
                this.removeFromAppIndex(client);
            });
        }

        merge(...servers.map(c => c.messages$)).subscribe(message => this.dispatch(message));
    }

    // Exact-command dispatch, e.g. ModelSynchronization's 'model::update' handler - the
    // busiest message in an object-sync server.
    public onCommand(command: string, handler: MessageHandler): void {
        let handlers = this.handlersByCommand.get(command);
        if (!handlers) {
            handlers = [];
            this.handlersByCommand.set(command, handlers);
        }
        handlers.push(handler);
    }

    // For subscribers whose filter isn't a single exact command (a channel check, or a
    // command prefix like 'broadcast::*') - still one shared dispatch loop, just without
    // the further command-indexed lookup.
    public onMessage(predicate: (message: NetworkMessage) => boolean, handler: MessageHandler): void {
        this.wildcardHandlers.push({ predicate, handler });
    }

    private dispatch(message: NetworkMessage): void {
        let handled = false;

        const handlers = this.handlersByCommand.get(message.command);
        if (handlers) {
            handled = true;
            for (const handler of handlers) this.runHandler(handler, message);
        }
        for (const wildcard of this.wildcardHandlers) {
            if (this.runWildcardHandler(wildcard, message)) handled = true;
        }

        if (!handled) this.reportUnhandled(message);
    }

    // Every handler runs on input straight off the network, and a synchronous throw out of the
    // merge() subscription above is not contained: RxJS rethrows it asynchronously, it reaches
    // the process-wide uncaughtException handler, and that shuts the whole server down. Caught
    // here, one handler failing on one malformed message costs exactly that - the other handlers
    // still see the message, and the next message is dispatched as normal. The payload is left
    // out of the log line on purpose: it can be megabytes.
    private runHandler(handler: MessageHandler, message: NetworkMessage): void {
        try {
            handler(message);
        } catch (err) {
            this.logHandlerError(message, err);
        }
    }

    // Whether the wildcard handler took the message: its predicate matched (or threw, which is
    // reported as the handler's error, not as a message nobody handles).
    private runWildcardHandler(wildcard: WildcardHandler, message: NetworkMessage): boolean {
        try {
            if (!wildcard.predicate(message)) return false;
            wildcard.handler(message);
        } catch (err) {
            this.logHandlerError(message, err);
        }
        return true;
    }

    private logHandlerError(message: NetworkMessage, err: unknown): void {
        const origin = message.origin ? `client ${message.origin.id} ('${message.origin.name}', app '${message.origin.app}')` : 'an unknown client';
        this.logError(
            `Dropped a message (${message.channel} / ${message.command}) from ${origin}: a handler threw ` +
                (err instanceof Error ? (err.stack ?? err.message) : String(err)),
            false
        );
    }

    // A message no hook handles reaches nobody: the server relays only broadcast::* and the model
    // commands. Sent with SendMessage(channel, 'myCommand', ...) - an easy mistake to make, and the
    // natural way to try messaging the other clients - it used to vanish with nothing logged at
    // all, so all anybody saw was that it never arrived. Said once per app, channel and command,
    // not per message: a client making that mistake usually makes it in a loop.
    private reportUnhandled(message: NetworkMessage): void {
        const app = message.origin?.app ?? '';
        // The admin UI's own requests, and Colibri's channels, are answered by whatever owns them -
        // WebLog takes 'colibri::log' straight off the Socket.IO server, for one.
        if (app === ADMIN_APP || message.channel === COLIBRI_CHANNEL || message.channel.startsWith(COLIBRI_CHANNEL_PREFIX)) return;

        const channel = abbreviate(message.channel);
        const command = abbreviate(message.command);
        let warned = this.unhandledWarned.get(app);
        const key = `${channel}\u0000${command}`;
        if (warned?.has(key)) return;

        const name = message.origin ? `Client '${message.origin.name}' (${message.origin.id}, app '${app}')` : 'A client';
        const text =
            `${name} sent '${command}' on channel '${channel}', which the server does not handle: it reached no other ` +
            `client. Only broadcast::<type> messages (e.g. 'broadcast::${command}') and model::update / model::delete are ` +
            'relayed to the other clients of the app. Logged once per app, channel and command.';

        if (this.unhandledWarnedCount >= MAX_UNHANDLED_COMMAND_WARNINGS) {
            if (!this.unhandledWarningsStopped) {
                this.unhandledWarningsStopped = true;
                this.logWarning(
                    `Clients have sent ${MAX_UNHANDLED_COMMAND_WARNINGS} different commands the server does not handle; ` +
                        'no more are reported until some of their apps have no client left.'
                );
            }
            return;
        }

        if (!warned) {
            warned = new Set();
            this.unhandledWarned.set(app, warned);
        }
        warned.add(key);
        this.unhandledWarnedCount += 1;
        this.logWarning(text);
    }


    public broadcast(message: NetworkMessage, app = message.origin?.app): void {
        for (const connection of this.servers) {
            if (app && connection.broadcastToApp) {
                connection.broadcastToApp(message, app, message.origin?.id);
                continue;
            }

            if (!app) {
                connection.broadcast(message, connection.currentClients);
                continue;
            }

            const clients = this.clientsForApp(app, connection, message.origin?.id);
            // Skipping the call rather than passing an empty list matters: a transport's
            // broadcast() may serialize the payload (or ship it across a worker boundary)
            // before it ever looks at the recipient list.
            if (clients.length === 0) continue;

            connection.broadcast(message, clients);
        }
    }

    // Answers one client's own request: delivered as a reply, which is never dropped for being
    // behind (see Delivery).
    public emit(message: NetworkMessage, client: NetworkClient): void {
        this.serverByClientId.get(client.id)?.broadcast(message, [ client ], 'reply');
    }

    private clientsForApp(app: string, connection: NetworkServer, excludeClientId?: string): NetworkClient[] {
        const candidates = this.clientsByApp.get(app);
        if (!candidates) return [];

        const clients: NetworkClient[] = [];
        for (const client of candidates) {
            if (client.id === excludeClientId) continue;
            if (this.serverByClientId.get(client.id) !== connection) continue;
            clients.push(client);
        }
        return clients;
    }

    private addToAppIndex(client: NetworkClient): void {
        let clients = this.clientsByApp.get(client.app);
        if (!clients) {
            clients = new Set();
            this.clientsByApp.set(client.app, clients);
        }
        clients.add(client);
        this.checkAppSize(client.app, clients.size);
    }

    private removeFromAppIndex(client: NetworkClient): void {
        const clients = this.clientsByApp.get(client.app);
        if (!clients) return;

        clients.delete(client);
        if (clients.size <= this.appClientWarningThreshold) {
            this.appsOverThreshold.delete(client.app);
        }
        if (clients.size === 0) {
            this.clientsByApp.delete(client.app);
            this.forgetUnhandledWarnings(client.app);
        }
    }

    private forgetUnhandledWarnings(app: string): void {
        const warned = this.unhandledWarned.get(app);
        if (!warned) return;

        this.unhandledWarnedCount -= warned.size;
        this.unhandledWarned.delete(app);
        if (this.unhandledWarnedCount < MAX_UNHANDLED_COMMAND_WARNINGS) this.unhandledWarningsStopped = false;
    }

    // Every message in an app is relayed to each of its other clients, so the server's work grows
    // with the square of an app's size: in a load test, 60 clients in one app at only 3 objects x
    // 30 Hz took the server to seconds of latency, where the same clients split into apps of four
    // were no trouble at all. Nothing else would tell anyone why - every client is connected and
    // nothing is refused - so this is said in the log, counted across both transports.
    private checkAppSize(app: string, size: number): void {
        if (this.appClientWarningThreshold <= 0 || size <= this.appClientWarningThreshold) return;
        if (app === ADMIN_APP || this.appsOverThreshold.has(app)) return;

        this.appsOverThreshold.add(app);
        this.logWarning(
            `App '${app}' now has ${size} clients, more than ${this.appClientWarningThreshold} (APP_CLIENT_WARNING_THRESHOLD). ` +
                'Every message is relayed to every other client of the same app, so the server\'s work grows with the square of ' +
                'an app\'s size. If separate projects are sharing this app by accident - e.g. all kept the same default App Name - ' +
                'give each project an app name of its own.'
        );
    }
}