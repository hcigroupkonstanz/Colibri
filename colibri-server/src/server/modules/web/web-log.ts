import { CONNECTION_METADATA_KEY, LogLevel, LogMessage, Metadata, Payload, RingBuffer, Service } from '../core/index.js';
import { NetworkMessage } from '../command-hooks/index.js';
import { SocketIoClient, SocketIOServer } from '../networking/socket-io-server.js';
import { filter } from 'rxjs';
import { randomUUID } from 'crypto';

const LOGGING_APP = 'colibri';
const MAX_LOG_SIZE = 20000;

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

// What makes two log lines "the same" for merging; WebMessage copies all of it verbatim from
// the LogMessage, so an entry's key can be recomputed from either. The app and the client are
// part of it: the clients of two apps on one host share a name (their IP address), and a line
// about a client need not name it ("Colibri client 10.0.0.5 disconnected"), so the same line
// about two clients used to become one entry, counted together and shown under the first only.
const messageKey = function (msg: { level: number; group: string; message: string; metadata: Metadata }): string {
    return JSON.stringify([ msg.level, msg.group, msg.message, msg.metadata.clientApp ?? null, msg.metadata.clientId ?? null ]);
};

const KNOWN_LEVELS: ReadonlySet<number> = new Set([ LogLevel.Error, LogLevel.Warn, LogLevel.Info, LogLevel.Debug ]);

// requestLog is accepted from any Socket.IO client of any app, so its payload is whatever
// that client chose to send. Each field is taken only if it has the expected type and is
// otherwise left at its default (no filter, all levels, no broadcast traffic, connection lines
// shown, as before the switch existed): `levels: 1`
// used to reach `new Set(1)` and throw, `levels: 'x'` became Set {'x'} and silently hid
// every level, and a non-string `filter` silently hid every message.
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

    // Exact-match index for merging repeats of the same (level, group, message), independent of
    // how much unrelated log traffic interleaves between occurrences - a positional lookback over
    // logMessages (the old approach) missed most repeats under any real amount of other traffic,
    // since the previous occurrence would already have scrolled past the lookback window.
    //
    // Holds exactly the entries still in logMessages (see pushMessage), so it is bounded by
    // MAX_LOG_SIZE too. It used to keep every key ever logged, each pinning its evicted
    // message: 100k distinct lines left 100k entries behind a 20k-entry history.
    private readonly recentByKey = new Map<string, WebMessage>();

    public constructor(private socketio: SocketIOServer) {
        super();
    }

    public override async init(): Promise<void> {
        super.init();

        this.socketio.messages$
            .pipe(filter(msg => msg.channel === 'colibri::log' && msg.command === 'requestLog'))
            .subscribe(networkMsg => {
                // RxJS rethrows an exception from a subscriber asynchronously, where it is an
                // uncaught exception and main.ts shuts the server down - so nothing a client
                // sends may escape from here.
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

        // Sorted by `created`, the time a line last occurred, which is also where the admin UI
        // puts a merged entry when it repeats live. In buffer order (first occurrences) a merged
        // entry's time jumped backwards, and a reload reordered the page.
        const messages = this.logMessages
            .toArray()
            .filter(msg => !filter || msg.metadata.clientApp === filter)
            .filter(msg => this.isVisibleToClient(msg.level, msg.metadata, preferences))
            .sort((a, b) => a.created - b.created)
            .slice(-clientLimit)
            .map(msg => ({ ...msg }));

        // One message, and sent even when empty: the admin UI ignores live lines from asking until
        // this arrives, since those were filtered by its previous preferences. It used to be one
        // event per line, 10,000 of them for a full history. `at` is this server's clock, which
        // stamps the lines, for a page whose own clock is off.
        this.socketio.broadcast({
            channel: 'colibri::log',
            command: 'history',
            payload: Payload.fromValue({ request, at: Date.now(), messages })
        }, [ socketClient ]);
    }

    private redirectLogMessage(log: LogMessage): void {
        // group identical messages together, as long as the earlier occurrence is still in
        // logMessages (an evicted one has already been dropped from recentByKey)
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

        // History above is kept regardless (a client may request it later), but a single
        // pass over currentClients decides the recipients, and building the broadcast
        // payload is skipped entirely when no admin UI is connected to receive it.
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

        // Snapshot, not a reference: webMsg is a merge target that gets mutated in place on its
        // next repeat, and Payload.fromValue() stores whatever it's given verbatim - passing the
        // live object would let a later merge silently rewrite what an earlier broadcast for this
        // same entry sends.
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
            if (evicted) {
                const evictedKey = messageKey(evicted);
                if (this.recentByKey.get(evictedKey) === evicted) this.recentByKey.delete(evictedKey);
            }
        }

        this.logMessages.push(webMsg);
        this.recentByKey.set(key, webMsg);
    }

    // Broadcast/sync traffic is governed exclusively by showBroadcastTraffic, never by levels,
    // even though it's always logged at Debug: lets an admin watch Debug output without sync
    // spam, or watch sync spam without unrelated Debug noise. Connection lines are hidden by
    // their own switch, and otherwise shown at their level like any other line. Without
    // preferences (no requestLog yet): every line but sync traffic.
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
