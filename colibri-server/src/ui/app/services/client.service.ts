import { Injectable, inject, signal } from '@angular/core';
import { filter } from 'rxjs';
import { ADMIN_CHANNEL, LatencySnapshot } from './admin.service';
import { SocketIOService } from './socketio.service';

export interface ColibriClient {
    id: string;
    app: string;
    name: string;
    version: string;
    latency: [number, number][];
    /**
     * Its colour on the Clients page: the lowest no other client had when it connected, kept
     * until it leaves. Its place in the list changed whenever a client before it left.
     */
    slot: number;
}

/** How long a client's latency samples are kept, by the server's clock: the chart's 120 s, and the 2 s it slides. */
export const LATENCY_KEEP_MILLIS = 122_000;
// as many as the server keeps: 125 s of 100 ms pings
const MAX_LATENCY_SAMPLES = 1250;

/** The samples without those from before LATENCY_KEEP_MILLIS ahead of the newest. */
export const recentSamples = function (samples: [number, number][]): [number, number][] {
    const newest = samples.at(-1)?.[0];
    if (newest === undefined) return samples;
    let first = Math.max(0, samples.length - MAX_LATENCY_SAMPLES);
    while (first < samples.length && samples[first][0] < newest - LATENCY_KEEP_MILLIS) first++;
    return first === 0 ? samples : samples.slice(first);
};

/**
 * A client's samples with the server's history of them, taken at `at`: the history holds every
 * sample from before `at`, colibri::latency brings those from `at` on.
 */
export const withHistory = function (held: ReadonlyArray<[number, number]>, history: [number, number][], at: number): [number, number][] {
    return recentSamples([ ...history, ...held.filter(sample => sample[0] >= at) ]);
};

@Injectable({
    providedIn: 'root'
})
export class ClientService {
    private readonly _clients = signal<ReadonlyArray<ColibriClient>>([]);
    public readonly clients = this._clients.asReadonly();

    private lastRequest = 0;
    /** The `at` of the history each client had from the server: its live samples from before that were in it. */
    private readonly historyAt = new Map<string, number>();

    constructor() {
        const socketio = inject(SocketIOService);

        socketio
            .listen('colibri::latency')
            .subscribe(msg => {
                let changed = false;
                const clients = this._clients().map(client => {
                    const since = this.historyAt.get(client.id) ?? -Infinity;
                    const latency = (msg.payload[client.id] as [number, number][] | undefined)?.filter(sample => sample[0] >= since);
                    if (!latency?.length) {
                        return client;
                    }

                    changed = true;
                    return { ...client, latency: recentSamples([...client.latency, ...latency]) };
                });

                if (changed) {
                    this._clients.set(clients);
                }
            });

        socketio
            .listen(ADMIN_CHANNEL)
            .pipe(filter(msg => msg.command === 'latency'))
            .subscribe(msg => {
                const answer = msg.payload as LatencySnapshot | undefined;
                if (!answer || answer.request !== this.lastRequest || !Array.isArray(answer.clients)) return;

                const history = new Map(answer.clients.map(client => [ client.id, client.samples ]));
                this._clients.set(this._clients().map(client => {
                    const samples = history.get(client.id);
                    if (!samples) return client;
                    this.historyAt.set(client.id, answer.at);
                    return { ...client, latency: withHistory(client.latency, samples, answer.at) };
                }));
            });

        socketio
            .listen('colibri::clients')
            .subscribe(msg => {
                if (msg.command === 'client::connected') {
                    const taken = new Set(this._clients().map(c => c.slot));
                    let slot = 0;
                    while (taken.has(slot)) slot++;

                    const client = {
                        ...msg.payload,
                        latency: [],
                        slot
                    };
                    this._clients.set([...this._clients(), client]);
                } else if (msg.command === 'client::disconnected') {
                    this._clients.set(this._clients().filter(c => c.id !== msg.payload.id));
                    this.historyAt.delete(msg.payload.id);
                } else {
                    console.error('unknown client command', msg);
                }
            });

        // The clients, then their latency of the last two minutes: the server answers in order, so
        // the history finds them listed.
        const request = () => {
            socketio.emit('colibri::clients', 'client::request', {});
            socketio.emit(ADMIN_CHANNEL, 'request', { topic: 'latency', request: ++this.lastRequest });
        };
        request();

        // clients that left while the connection was down were never reported
        socketio.reconnected$.subscribe(() => {
            this._clients.set([]);
            this.historyAt.clear();
            request();
        });
    }

}
