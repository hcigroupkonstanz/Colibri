import { RingBuffer } from '../../core/ring-buffer.js';
import type { NetworkClient } from '../../protocol/network.js';

// The client's latency samples (see MeasureLatency) taken from `from` up to, not including,
// `until`, oldest first.
export const latencySamples = function (client: NetworkClient, from: number, until: number): [number, number][] {
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
