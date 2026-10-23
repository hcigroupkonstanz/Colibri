import { RingBuffer } from '../../core/ring-buffer.js';
import type { NetworkClient } from '../../protocol/network.js';
import type { SocketIoClient } from '../../socket-io/socket-io-server.js';
import { MAX_CLIENT_ROWS } from './clients-snapshot.js';
import { median } from './median.js';
import { ADMIN_APP } from './server-snapshot.js';

// How far back the latency topic goes: the 120 s the admin UI's latency chart shows, and the 2 s it
// slides. MeasureLatency keeps 125 s.
export const LATENCY_HISTORY_MILLIS = 122_000;
// Samples the latency topic sends at most, all clients together. Past it, each client's per-second
// medians, at most 123 each.
export const MAX_LATENCY_HISTORY_SAMPLES = 200_000;

// Two decimals: a round trip to 0.01 ms.
const round2 = function (value: number): number {
    return Math.round(value * 100) / 100;
};

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
