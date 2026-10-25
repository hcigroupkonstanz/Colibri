import { Injectable, inject, signal } from '@angular/core';
import { filter } from 'rxjs';
import type { LatencySnapshot } from './admin.service';
import { ADMIN_CHANNEL } from './admin.service';
import { SocketIOService } from './socketio.service';

export interface ColibriClient {
    id: string;
    app: string;
    name: string;
    version: string;
    latency: [number, number][];
    /** Colour slot on the Clients page: the lowest free when the client connected, kept until it leaves (the list index shifts). */
    slot: number;
}

interface ClientEvent {
    command: string;
    payload: Omit<ColibriClient, 'latency' | 'slot'>;
}

/** How long a client's latency samples are kept, by the server's clock: the chart's 120 s plus the 2 s it slides. */
export const LATENCY_KEEP_MILLIS = 122_000;
// What the server keeps: 125 s of 100 ms pings.
const MAX_LATENCY_SAMPLES = 1250;

/** The samples within LATENCY_KEEP_MILLIS of the newest one, at most MAX_LATENCY_SAMPLES. */
export const recentSamples = function (samples: [number, number][]): [number, number][] {
    const newest = samples.at(-1)?.[0];
    if (newest === undefined) return samples;
    let first = Math.max(0, samples.length - MAX_LATENCY_SAMPLES);
    while (first < samples.length && samples[first][0] < newest - LATENCY_KEEP_MILLIS) first++;
    return first === 0 ? samples : samples.slice(first);
};

/** The server's history, which has every sample before `at`, followed by the held samples from `at` on. */
export const withHistory = function (held: ReadonlyArray<[number, number]>, history: [number, number][], at: number): [number, number][] {
    return recentSamples([ ...history, ...held.filter(sample => sample[0] >= at) ]);
};

@Injectable({
    providedIn: 'root'
})
export class ClientService {
    private readonly socketio = inject(SocketIOService);

    private readonly _clients = signal<ReadonlyArray<ColibriClient>>([]);
    public readonly clients = this._clients.asReadonly();

    private lastRequest = 0;
    /** Per client, the `at` of its history: live samples before it are already in the history. */
    private readonly historyAt = new Map<string, number>();

    public constructor() {
        this.socketio
            .listen('colibri::latency')
            .subscribe(msg => this.addLatency(msg.payload as Record<string, unknown>));

        this.socketio
            .listen(ADMIN_CHANNEL)
            .pipe(filter(msg => msg.command === 'latency'))
            .subscribe(msg => this.takeHistory(msg.payload as LatencySnapshot | undefined));

        this.socketio
            .listen('colibri::clients')
            .subscribe(msg => this.updateClients(msg as ClientEvent));

        this.request();

        // clients that left while the connection was down were never reported
        this.socketio.reconnected$.subscribe(() => {
            this._clients.set([]);
            this.historyAt.clear();
            this.request();
        });
    }

    private addLatency(payload: Record<string, unknown>): void {
        let changed = false;
        const clients = this._clients().map(client => {
            const since = this.historyAt.get(client.id) ?? -Infinity;
            const latency = (payload[client.id] as [number, number][] | undefined)?.filter(sample => sample[0] >= since);
            if (!latency?.length) {
                return client;
            }

            changed = true;
            return { ...client, latency: recentSamples([...client.latency, ...latency]) };
        });

        if (changed) {
            this._clients.set(clients);
        }
    }

    private takeHistory(answer: LatencySnapshot | undefined): void {
        if (!answer || answer.request !== this.lastRequest || !Array.isArray(answer.clients)) return;

        const history = new Map(answer.clients.map(client => [ client.id, client.samples ]));
        this._clients.set(this._clients().map(client => {
            const samples = history.get(client.id);
            if (!samples) return client;
            this.historyAt.set(client.id, answer.at);
            return { ...client, latency: withHistory(client.latency, samples, answer.at) };
        }));
    }

    private updateClients(msg: ClientEvent): void {
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
    }

    // The server answers in order, so the clients are listed when their history arrives.
    private request(): void {
        this.socketio.emit('colibri::clients', 'client::request', {});
        this.socketio.emit(ADMIN_CHANNEL, 'request', { topic: 'latency', request: ++this.lastRequest });
    }

}
