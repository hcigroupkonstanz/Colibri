// What the admin UI's pages read from the server, one snapshot per topic; see AdminData for how they
// are asked for and sent. Every snapshot is read only and bounded in size: a page of models, not the
// store; a model's JSON up to a limit; names cut to a length. None of these functions changes the
// state it reads.
import { BuildInfo, CertificateInfo, RingBuffer } from '../core/index.js';
import { DataStore, ModelEntry, NetworkClient, Tombstone } from '../command-hooks/index.js';
import { ClientActivity, LoadLimit, RateSample } from '../networking/client-activity.js';
import { PROTOCOL_VERSION } from '../networking/protocol.js';
import { SocketIoClient } from '../networking/socket-io-server.js';
import { TcpNetworkClient } from '../networking/tcp-server-proxy.js';
import { MAX_MODEL_JSON_LENGTH, ModelMeasures } from './model-measures.js';

export { MAX_MODEL_JSON_LENGTH };

// The app the admin UI joins.
export const ADMIN_APP = 'colibri';

// How much of an app, channel, model id or client name a snapshot carries. A longer one is cut, and
// its row says so. Ids and channels are that short in practice; this only bounds what an odd client
// can make a snapshot carry.
export const MAX_NAME_LENGTH = 512;

// Models a page of the model list holds by default, and at most.
export const DEFAULT_MODELS_LIMIT = 50;
export const MAX_MODELS_LIMIT = 200;
// Channels the model list's overview lists at most, and recently deleted ids.
export const MAX_CHANNELS = 500;
export const MAX_DELETED = 100;
// How long a model list filter may be.
export const MAX_FILTER_LENGTH = 200;
// Clients the client list holds at most.
export const MAX_CLIENT_ROWS = 1000;

// How far back a client's latency samples count towards its latency.
const LATENCY_WINDOW_MILLIS = 1000;

// How far back a client row's rate history goes: the 120 s the admin UI's throughput chart shows,
// and the 2 s it slides. A client keeps RATE_HISTORY_LENGTH rates, at least a second apart.
export const RATE_HISTORY_SECONDS = 122;

// How far back the latency topic goes: the 120 s the admin UI's latency chart shows, and the 2 s it
// slides. MeasureLatency keeps 125 s.
export const LATENCY_HISTORY_MILLIS = 122_000;
// Samples the latency topic sends at most, all clients together. Past it, each client's per-second
// medians, at most 123 each.
export const MAX_LATENCY_HISTORY_SAMPLES = 200_000;

// The text, cut to MAX_NAME_LENGTH.
const clip = function (text: string): string {
    return text.length > MAX_NAME_LENGTH ? text.slice(0, MAX_NAME_LENGTH) : text;
};

const isLong = function (text: string): boolean {
    return text.length > MAX_NAME_LENGTH;
};

// A name a query asks for, cut to one character more than MAX_NAME_LENGTH, so that what a snapshot
// sends back of the query stays small. No row shows a name that long in full, so a page cannot have
// taken one from a row, and a longer name cut to it matches nothing.
const queryName = function (fields: Record<string, unknown>, name: string): string {
    return stringField(fields, name).slice(0, MAX_NAME_LENGTH + 1);
};

const fieldsOf = function (body: unknown): Record<string, unknown> {
    return (body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
};

const stringField = function (fields: Record<string, unknown>, name: string): string {
    const value = fields[name];
    return typeof value === 'string' ? value : '';
};

const integerField = function (fields: Record<string, unknown>, name: string, fallback: number, min: number, max: number): number {
    const value = fields[name];
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(value)));
};

// One decimal: a rate or a latency, without the noise of the last digits.
const round1 = function (value: number | null): number | null {
    return value === null ? null : Math.round(value * 10) / 10;
};

// Two decimals: a round trip to 0.01 ms.
const round2 = function (value: number): number {
    return Math.round(value * 100) / 100;
};

// Sorts the values.
const median = function (values: number[]): number {
    values.sort((a, b) => a - b);
    const middle = values.length >> 1;
    return values.length % 2 === 1 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
};

// Date.now() of an instant on the performance.now() clock.
const wallClock = function (performanceMillis: number, now: number, performanceNow: number): number {
    return Math.round(now - (performanceNow - performanceMillis));
};

/**
 * Models
 */

export interface ModelsQuery {
    // Exact app and channel; '' for every one.
    app: string;
    channel: string;
    // Part of a model's id or channel, in any case; '' for every model.
    filter: string;
    offset: number;
    limit: number;
}

export const parseModelsQuery = function (body: unknown): ModelsQuery {
    const fields = fieldsOf(body);
    return {
        app: queryName(fields, 'app'),
        channel: queryName(fields, 'channel'),
        filter: stringField(fields, 'filter').slice(0, MAX_FILTER_LENGTH),
        offset: integerField(fields, 'offset', 0, 0, Number.MAX_SAFE_INTEGER),
        limit: integerField(fields, 'limit', DEFAULT_MODELS_LIMIT, 1, MAX_MODELS_LIMIT),
    };
};

export interface ChannelSummary {
    app: string;
    channel: string;
    models: number;
    // Ids deleted within MODEL_TOMBSTONE_SECONDS.
    deleted: number;
    // The app or channel name was cut to MAX_NAME_LENGTH.
    truncated?: true;
}

export interface ModelRow {
    app: string;
    channel: string;
    id: string;
    // Top-level fields besides the id.
    fields: number;
    // Compact JSON size as last measured (see ModelMeasures.bytes); null if not measured yet.
    bytes: number | null;
    // Date.now() of its latest update.
    updatedAt: number;
    // The app, channel or id was cut to MAX_NAME_LENGTH, so the model topic cannot find it.
    truncated?: true;
}

export interface DeletedRow {
    app: string;
    channel: string;
    id: string;
    // Date.now() of the delete.
    deletedAt: number;
    truncated?: true;
}

export interface ModelsSnapshot {
    at: number;
    query: ModelsQuery;
    // Every app and channel holding models or tombstones, in the order they were first written to,
    // the first MAX_CHANNELS of channelsTotal.
    channels: ChannelSummary[];
    channelsTotal: number;
    // The models matching the query from `offset` on, at most `limit`, in store order: by app and
    // channel as above, then in the order the models were created. `total` match the query.
    models: ModelRow[];
    total: number;
    // The ids matching the query deleted within tombstoneSeconds, the newest first, at most
    // MAX_DELETED of deletedTotal.
    deleted: DeletedRow[];
    deletedTotal: number;
    tombstoneSeconds: number;
}

const truncatedFlag = function (...names: string[]): { truncated?: true } {
    return names.some(isLong) ? { truncated: true } : {};
};

export const modelsSnapshot = function (store: DataStore, query: ModelsQuery, measures = new ModelMeasures()): ModelsSnapshot {
    const now = Date.now();
    const performanceNow = performance.now();
    const filter = query.filter.toLowerCase();
    const matchesName = (name: string) => filter === '' || name.toLowerCase().includes(filter);
    const inScope = (app: string, channel: string) =>
        (query.app === '' || app === query.app) && (query.channel === '' || channel === query.channel);

    // The overview: model counts, then tombstone counts, per app and channel.
    const summaries = new Map<string, ChannelSummary>();
    const summaryOf = (app: string, channel: string): ChannelSummary => {
        const key = `${app}\u0000${channel}`;
        let summary = summaries.get(key);
        if (!summary) {
            summary = { app: clip(app), channel: clip(channel), models: 0, deleted: 0, ...truncatedFlag(app, channel) };
            summaries.set(key, summary);
        }
        return summary;
    };

    const models: ModelRow[] = [];
    let total = 0;
    for (const { app, channel, models: entries } of store.channels()) {
        if (entries.size > 0) summaryOf(app, channel).models = entries.size;
        if (!inScope(app, channel)) continue;

        const channelMatches = matchesName(channel);
        for (const [id, entry] of entries) {
            if (!channelMatches && !matchesName(id)) continue;
            total += 1;
            if (total <= query.offset || models.length >= query.limit) continue;

            models.push({
                app: clip(app),
                channel: clip(channel),
                id: clip(id),
                fields: fieldCount(entry),
                bytes: measures.bytes(entry, performanceNow),
                updatedAt: entry.updatedAt,
                ...truncatedFlag(app, channel, id),
            });
        }
    }

    // Each app's come oldest first: its newest MAX_DELETED are candidates for the newest overall.
    const candidates: [string, Readonly<Tombstone>][] = [];
    let deletedTotal = 0;
    for (const app of store.tombstoneApps()) {
        let newest: [string, Readonly<Tombstone>][] = [];
        for (const tombstone of store.liveTombstones(app)) {
            summaryOf(app, tombstone.channel).deleted += 1;
            if (!inScope(app, tombstone.channel)) continue;
            if (!matchesName(tombstone.channel) && !matchesName(tombstone.id)) continue;

            deletedTotal += 1;
            newest.push([app, tombstone]);
            if (newest.length > 2 * MAX_DELETED) newest = newest.slice(-MAX_DELETED);
        }
        // Newest first, which a sort keeps for ids deleted in the same millisecond.
        candidates.push(...newest.slice(-MAX_DELETED).reverse());
    }
    const deleted: DeletedRow[] = candidates
        .sort((a, b) => b[1].deletedAt - a[1].deletedAt)
        .slice(0, MAX_DELETED)
        .map(([app, tombstone]) => ({
            app: clip(app),
            channel: clip(tombstone.channel),
            id: clip(tombstone.id),
            deletedAt: wallClock(tombstone.deletedAt, now, performanceNow),
            ...truncatedFlag(app, tombstone.channel, tombstone.id),
        }));

    const channels = Array.from(summaries.values()).filter(summary => summary.models > 0 || summary.deleted > 0);
    return {
        at: now,
        query,
        channels: channels.slice(0, MAX_CHANNELS),
        channelsTotal: channels.length,
        models,
        total,
        deleted,
        deletedTotal,
        tombstoneSeconds: store.tombstoneMillis / 1000,
    };
};

const fieldCount = function (entry: Readonly<ModelEntry>): number {
    let count = 0;
    for (const key in entry.model) {
        if (key !== 'id' && Object.hasOwn(entry.model, key)) count += 1;
    }
    return count;
};

export interface ModelQuery {
    app: string;
    channel: string;
    id: string;
}

export const parseModelQuery = function (body: unknown): ModelQuery {
    const fields = fieldsOf(body);
    return { app: queryName(fields, 'app'), channel: queryName(fields, 'channel'), id: queryName(fields, 'id') };
};

export interface ModelSnapshot {
    at: number;
    app: string;
    channel: string;
    id: string;
    // Whether the store holds the model. If not, deletedAt says when it was deleted, if that was
    // within the tombstone time.
    found: boolean;
    deletedAt?: number;
    fields?: number;
    // As in ModelRow.
    bytes?: number | null;
    updatedAt?: number;
    // The value as JSON indented by two spaces, cut to MAX_MODEL_JSON_LENGTH characters.
    json?: string;
    truncated?: boolean;
}

export const modelSnapshot = function (store: DataStore, query: ModelQuery, measures = new ModelMeasures()): ModelSnapshot {
    const now = Date.now();
    const head = { at: now, app: clip(query.app), channel: clip(query.channel), id: clip(query.id) };
    const entry = store.getEntry(query.app, query.channel, query.id);
    if (!entry) {
        const tombstone = store.liveDeletion(query.app, query.channel, query.id);
        return tombstone
            ? { ...head, found: false, deletedAt: wallClock(tombstone.deletedAt, now, performance.now()) }
            : { ...head, found: false };
    }

    const { json, truncated } = measures.json(entry);
    return {
        ...head,
        found: true,
        fields: fieldCount(entry),
        bytes: measures.bytes(entry),
        updatedAt: entry.updatedAt,
        json,
        truncated,
    };
};

/**
 * Clients
 */

export interface ClientRow {
    id: string;
    app: string;
    name: string;
    transport: 'tcp' | 'web';
    // The protocol version it announced.
    version: string;
    // Whether its connection to this server is encrypted. Behind a proxy that ends TLS, that is
    // the proxy's connection.
    tls: boolean;
    // Whether it reached a trusted proxy over TLS: for a web client as the proxy reported in
    // X-Forwarded-Proto (see forwardedTls), for a TCP client as TCP_TLS_AT_PROXY says of every one
    // that came through the proxy. nginx's PROXY protocol header, version 1, does not say, and the
    // TLS details a version 2 header can carry are skipped.
    tlsAtProxy: boolean;
    // Its own address, behind a trusted proxy the one the proxy named.
    address: string;
    // Date.now() of its connection.
    connectedAt: number;
    // Median round trip over the last second, in ms.
    latency: number | null;
    // See ClientActivity; null for a TCP client the worker did not report on this time.
    in: number | null;
    out: number | null;
    limit: LoadLimit | null;
    held: number;
    // Only in the answer to a request and the first answer to a subscribe: its rates in each of the
    // RATE_HISTORY_SECONDS seconds before `at`, oldest first, as [in, out]; see rateHistory.
    history?: [number, number][];
    truncated?: true;
}

export interface ClientsSnapshot {
    at: number;
    // Every client but the admin UI's own pages, the first MAX_CLIENT_ROWS of total.
    clients: ClientRow[];
    total: number;
    adminPages: number;
}

// What the client list needs of the two transports.
export interface ClientSources {
    tcpClients: ReadonlyArray<TcpNetworkClient>;
    tcpActivity: ReadonlyMap<string, ClientActivity>;
    webClients: ReadonlyArray<SocketIoClient>;
    webActivity(client: SocketIoClient): ClientActivity;
}

// The median of the client's latency samples (see MeasureLatency) from the last second.
export const recentLatency = function (client: NetworkClient, now: number): number | null {
    const samples = client.metadata['latency'];
    if (!(samples instanceof RingBuffer)) return null;

    const recent: number[] = [];
    for (let i = samples.length - 1; i >= 0; i--) {
        const sample = samples.at(i) as [number, number] | undefined;
        if (!sample || sample[0] < now - LATENCY_WINDOW_MILLIS) break;
        recent.push(sample[1]);
    }
    return recent.length === 0 ? null : median(recent);
};

// The client's rates (see TrafficMeter.history) as a page open in each of the RATE_HISTORY_SECONDS
// seconds before `now` would have been sent them: the latest sampled by then, one a second, oldest
// first. It starts at the first second with one.
export const rateHistory = function (samples: ReadonlyArray<RateSample>, now: number): [number, number][] {
    const history: [number, number][] = [];
    let i = samples.length - 1;
    for (let ago = 1; ago <= RATE_HISTORY_SECONDS; ago++) {
        while (i >= 0 && samples[i]![0] > now - ago * 1000) i--;
        if (i < 0) break;
        history.push([ round1(samples[i]![1])!, round1(samples[i]![2])! ]);
    }
    return history.reverse();
};

const NO_ACTIVITY: ClientActivity = { in: null, out: null, limit: null, held: 0 };

// `history`: each row with its rate history, as far as the sources have it.
export const clientsSnapshot = function (sources: ClientSources, history = false): ClientsSnapshot {
    const now = Date.now();
    const rows: ClientRow[] = [];
    let total = 0;
    let adminPages = 0;

    const add = (client: NetworkClient, row: Omit<ClientRow, 'id' | 'app' | 'name' | 'version' | 'latency'>) => {
        total += 1;
        if (rows.length >= MAX_CLIENT_ROWS) return;
        rows.push({
            id: client.id,
            app: clip(client.app),
            name: clip(client.name),
            version: clip(client.version),
            latency: round1(recentLatency(client, now)),
            ...row,
            address: clip(row.address),
            ...truncatedFlag(client.app, client.name, client.version, row.address),
        });
    };
    const activityRow = (activity: ClientActivity) => ({
        in: round1(activity.in),
        out: round1(activity.out),
        limit: activity.limit,
        held: activity.held,
        ...(history ? { history: rateHistory(activity.history ?? [], now) } : {}),
    });

    for (const client of sources.tcpClients) {
        add(client, {
            transport: 'tcp',
            tls: client.tls,
            tlsAtProxy: client.tlsAtProxy,
            address: client.address,
            connectedAt: client.connectedAt,
            ...activityRow(sources.tcpActivity.get(client.id) ?? NO_ACTIVITY),
        });
    }
    for (const client of sources.webClients) {
        if (client.app === ADMIN_APP) {
            adminPages += 1;
            continue;
        }
        add(client, {
            transport: 'web',
            tls: client.socket.handshake.secure,
            tlsAtProxy: client.tlsAtProxy,
            address: client.name,
            connectedAt: client.socket.handshake.issued,
            ...activityRow(sources.webActivity(client)),
        });
    }

    return { at: now, clients: rows, total, adminPages };
};

/**
 * Latency
 */

export interface LatencyHistory {
    id: string;
    // Oldest first, as [Date.now(), round trip in ms].
    samples: [number, number][];
}

export interface LatencySnapshot {
    at: number;
    // Each client's samples taken within LATENCY_HISTORY_MILLIS before `at`, but not at `at` itself:
    // those come with the next colibri::latency update, as do the newer ones. Every client but the
    // admin UI's pages, the first MAX_CLIENT_ROWS of total.
    clients: LatencyHistory[];
    total: number;
    // Each second's median at the mean time of its samples, in place of the samples: there were more
    // than MAX_LATENCY_HISTORY_SAMPLES. The admin UI's chart draws the medians either way.
    medians: boolean;
}

export interface LatencySources {
    tcpClients: ReadonlyArray<NetworkClient>;
    webClients: ReadonlyArray<SocketIoClient>;
}

// The client's latency samples (see MeasureLatency) taken from `from` up to, not including,
// `until`, oldest first.
const latencySamples = function (client: NetworkClient, from: number, until: number): [number, number][] {
    const samples = client.metadata['latency'];
    if (!(samples instanceof RingBuffer)) return [];

    const recent: [number, number][] = [];
    for (let i = samples.length - 1; i >= 0; i--) {
        const sample = samples.at(i) as [number, number] | undefined;
        if (!sample || sample[0] < from) break;
        if (sample[0] < until) recent.push(sample);
    }
    return recent.reverse();
};

const perSecondMedians = function (samples: ReadonlyArray<[number, number]>): [number, number][] {
    const medians: [number, number][] = [];
    for (let i = 0; i < samples.length;) {
        const second = Math.floor(samples[i]![0] / 1000);
        let times = 0;
        const values: number[] = [];
        for (; i < samples.length && Math.floor(samples[i]![0] / 1000) === second; i++) {
            times += samples[i]![0];
            values.push(samples[i]![1]);
        }
        medians.push([ Math.round(times / values.length), round2(median(values)) ]);
    }
    return medians;
};

export const latencySnapshot = function (sources: LatencySources): LatencySnapshot {
    const now = Date.now();
    const from = now - LATENCY_HISTORY_MILLIS;
    const listed: NetworkClient[] = [];
    let total = 0;

    const add = (client: NetworkClient) => {
        total += 1;
        if (listed.length < MAX_CLIENT_ROWS) listed.push(client);
    };
    for (const client of sources.tcpClients) add(client);
    for (const client of sources.webClients) {
        if (client.app !== ADMIN_APP) add(client);
    }

    // Counted first, rather than holding a thousand clients' samples at once to count them.
    let count = 0;
    for (const client of listed) count += latencySamples(client, from, now).length;
    const medians = count > MAX_LATENCY_HISTORY_SAMPLES;

    const clients = listed.map(client => {
        const samples = latencySamples(client, from, now);
        return { id: client.id, samples: medians ? perSecondMedians(samples) : samples.map(([ at, ms ]): [number, number] => [ at, round2(ms) ]) };
    });
    return { at: now, clients, total, medians };
};

/**
 * Server
 */

// The settings in effect, by the names of the variables that set them. TLS_CERT and TLS_KEY are
// left out: `tls` says what they hold, never where they are or what is in them.
export type ServerSettings = Record<string, string | number | boolean | string[]>;

export interface VoiceStatus {
    listening: boolean;
    recording: boolean;
    samplingRate: number;
    clients: number;
}

export interface ServerSources {
    version: string;
    build: BuildInfo;
    // Date.now() of the start.
    startedAt: number;
    settings: ServerSettings;
    // The certificate served now, if TLS is on.
    tls: CertificateInfo | undefined;
    // Whether TCP_TLS_AT_PROXY applies: it is on, and so is TCP_PROXY_PROTOCOL.
    tcpTlsAtProxy: boolean;
    voice: VoiceStatus | undefined;
    store: DataStore;
    restStore: { apps: number; keys: number } | undefined;
    tcpClients: ReadonlyArray<NetworkClient>;
    webClients: ReadonlyArray<SocketIoClient>;
}

export interface ServerSnapshot {
    at: number;
    version: string;
    // The commit it was built from, whether colibri-server had uncommitted changes then, and
    // Date.now() of the build; commit and time null if the build did not record them.
    build: BuildInfo;
    protocolVersion: string;
    node: string;
    startedAt: number;
    // Seconds.
    uptime: number;
    settings: ServerSettings;
    // The certificate's names (its subject alternative names, or its subject), issuer and validity.
    tls: { names: string; issuer: string; selfSigned: boolean; validFrom: number; validTo: number; fingerprint256: string } | null;
    // TLS that ends at a trusted proxy in front of this server, which sees only the proxy's own
    // connections and knows of it only from the proxy or the operator. `web`: a web client or admin
    // page connected now, the one asking included, reached the proxy over TLS (see
    // ClientRow.tlsAtProxy). `tcp`: TCP_TLS_AT_PROXY applies, so every Unity client through the
    // proxy counts as TLS at the proxy, connected now or not.
    tlsAtProxy: { web: boolean; tcp: boolean };
    voice: VoiceStatus | null;
    counts: {
        tcpClients: number;
        webClients: number;
        adminPages: number;
        // Apps with at least one client.
        apps: number;
        // The synchronized models the server holds, in how many apps and channels, and the ids
        // deleted within the tombstone time.
        models: number;
        modelApps: number;
        modelChannels: number;
        deletedModels: number;
        // The REST store's apps and values.
        storeApps: number;
        storeKeys: number;
    };
}

export const serverSnapshot = function (sources: ServerSources): ServerSnapshot {
    const now = Date.now();
    const { store } = sources;

    let models = 0;
    let modelChannels = 0;
    const modelApps = new Set<string>();
    for (const { app, models: entries } of store.channels()) {
        if (entries.size === 0) continue;
        models += entries.size;
        modelChannels += 1;
        modelApps.add(app);
    }
    let deletedModels = 0;
    for (const app of store.tombstoneApps()) {
        const tombstones = store.liveTombstones(app);
        while (!tombstones.next().done) deletedModels += 1;
    }

    const apps = new Set<string>(sources.tcpClients.map(client => client.app));
    let webClients = 0;
    let adminPages = 0;
    let webTlsAtProxy = false;
    for (const client of sources.webClients) {
        if (client.tlsAtProxy) webTlsAtProxy = true;
        if (client.app === ADMIN_APP) {
            adminPages += 1;
        } else {
            webClients += 1;
            apps.add(client.app);
        }
    }

    const tls = sources.tls;
    return {
        at: now,
        version: sources.version,
        build: sources.build,
        protocolVersion: PROTOCOL_VERSION,
        node: process.version,
        startedAt: sources.startedAt,
        uptime: Math.max(0, Math.round((now - sources.startedAt) / 1000)),
        settings: sources.settings,
        tls: tls
            ? {
                names: tls.names,
                issuer: tls.issuer,
                selfSigned: tls.selfSigned,
                validFrom: tls.validFrom.getTime(),
                validTo: tls.validTo.getTime(),
                fingerprint256: tls.fingerprint256,
            }
            : null,
        tlsAtProxy: { web: webTlsAtProxy, tcp: sources.tcpTlsAtProxy },
        voice: sources.voice ?? null,
        counts: {
            tcpClients: sources.tcpClients.length,
            webClients,
            adminPages,
            apps: apps.size,
            models,
            modelApps: modelApps.size,
            modelChannels,
            deletedModels,
            storeApps: sources.restStore?.apps ?? 0,
            storeKeys: sources.restStore?.keys ?? 0,
        },
    };
};
