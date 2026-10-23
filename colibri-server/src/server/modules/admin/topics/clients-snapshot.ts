import type { ClientActivity, LoadLimit, RateSample } from '../../limits/client-activity.js';
import type { NetworkClient } from '../../protocol/network.js';
import type { SocketIoClient } from '../../socket-io/socket-io-server.js';
import type { TcpNetworkClient } from '../../tcp/tcp-server-proxy.js';
import { latencySamples } from './latency-samples.js';
import { median } from './median.js';
import { clip, truncatedFlag } from './name-length.js';
import { ADMIN_APP } from './server-snapshot.js';

// Clients the client list holds at most.
export const MAX_CLIENT_ROWS = 1000;

// How far back a client's latency samples count towards its latency.
const LATENCY_WINDOW_MILLIS = 1000;

// How far back a client row's rate history goes: the 120 s the admin UI's throughput chart shows,
// and the 2 s it slides. A client keeps RATE_HISTORY_LENGTH rates, at least a second apart.
export const RATE_HISTORY_SECONDS = 122;

// One decimal: a rate or a latency, without the noise of the last digits.
const round1 = function (value: number | null): number | null {
    return value === null ? null : Math.round(value * 10) / 10;
};

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
    const recent = latencySamples(client, now - LATENCY_WINDOW_MILLIS, Infinity).map(sample => sample[1]);
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
