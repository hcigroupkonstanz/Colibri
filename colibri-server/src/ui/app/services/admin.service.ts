import { DestroyRef, Injectable, Signal, effect, inject, signal, untracked } from '@angular/core';
import { SocketIOService } from './socketio.service';

/** The channel the pages read server data on. See docs/protocol.md, Admin UI channel. */
export const ADMIN_CHANNEL = 'colibri::admin';

/** The topics a page subscribes to. ClientService asks for 'latency', which is request only, itself. */
export type AdminTopic = 'server' | 'clients' | 'models' | 'model';

/** What every snapshot carries besides its data. */
export interface Snapshot {
    /** The number of the request or subscribe it answers. */
    request: number | null;
    /** The server's Date.now() when it was taken: ages are computed from it, not the browser's clock. */
    at: number;
}

export type SettingValue = string | number | boolean | string[];

export interface TlsInfo {
    names: string;
    issuer: string;
    selfSigned: boolean;
    validFrom: number;
    validTo: number;
    fingerprint256: string;
}

export interface VoiceStatus {
    listening: boolean;
    recording: boolean;
    samplingRate: number;
    clients: number;
}

export interface BuildInfo {
    /** The full hash of the commit it was built from, null if the build did not record one. */
    commit: string | null;
    /** Whether colibri-server had uncommitted changes then. */
    dirty: boolean;
    builtAt: number | null;
}

export interface ServerSnapshot extends Snapshot {
    version: string;
    build: BuildInfo;
    protocolVersion: string;
    node: string;
    startedAt: number;
    /** Seconds. */
    uptime: number;
    /** The settings in effect, by the variables that set them. */
    settings: Record<string, SettingValue>;
    tls: TlsInfo | null;
    /**
     * TLS that ends at a trusted proxy in front of the server. `web`: a web client or admin page
     * connected now, this one included, reached the proxy over TLS, by its X-Forwarded-Proto.
     * `tcp`: TCP_TLS_AT_PROXY applies, with TCP_PROXY_PROTOCOL, so Unity clients through the proxy
     * reached it over TLS, as the operator declared.
     */
    tlsAtProxy: { web: boolean; tcp: boolean };
    voice: VoiceStatus | null;
    counts: {
        tcpClients: number;
        webClients: number;
        adminPages: number;
        apps: number;
        models: number;
        modelApps: number;
        modelChannels: number;
        deletedModels: number;
        storeApps: number;
        storeKeys: number;
    };
}

export type LoadLimit = 'rate' | 'backlog';

export interface ClientRow {
    id: string;
    app: string;
    /** The handshake name of a TCP client, the address of a web client. */
    name: string;
    transport: 'tcp' | 'web';
    version: string;
    /** Whether its connection to the server is encrypted. */
    tls: boolean;
    /** Whether it reached a trusted proxy over TLS: a web client by the proxy's X-Forwarded-Proto, a TCP client by TCP_TLS_AT_PROXY. */
    tlsAtProxy: boolean;
    address: string;
    connectedAt: number;
    /** Median round trip over the last second, in ms. */
    latency: number | null;
    /** Messages per second, null in a client's first second or while the TCP worker is slow to answer. */
    in: number | null;
    out: number | null;
    limit: LoadLimit | null;
    /** Objects with updates held back. */
    held: number;
    /** In the first snapshot of a subscription: its rates in each second of the 122 before `at`, oldest first, as [in, out]. */
    history?: [number, number][];
    truncated?: true;
}

export interface ClientsSnapshot extends Snapshot {
    clients: ClientRow[];
    total: number;
    adminPages: number;
}

export interface LatencySnapshot extends Snapshot {
    /** Each client's round trips taken in the 122 s before `at`, not at `at`, oldest first, as [server time, ms]. */
    clients: { id: string; samples: [number, number][] }[];
    total: number;
    /** Each second's median at the mean time of its samples, in place of the samples, for many clients. */
    medians: boolean;
}

export interface ModelsQuery {
    app: string;
    channel: string;
    filter: string;
    offset: number;
    limit: number;
}

export interface ChannelSummary {
    app: string;
    channel: string;
    models: number;
    deleted: number;
    truncated?: true;
}

export interface ModelRow {
    app: string;
    channel: string;
    id: string;
    fields: number;
    /** Compact JSON size, null until the server had the budget to measure it. */
    bytes: number | null;
    updatedAt: number;
    truncated?: true;
}

export interface DeletedRow {
    app: string;
    channel: string;
    id: string;
    deletedAt: number;
    truncated?: true;
}

export interface ModelsSnapshot extends Snapshot {
    query: ModelsQuery;
    channels: ChannelSummary[];
    channelsTotal: number;
    models: ModelRow[];
    total: number;
    deleted: DeletedRow[];
    deletedTotal: number;
    tombstoneSeconds: number;
}

export interface ModelSnapshot extends Snapshot {
    app: string;
    channel: string;
    id: string;
    found: boolean;
    deletedAt?: number;
    fields?: number;
    bytes?: number;
    updatedAt?: number;
    json?: string;
    truncated?: boolean;
}

export type AdminQuery = Record<string, string | number>;

export interface FeedOptions {
    /** What to ask for; null for nothing at the moment. Asked for again whenever it changes. */
    query?: () => AdminQuery | null;
    /** Whether the server sends it again every second. On by default. */
    live?: () => boolean;
}

/** One topic as a page shows it. */
export interface AdminFeed<T extends Snapshot> {
    /** The latest answer to the latest question, or null before the first. */
    readonly data: Signal<T | null>;
    /** Whether the answer to the latest question is still on its way. */
    readonly loading: Signal<boolean>;
    /** Asks again now. */
    refresh(): void;
}

class Feed<T extends Snapshot> implements AdminFeed<T> {
    readonly data = signal<T | null>(null);
    readonly loading = signal(false);

    /** The latest request sent: answers to earlier ones are dropped. */
    latest = 0;
    query: AdminQuery | null = null;
    live = false;
    /** Whether the server holds a subscription for it. */
    subscribed = false;

    constructor(readonly topic: AdminTopic, private readonly service: AdminService) {}

    refresh(): void {
        this.service.ask(this);
    }
}

/**
 * Reads the server's admin data on colibri::admin, for the page that shows it. A page asks for a
 * topic once, or subscribes to have it again every second; it asks again after a reconnect, since
 * the server forgets every subscription when the connection goes. All of it is read only.
 */
@Injectable({
    providedIn: 'root'
})
export class AdminService {
    private readonly socketio = inject(SocketIOService);

    // One page shows a topic at a time, as the server keeps one subscription per topic and page.
    private readonly feeds = new Map<AdminTopic, Feed<Snapshot>>();
    private lastRequest = 0;

    constructor() {
        this.socketio.listen(ADMIN_CHANNEL).subscribe(msg => {
            const feed = this.feeds.get(msg.command as AdminTopic);
            const payload = msg.payload as Snapshot | undefined;
            if (!feed || !payload || typeof payload.request !== 'number' || payload.request < feed.latest) return;
            feed.data.set(payload);
            feed.loading.set(false);
        });

        this.socketio.reconnected$.subscribe(() => {
            for (const feed of this.feeds.values()) {
                feed.subscribed = false;
                this.ask(feed);
            }
        });
    }

    /**
     * A topic for as long as the calling component lives. Call it where inject() works, such as a
     * field initializer.
     */
    feed<T extends Snapshot>(topic: AdminTopic, options: FeedOptions = {}): AdminFeed<T> {
        const feed = new Feed<T>(topic, this);
        // The server keeps one subscription per topic and page: one the previous page left is
        // replaced by this feed's, or ended if this one asks only once.
        feed.subscribed = this.feeds.get(topic)?.subscribed ?? false;
        this.feeds.set(topic, feed as unknown as Feed<Snapshot>);

        effect(() => {
            const query = options.query ? options.query() : {};
            const live = options.live ? options.live() : true;
            untracked(() => {
                feed.query = query;
                feed.live = live;
                this.ask(feed);
            });
        });

        inject(DestroyRef).onDestroy(() => this.close(feed as unknown as Feed<Snapshot>));
        return feed;
    }

    /** @internal Sends a feed's question, with a new request number. */
    ask(feed: Feed<Snapshot>): void {
        if (this.feeds.get(feed.topic) !== feed) return;

        if (feed.query === null) {
            this.stop(feed);
            feed.loading.set(false);
            return;
        }

        const request = ++this.lastRequest;
        feed.latest = request;
        feed.loading.set(true);
        const payload = { ...feed.query, topic: feed.topic, request };
        if (feed.live) {
            this.socketio.emit(ADMIN_CHANNEL, 'subscribe', payload);
            feed.subscribed = true;
        } else {
            this.stop(feed);
            this.socketio.emit(ADMIN_CHANNEL, 'request', payload);
        }
    }

    private stop(feed: Feed<Snapshot>): void {
        if (!feed.subscribed) return;
        this.socketio.emit(ADMIN_CHANNEL, 'unsubscribe', { topic: feed.topic });
        feed.subscribed = false;
    }

    private close(feed: Feed<Snapshot>): void {
        // another page took the topic over already
        if (this.feeds.get(feed.topic) !== feed) return;
        this.stop(feed);
        this.feeds.delete(feed.topic);
    }
}
