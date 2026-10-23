import type { Observable } from 'rxjs';
import { merge } from 'rxjs';
import { Service } from '../core/service.js';
import type { NetworkClient, NetworkMessage, NetworkServer } from '../protocol/network.js';

export type MessageHandler = (message: NetworkMessage) => void;

// Past this many clients in one app, the pool warns that the app may be shared by accident, e.g.
// separate projects that all kept the same default App Name. A typical app has a handful of devices
// plus a browser or two.
export const DEFAULT_APP_CLIENT_WARNING_THRESHOLD = 8;

// The app the admin UI joins. Not an application's clients, so exempt from the size and
// unhandled-command warnings.
const ADMIN_APP = 'colibri';

// Colibri's own channels: 'colibri' (latency pings and echoes, protocol messages) and 'colibri::*' (client
// list, log requests that WebLog takes straight off the Socket.IO server). Never reported as unhandled.
const COLIBRI_CHANNEL = 'colibri';
const COLIBRI_CHANNEL_PREFIX = 'colibri::';

// Bound on the distinct (app, channel, command) combinations warned about as unhandled, so a client
// that invents a new command per message cannot grow the memory or the log without limit.
export const MAX_UNHANDLED_COMMAND_WARNINGS = 1000;

// A channel or command can be up to 65535 bytes (MAX_FIELD_LENGTH). Only this much is kept or logged;
// names that only differ after it count as one.
const MAX_NAME_IN_WARNING = 200;

export const abbreviate = function (name: string): string {
    return name.length > MAX_NAME_IN_WARNING ? `${name.slice(0, MAX_NAME_IN_WARNING)}...` : name;
};

interface WildcardHandler {
    predicate: (message: NetworkMessage) => boolean;
    handler: MessageHandler;
}

export class ConnectionPool extends Service {
    public serviceName = 'ConnectionPool';
    public groupName = 'colibri';

    // 0 disables the warning.
    public appClientWarningThreshold = DEFAULT_APP_CLIENT_WARNING_THRESHOLD;
    // Apps warned about since they last had appClientWarningThreshold clients or fewer: one warning
    // per growth past the threshold, not per client.
    private readonly appsOverThreshold = new Set<string>();

    private readonly servers: NetworkServer[];
    // The next three are maintained from clientConnected$/clientDisconnected$.
    // Owning server of a client, for emit() and clientsForApp().
    private readonly serverByClientId = new Map<string, NetworkServer>();
    // Recipients for the broadcast() fallback, so it does not scan a transport's whole client list.
    private readonly clientsByApp = new Map<string, Set<NetworkClient>>();
    // The client object each id was last reported as. A transport may report an id connected again in
    // another app (TCP re-handshake), and the object it replaces has to leave its app's Set.
    private readonly clientById = new Map<string, NetworkClient>();

    // The constructor's single merge() subscription dispatches into these. handlersByCommand routes an
    // exact command by lookup; wildcardHandlers covers channel filters and command prefixes.
    private readonly handlersByCommand = new Map<string, MessageHandler[]>();
    private readonly wildcardHandlers: WildcardHandler[] = [];

    // Per app, the "channel \0 command" keys already warned about as unhandled, and their count across
    // all apps (see MAX_UNHANDLED_COMMAND_WARNINGS). An app's entries go when its last client leaves,
    // so its next run is warned again.
    private readonly unhandledWarned = new Map<string, Set<string>>();
    private unhandledWarnedCount = 0;
    // Set once the bound was reached and logged; cleared when the count falls back under it.
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

    // Exact-command dispatch, e.g. 'model::update', the busiest message in an object-sync server.
    public onCommand(command: string, handler: MessageHandler): void {
        let handlers = this.handlersByCommand.get(command);
        if (!handlers) {
            handlers = [];
            this.handlersByCommand.set(command, handlers);
        }
        handlers.push(handler);
    }

    // For a filter that is not one exact command (a channel check, a prefix like 'broadcast::*').
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

        if (!handled) {
            // Contained like a handler (runHandler): it reads the message too.
            try {
                this.reportUnhandled(message);
            } catch (err) {
                this.logHandlerError(message, err);
            }
        }
    }

    // Handlers run on input from the network. A throw out of the merge() subscription reaches the
    // uncaughtException handler and shuts the server down, so each handler is contained: a malformed
    // message fails one handler, not the others or later messages.
    // The payload stays out of the log line: it can be megabytes.
    private runHandler(handler: MessageHandler, message: NetworkMessage): void {
        try {
            handler(message);
        } catch (err) {
            this.logHandlerError(message, err);
        }
    }

    // Whether the handler took the message: its predicate matched, or threw (logged as a handler
    // error, not as unhandled).
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

    // The server relays only broadcast::* and the model commands, so a message no hook handles (e.g.
    // SendMessage(channel, 'myCommand', ...) meant for the other clients) reaches nobody. Warned once
    // per app, channel and command: a client making this mistake usually makes it in a loop.
    private reportUnhandled(message: NetworkMessage): void {
        const app = message.origin?.app ?? '';
        // Answered by whatever owns them, e.g. WebLog for 'colibri::log'.
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
            // Not called with an empty list: a transport's broadcast() may serialize the payload or
            // ship it across a worker boundary before it looks at the recipients.
            if (clients.length === 0) continue;

            connection.broadcast(message, clients);
        }
    }

    // Answer to one client's own request, sent as a 'reply' (see Delivery).
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

    // A relayed message goes to all other clients of its app, so server work grows with the square of
    // the app's size. Nothing is refused, so nothing else says why latency grows. Counted across both
    // transports.
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