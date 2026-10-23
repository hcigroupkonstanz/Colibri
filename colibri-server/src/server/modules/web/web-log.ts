import { CONNECTION_METADATA_KEY, LogLevel, LogMessage, Metadata, Payload, RingBuffer, Service } from '../core/index.js';
import type { NetworkMessage } from '../networking/network.js';
import { SocketIoClient, SocketIOServer } from '../networking/socket-io-server.js';
import { filter } from 'rxjs';
import { randomUUID } from 'crypto';

const LOGGING_APP = 'colibri';
const MAX_LOG_SIZE = 20000;
// Caps the history by size as well as count: a client's RemoteLogger sends whatever it logs.
export const MAX_LOG_CHARS = 8 * 1024 * 1024;

interface WebMessage {
    id: string;
    origin: string;
    level: number;
    message: string;
    group: string;
    /** When the line last occurred. */
    created: number;
    /** When the line first occurred: the same as `created` until it repeats. */
    first: number;
    count: number;
    metadata: Metadata;
}

interface LogPreferences {
    filter: string;
    levels: Set<number> | undefined;
    showBroadcastTraffic: boolean;
    /** Whether routine connect and disconnect lines (see CONNECTION_LINE) are shown. */
    showConnections: boolean;
    /** Echoed in the history, so the admin UI can tell it from the answer to an earlier request. */
    request: number | null;
}

// Merge key, computable from a LogMessage or a WebMessage. App and client are part of it: clients
// of two apps on one host share a name (their IP address) and a line need not name its client.
const messageKey = function (msg: { level: number; group: string; message: string; metadata: Metadata }): string {
    return JSON.stringify([ msg.level, msg.group, msg.message, msg.metadata.clientApp ?? null, msg.metadata.clientId ?? null ]);
};

const KNOWN_LEVELS: ReadonlySet<number> = new Set([ LogLevel.Error, LogLevel.Warn, LogLevel.Info, LogLevel.Debug ]);

// requestLog comes from any client of any app, so each field is used only if it has the expected
// type, else its default (no filter, all levels, no broadcast traffic, connection lines shown).
const parseLogPreferences = function (body: unknown): LogPreferences {
    const fields = (body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    return {
        filter: typeof fields.filter === 'string' ? fields.filter : '',
        levels: Array.isArray(fields.levels)
            ? new Set(fields.levels.filter((level): level is number => typeof level === 'number' && KNOWN_LEVELS.has(level)))
            : undefined,
        showBroadcastTraffic: fields.showBroadcastTraffic === true,
        showConnections: fields.showConnections !== false,
        request: typeof fields.request === 'number' && Number.isFinite(fields.request) ? fields.request : null
    };
};

export class WebLog extends Service {
    public serviceName = 'WebLog';
    public groupName = 'web';

    private readonly logMessages = new RingBuffer<WebMessage>(MAX_LOG_SIZE);

    // Merge index by messageKey. Holds only the entries still in logMessages (see forget), so it is
    // bounded like the history.
    private readonly recentByKey = new Map<string, WebMessage>();

    // Sum of the message lengths in logMessages, capped by MAX_LOG_CHARS.
    private logChars = 0;

    public constructor(private socketio: SocketIOServer) {
        super();
    }

    public override async init(): Promise<void> {
        super.init();

        this.socketio.messages$
            .pipe(filter(msg => msg.channel === 'colibri::log' && msg.command === 'requestLog'))
            .subscribe(networkMsg => {
                // An exception escaping a subscriber is uncaught and main.ts shuts the server down.
                try {
                    this.handleRequestLog(networkMsg);
                } catch (err) {
                    this.logError(`Ignoring requestLog from client ${networkMsg.origin?.id}: ${err instanceof Error ? err.message : String(err)}`, false);
                }
            });

        Service.output$.subscribe(this.redirectLogMessage.bind(this));
    }

    private handleRequestLog(networkMsg: NetworkMessage): void {
        const socketClient = networkMsg.origin && this.socketio.getClient(networkMsg.origin.id);
        if (!socketClient) {
            this.logError('Unkown origin requested log messages', false);
            return;
        }

        const preferences = parseLogPreferences(networkMsg.payload?.asValue());
        const { filter, request } = preferences;

        socketClient.metadata['log::filter'] = filter;
        socketClient.metadata['log::preferences'] = preferences;

        // client can't handle too many messages at once
        const clientLimit = 10000;

        // Sorted by `created` (last occurrence), where the admin UI puts a merged entry that repeats live.
        const messages = this.logMessages
            .toArray()
            .filter(msg => !filter || msg.metadata.clientApp === filter)
            .filter(msg => this.isVisibleToClient(msg.level, msg.metadata, preferences))
            .sort((a, b) => a.created - b.created)
            .slice(-clientLimit)
            .map(msg => ({ ...msg }));

        // Sent even when empty: the admin UI drops live lines between its request and this reply.
        // `at` is the server clock that stamps the lines, for a page whose own clock is off.
        this.socketio.broadcast({
            channel: 'colibri::log',
            command: 'history',
            payload: Payload.fromValue({ request, at: Date.now(), messages })
        }, [ socketClient ]);
    }

    private redirectLogMessage(log: LogMessage): void {
        // Merge into the earlier occurrence if it is still in logMessages (eviction drops it from recentByKey).
        const key = messageKey(log);
        let webMsg = this.recentByKey.get(key);

        if (webMsg) {
            webMsg.count += 1;
            webMsg.created = log.created.getTime();
        } else {
            webMsg = {
                id: randomUUID(),
                origin: log.origin,
                level: log.level,
                group: log.group,
                message: log.message,
                created: log.created.getTime(),
                first: log.created.getTime(),
                count: 0,
                metadata: log.metadata
            };
            this.pushMessage(key, webMsg);
        }

        // The history above is kept regardless (a client may request it later); no payload is built
        // unless some admin UI receives the line.
        const clients: SocketIoClient[] = [];
        for (const client of this.socketio.currentClients) {
            if (client.app !== LOGGING_APP) continue;

            const clientFilter = client.metadata['log::filter'];
            if (clientFilter && clientFilter !== log.metadata.clientApp) continue;

            const preferences = client.metadata['log::preferences'] as LogPreferences | undefined;
            if (!this.isVisibleToClient(log.level, log.metadata, preferences)) continue;

            clients.push(client);
        }

        if (clients.length === 0) return;

        // Snapshot: webMsg is mutated in place on its next repeat and Payload.fromValue() keeps the object as given.
        this.socketio.broadcast({
            channel: 'colibri::log',
            command: 'message',
            payload: Payload.fromValue({ ...webMsg })
        }, clients);
    }

    private pushMessage(key: string, webMsg: WebMessage): void {
        // Once full, push() overwrites the oldest entry, so that one leaves recentByKey first.
        if (this.logMessages.length >= MAX_LOG_SIZE) {
            const evicted = this.logMessages.at(0);
            if (evicted) this.forget(evicted);
        }

        this.logMessages.push(webMsg);
        this.recentByKey.set(key, webMsg);
        this.logChars += webMsg.message.length;

        // The newest line stays, however long: ClientLogger already cut it down.
        while (this.logChars > MAX_LOG_CHARS && this.logMessages.length > 1) {
            const evicted = this.logMessages.shift();
            if (evicted) this.forget(evicted);
        }
    }

    private forget(evicted: WebMessage): void {
        const evictedKey = messageKey(evicted);
        if (this.recentByKey.get(evictedKey) === evicted) this.recentByKey.delete(evictedKey);
        this.logChars -= evicted.message.length;
    }

    // Broadcast traffic is logged at Debug but governed only by showBroadcastTraffic, never by levels,
    // so Debug can be watched without it and vice versa. Connection lines have their own switch.
    // Without preferences (no requestLog yet): every line but broadcast traffic.
    private isVisibleToClient(level: number, metadata: Metadata, preferences: LogPreferences | undefined): boolean {
        if (metadata['broadcastTraffic'] === true) {
            return preferences?.showBroadcastTraffic === true;
        }
        if (metadata[CONNECTION_METADATA_KEY] === true && preferences?.showConnections === false) {
            return false;
        }
        return !preferences?.levels || preferences.levels.has(level);
    }
}
