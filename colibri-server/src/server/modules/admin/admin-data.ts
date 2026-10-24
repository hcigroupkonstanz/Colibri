import { filter } from 'rxjs';

import type { BuildInfo } from '../core/build-info.js';
import type { CertificateInfo } from '../tls/tls-files.js';
import { Payload } from '../protocol/payload.js';
import type { ProxyCertificateResult } from '../tls/proxy-certificate.js';
import { errorMessage } from '../core/error-message.js';
import { Service } from '../core/service.js';
import type { DataStore } from '../models/data-store.js';
import type { NetworkMessage } from '../protocol/network.js';
import type { RateLimit } from '../limits/inbound-limits.js';
import { TokenBucket } from '../limits/inbound-limits.js';
import type { SocketIoClient, SocketIOServer } from '../socket-io/socket-io-server.js';
import type { TCPServerProxy } from '../tcp/tcp-server-proxy.js';
import { CLIENT_ACTIVITY_TIMEOUT_MILLIS } from '../tcp/tcp-server-proxy.js';
import type { ClientActivity } from '../limits/client-activity.js';
import { ADMIN_APP } from './admin-app.js';
import type { AdminTopic, Query } from './admin-message.js';
import { parseAdminMessage } from './admin-message.js';
import { ModelMeasures } from './model-measures.js';
import { clientsSnapshot } from './topics/clients-snapshot.js';
import { latencySnapshot } from './topics/latency-snapshot.js';
import { modelSnapshot } from './topics/model-snapshot.js';
import { modelsSnapshot } from './topics/models-snapshot.js';
import type { ServerSettings, VoiceStatus } from './topics/server-snapshot.js';
import { serverSnapshot } from './topics/server-snapshot.js';

// See docs/dev/protocol.md, Admin UI channel.
export const ADMIN_CHANNEL = 'colibri::admin';

export const ADMIN_REFRESH_MILLIS = 1000;

// Rate limit per page for request and subscribe; a message past it is ignored. A snapshot can cost
// a pass over the whole model store.
export const ADMIN_REQUEST_LIMIT: RateLimit = { messagesPerSecond: 10, burst: 20 };

export interface AdminSources {
    store: DataStore;
    socketio: SocketIOServer;
    tcp: TCPServerProxy;
    version: string;
    build: BuildInfo;
    // Date.now() of the start.
    startedAt: number;
    settings: ServerSettings;
    tls?: { readonly info: CertificateInfo };
    // The certificates of PROXY_TLS_ADDRESSES; left out without them.
    proxyTls?: { readonly results: ReadonlyArray<ProxyCertificateResult> };
    // Whether TCP_TLS_AT_PROXY applies: it is on, and so is TCP_PROXY_PROTOCOL. Off if left out.
    tcpTlsAtProxy?: boolean;
    voice?: { readonly status: VoiceStatus };
    restStore?: { counts(): { apps: number; keys: number; bytes: number } };
}

interface Subscription {
    query: Query;
    // Equal for two pages asking for the same thing, which then share one snapshot.
    key: string;
    // The page's request number, echoed in every snapshot sent for it.
    request: number | null;
}

interface Due {
    page: AdminPage;
    subscription: Subscription;
}

interface AdminPage {
    client: SocketIoClient;
    requests: TokenBucket;
    subscriptions: Map<AdminTopic, Subscription>;
}

// Whether the page's transport is still sending earlier packets, as for a page that stopped reading:
// engine.io keeps whatever else it is given in memory until then.
const isBackedUp = function (page: AdminPage): boolean {
    return !page.client.socket.conn.transport.writable;
};

/**
 * Answers the admin UI's pages with read-only snapshots of the server: its settings and counts, the
 * connected clients and their traffic and latency, and the synchronized models. A page asks for a
 * topic once ('request') or for as long as it shows it ('subscribe'); a subscribed topic is sent
 * again every ADMIN_REFRESH_MILLIS. Only clients of the app 'colibri' are answered.
 *
 * Every snapshot is bounded in size however much the store holds: a page of models, a model's JSON
 * up to a limit, names cut to a length.
 *
 * Read only by design: Colibri has no authentication, so whatever a page can do through this
 * channel, anyone who can reach the server can do.
 */
export class AdminData extends Service {
    public get serviceName(): string { return 'AdminData'; }
    public get groupName(): string { return 'web'; }

    private readonly pages = new Map<string, AdminPage>();
    // Shared by all snapshots and pages, so its measuring budget covers them together.
    private readonly measures = new ModelMeasures();
    private refreshTimer: NodeJS.Timeout | undefined;
    // Set while a refresh waits for the TCP worker, so a slow answer does not stack refreshes.
    private refreshing = false;

    public constructor(private readonly sources: AdminSources) {
        super();
    }

    public override async init(): Promise<void> {
        await super.init();

        this.sources.socketio.messages$
            .pipe(filter(msg => msg.channel === ADMIN_CHANNEL))
            .subscribe(msg => {
                // An exception escaping a subscriber is uncaught and main.ts shuts the server down.
                try {
                    this.handleMessage(msg);
                } catch (err) {
                    this.logError(`Ignoring ${ADMIN_CHANNEL} '${msg.command}' from client ${msg.origin?.id}: ${errorMessage(err)}`, false);
                }
            });

        this.sources.socketio.clientDisconnected$.subscribe(client => this.forgetPage(client.id));
    }

    public stop(): void {
        clearInterval(this.refreshTimer);
        this.refreshTimer = undefined;
        this.pages.clear();
    }

    public get subscriptionCount(): number {
        let count = 0;
        for (const page of this.pages.values()) count += page.subscriptions.size;
        return count;
    }

    private handleMessage(msg: NetworkMessage): void {
        const client = msg.origin && this.sources.socketio.getClient(msg.origin.id);
        if (!client || client.app !== ADMIN_APP) return;

        const message = parseAdminMessage(msg.command, msg.payload?.asValue());
        if (message.kind === 'unsubscribe') {
            const subscriptions = this.pages.get(client.id)?.subscriptions;
            if (message.topic === undefined) subscriptions?.clear();
            else if (message.topic !== null) subscriptions?.delete(message.topic);
            this.updateRefreshTimer();
            return;
        }
        if (message.kind === 'ignore') {
            if (message.reason !== undefined) this.logDebug(`Ignoring ${ADMIN_CHANNEL} '${msg.command}' from admin page ${client.id}: ${message.reason}`);
            return;
        }

        const page = this.pageOf(client);
        if (!page.requests.take(performance.now())) return;

        const { query, key, request } = message;
        const subscription: Subscription = { query, key, request };
        if (message.kind === 'subscribe') {
            // One subscription per topic and page: a new one replaces the query.
            page.subscriptions.set(message.topic, subscription);
            this.updateRefreshTimer();
        }
        void this.send([ { page, subscription } ]);
    }

    private pageOf(client: SocketIoClient): AdminPage {
        let page = this.pages.get(client.id);
        if (!page) {
            page = { client, requests: new TokenBucket(ADMIN_REQUEST_LIMIT, performance.now()), subscriptions: new Map() };
            this.pages.set(client.id, page);
        }
        return page;
    }

    private forgetPage(id: string): void {
        if (this.pages.delete(id)) this.updateRefreshTimer();
    }

    private updateRefreshTimer(): void {
        const needed = this.subscriptionCount > 0;
        if (needed && !this.refreshTimer) {
            this.refreshTimer = setInterval(() => void this.refresh(), ADMIN_REFRESH_MILLIS);
            this.refreshTimer.unref();
        } else if (!needed && this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }
    }

    private async refresh(): Promise<void> {
        if (this.refreshing) return;

        const due: Due[] = [];
        for (const page of this.pages.values()) {
            for (const subscription of page.subscriptions.values()) due.push({ page, subscription });
        }
        if (due.length === 0) return;

        this.refreshing = true;
        try {
            await this.send(due, true);
        } finally {
            this.refreshing = false;
        }
    }

    // Builds each snapshot once for all pages that asked for the same thing. A refresh skips backed-up
    // pages: the next refresh replaces what they missed. Anything but a refresh is a page's first
    // snapshot, whose client rows carry their rate history. Never rejects: callers do not await it.
    private async send(due: Due[], refresh = false): Promise<void> {
        try {
            if (refresh) due = due.filter(item => !isBackedUp(item.page));
            if (due.length === 0) return;

            const tcpActivity = due.some(item => item.subscription.query.topic === 'clients')
                ? await this.sources.tcp.clientActivity(CLIENT_ACTIVITY_TIMEOUT_MILLIS, !refresh)
                : undefined;

            const built = new Map<string, object>();
            for (const { page, subscription } of due) {
                // Gone while the TCP worker was asked.
                if (this.pages.get(page.client.id) !== page) continue;

                let snapshot = built.get(subscription.key);
                if (snapshot === undefined) {
                    snapshot = this.build(subscription.query, tcpActivity, !refresh);
                    built.set(subscription.key, snapshot);
                }

                this.sources.socketio.broadcast({
                    channel: ADMIN_CHANNEL,
                    command: subscription.query.topic,
                    payload: Payload.fromValue({ request: subscription.request, ...snapshot }),
                }, [ page.client ]);
            }
        } catch (err) {
            this.logError(`Could not send the admin UI its data: ${errorMessage(err)}`, false);
        }
    }

    private build(query: Query, tcpActivity: ReadonlyMap<string, ClientActivity> | undefined, history: boolean): object {
        const { sources } = this;
        switch (query.topic) {
            case 'server':
                return serverSnapshot({
                    version: sources.version,
                    build: sources.build,
                    startedAt: sources.startedAt,
                    settings: sources.settings,
                    tls: sources.tls?.info,
                    proxyTls: sources.proxyTls?.results,
                    tcpTlsAtProxy: sources.tcpTlsAtProxy ?? false,
                    voice: sources.voice?.status,
                    store: sources.store,
                    restStore: sources.restStore?.counts(),
                    tcpClients: sources.tcp.currentClients,
                    webClients: sources.socketio.currentClients,
                });

            case 'clients':
                return clientsSnapshot({
                    tcpClients: sources.tcp.currentClients,
                    tcpActivity: tcpActivity ?? new Map(),
                    webClients: sources.socketio.currentClients,
                    webActivity: client => sources.socketio.activityOf(client, history),
                }, history);

            case 'models':
                return modelsSnapshot(sources.store, query.models, this.measures);

            case 'model':
                return modelSnapshot(sources.store, query.model, this.measures);

            case 'latency':
                return latencySnapshot({ tcpClients: sources.tcp.currentClients, webClients: sources.socketio.currentClients });
        }
    }
}
