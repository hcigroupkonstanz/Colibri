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
import type { AdminTopic, Query } from './admin-message.js';
import { parseAdminMessage } from './admin-message.js';
import { ModelMeasures } from './model-measures.js';
import { clientsSnapshot } from './topics/clients-snapshot.js';
import { latencySnapshot } from './topics/latency-snapshot.js';
import { modelSnapshot } from './topics/model-snapshot.js';
import { modelsSnapshot } from './topics/models-snapshot.js';
import type { ServerSettings, VoiceStatus } from './topics/server-snapshot.js';
import { ADMIN_APP, serverSnapshot } from './topics/server-snapshot.js';

// The channel the admin UI's pages ask for read-only server data on, and get it on. See
// docs/dev/protocol.md, Admin UI channel.
export const ADMIN_CHANNEL = 'colibri::admin';

// How often a subscribed topic is sent again.
export const ADMIN_REFRESH_MILLIS = 1000;

// How many request and subscribe messages one page may send: far more than any page clicking
// through its views does. One past it is ignored. A snapshot can cost a pass over the whole model
// store, so this keeps a script in a loop from having the server do that without end.
export const ADMIN_REQUEST_LIMIT: RateLimit = { messagesPerSecond: 10, burst: 20 };

// What AdminData reads. All of it read only: nothing in here is ever called to change anything.
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
    // The request number of the request or subscribe, echoed in every snapshot it is sent.
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

// Whether the page's connection is still sending what it was sent before, as it is for a page that
// stopped reading: engine.io keeps whatever else it is given meanwhile in memory, until it can send.
const isBackedUp = function (page: AdminPage): boolean {
    return !page.client.socket.conn.transport.writable;
};

/**
 * Answers the admin UI's pages with read-only snapshots of the server: its settings and counts, the
 * connected clients and their traffic and latency, and the synchronized models. A page asks for a
 * topic once ('request') or for as long as it shows it ('subscribe', until 'unsubscribe' or it
 * disconnects; the latency history only once); a subscribed topic is sent again every
 * ADMIN_REFRESH_MILLIS. Nothing is computed, and nothing asked of the TCP worker, while no page has
 * subscribed. Only clients of the app 'colibri' are answered.
 *
 * Every snapshot is bounded in size, however much the store holds: a page of models, not the store;
 * a model's JSON up to a limit; names cut to a length.
 *
 * Read only by design: Colibri has no authentication, so whatever a page can do through this
 * channel, anyone who can reach the server can do.
 */
export class AdminData extends Service {
    public get serviceName(): string { return 'AdminData'; }
    public get groupName(): string { return 'web'; }

    private readonly pages = new Map<string, AdminPage>();
    // One for every snapshot and page: what it measures a second is bounded for all of them.
    private readonly measures = new ModelMeasures();
    private refreshTimer: NodeJS.Timeout | undefined;
    // Set while a refresh waits for the TCP worker, so that a slow answer does not stack them up.
    private refreshing = false;

    public constructor(private readonly sources: AdminSources) {
        super();
    }

    public override async init(): Promise<void> {
        super.init();

        this.sources.socketio.messages$
            .pipe(filter(msg => msg.channel === ADMIN_CHANNEL))
            .subscribe(msg => {
                // Nothing a client sends may escape from here: RxJS rethrows it asynchronously,
                // where it is an uncaught exception and main.ts shuts the server down.
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

    // How many topics the pages have subscribed to, all together.
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

    // Runs only while some page has subscribed to something.
    private updateRefreshTimer(): void {
        const needed = this.subscriptionCount > 0;
        if (needed && !this.refreshTimer) {
            this.refreshTimer = setInterval(() => void this.refresh(), ADMIN_REFRESH_MILLIS);
            // Never the reason the process stays alive.
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

    // Builds each snapshot once for all the pages that asked for the same thing, and sends it to
    // those still connected. A refresh skips the pages that have not taken the previous one yet:
    // they would only pile up, and the next refresh replaces it anyway. Anything but a refresh is a
    // page's first snapshot, whose client rows carry their rate history. Never rejects: its callers
    // do not wait for it.
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
