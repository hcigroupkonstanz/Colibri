// Inbound overload handling for the TCP worker and the Socket.IO server.
import { COLIBRI_CHANNEL } from '../protocol/protocol.js';
import { nestsDeeperThan } from '../protocol/payload.js';

// The channel ClientLogger listens on.
const LOG_CHANNEL = 'log';

export const MODEL_UPDATE_COMMAND = 'model::update';

// Only model::update and broadcast::* are limited. An update is held back and merged per object
// instead of dropped: it is a delta, so a dropped one could lose a field change for good. A
// broadcast has no stored state to merge into and is dropped.
// Everything else passes because nothing would repair its loss: model::request, model::delete,
// log lines and the 'colibri' channel.
export const isLimitable = function (channel: string, command: string): boolean {
    if (channel === COLIBRI_CHANNEL || channel === LOG_CHANNEL) return false;
    return command === MODEL_UPDATE_COMMAND || command.startsWith('broadcast::');
};

// 'held': a model::update held back, passed on later.
// 'dropped': a broadcast, or a model::update the server could not apply anyway.
// 'lost': a model::update for one object more than MAX_HELD_OBJECTS. Nothing sends it again, so
// the store and the other clients only get the object after its next update.
export type Limited = 'held' | 'dropped' | 'lost';

// An episode ends after this long without a message over the limit. A load right at the limit goes
// over in bursts, which this keeps as one episode.
export const EPISODE_QUIET_MILLIS = 1000;

// An episode is only warned about once it has lasted this long. A main thread stall (a long GC,
// say) can briefly fill the backlog at a load the server otherwise keeps up with.
export const EPISODE_WARNING_MILLIS = 1000;

export interface EpisodeSummary {
    // Counts per Limited outcome.
    held: number;
    dropped: number;
    lost: number;
    // From the first message over the limit to the last.
    seconds: number;
    // The episode lasted EPISODE_WARNING_MILLIS, so its start was warned about.
    warned: boolean;
}

// Whether the summary is logged as a warning rather than at debug level. An episode that lost
// updates always warns, however short (a burst can be over in well under a second): a debug line is
// below the default log level.
export const warnsAtEnd = function (summary: EpisodeSummary): boolean {
    return summary.warned || summary.lost > 0;
};

// One stretch over a limit, from the first limited message until EPISODE_QUIET_MILLIS pass without
// another. The caller logs at most two lines per episode: record() returns true once, when the
// episode is long enough to warn about, and endIfQuiet() or end() hand back the summary.
export class LimitEpisode {
    private held = 0;
    private dropped = 0;
    private lost = 0;
    private startedAt = 0;
    private lastAt = 0;
    private warned = false;

    public get active(): boolean {
        return this.held + this.dropped + this.lost > 0;
    }

    // True for the first message at least EPISODE_WARNING_MILLIS into the episode.
    public record(now: number, limited: Limited): boolean {
        if (!this.active) {
            this.startedAt = now;
            this.warned = false;
        }
        this.lastAt = now;

        if (limited === 'held') this.held += 1;
        else if (limited === 'lost') this.lost += 1;
        else this.dropped += 1;

        if (this.warned || now - this.startedAt < EPISODE_WARNING_MILLIS) return false;
        this.warned = true;
        return true;
    }

    public endIfQuiet(now: number): EpisodeSummary | undefined {
        if (!this.active || now - this.lastAt < EPISODE_QUIET_MILLIS) return undefined;
        return this.end();
    }

    public end(): EpisodeSummary | undefined {
        if (!this.active) return undefined;

        const summary = {
            held: this.held,
            dropped: this.dropped,
            lost: this.lost,
            seconds: (this.lastAt - this.startedAt) / 1000,
            warned: this.warned,
        };
        this.held = 0;
        this.dropped = 0;
        this.lost = 0;
        this.warned = false;
        return summary;
    }
}

export const describeEpisode = function (summary: EpisodeSummary): string {
    const parts: string[] = [];
    if (summary.held > 0) parts.push(`held back ${summary.held} model::update(s), merged per object`);
    if (summary.dropped > 0) parts.push(`dropped ${summary.dropped} message(s)`);
    if (summary.lost > 0) parts.push(`lost ${summary.lost} model::update(s) for good`);
    return `${parts.join(' and ')} over ${summary.seconds.toFixed(1)} s`;
};

// Appended to the summary of an episode that lost updates, leading space included; empty otherwise.
export const lostUpdatesNote = function (summary: EpisodeSummary): string {
    if (summary.lost === 0) return '';
    return (
        ` The ${summary.lost} lost were for more objects than the ${MAX_HELD_OBJECTS} one client can have held back at once ` +
        '(MAX_HELD_OBJECTS): those objects reach the store and the other clients only when they change again.'
    );
};

// A model::update the server can apply: an object with a string id, nested no deeper than
// MAX_PAYLOAD_DEPTH (the test ModelSynchronization makes). Held updates are serialized again with
// JSON.stringify, which overflows the stack on deep nesting, so anything else is dropped, not held.
export type ModelUpdate = Record<string, unknown> & { id: string };

export const asModelUpdate = function (value: unknown): ModelUpdate | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    if (typeof (value as { id?: unknown }).id !== 'string') return undefined;
    return nestsDeeperThan(value) ? undefined : (value as ModelUpdate);
};

export interface HeldUpdate {
    channel: string;
    model: ModelUpdate;
}

// Per client. Far above any typical scene; it only bounds the memory a client creating objects in a
// runaway loop can take.
export const MAX_HELD_OBJECTS = 1000;

// The model updates one client sent while over a limit, merged per object and kept in the order
// each object was first held.
//
// The store (DataStore.updateModel) and the receiving clients both merge a delta field by field,
// so applying two in turn equals applying their merge once. Merging skips intermediate states but
// the latest value of every field still arrives; a dropped delta would be lost for good.
export class HeldUpdates {
    private readonly byObject = new Map<string, HeldUpdate>();

    public get size(): number {
        return this.byObject.size;
    }

    // Merges `model` into the update held for its object. Returns false, holding nothing, if that
    // would be one object more than MAX_HELD_OBJECTS.
    public hold(channel: string, model: ModelUpdate): boolean {
        const key = `${channel}\u0000${model.id}`;
        let held = this.byObject.get(key);
        if (!held) {
            if (this.byObject.size >= MAX_HELD_OBJECTS) return false;
            // No prototype, so a field called __proto__ is merged as data like any other.
            held = { channel, model: Object.create(null) as ModelUpdate };
            this.byObject.set(key, held);
        }

        for (const field of Object.keys(model)) {
            held.model[field] = model[field];
        }
        return true;
    }

    // The update held the longest.
    public shift(): HeldUpdate | undefined {
        for (const [key, held] of this.byObject) {
            this.byObject.delete(key);
            return held;
        }
        return undefined;
    }

    public takeAll(): HeldUpdate[] {
        const all = Array.from(this.byObject.values());
        this.byObject.clear();
        return all;
    }
}

export interface RateLimit {
    // Sustained limitable messages a second per client. 0 turns the limit off.
    messagesPerSecond: number;
    // How many it may send at once after a quieter stretch.
    burst: number;
}

// Well above any legitimate client (a Quest syncing 10 objects at 72 Hz sends 720 updates a second),
// so it only bites on a runaway loop, e.g. a send in Update() with nothing changing, which alone can
// saturate the server for everyone.
export const DEFAULT_RATE_LIMIT: RateLimit = { messagesPerSecond: 1000, burst: 2000 };

// Refills on take(). `now` is in milliseconds.
export class TokenBucket {
    private tokens: number;
    private refilledAt: number;

    public constructor(private readonly limit: RateLimit, now: number) {
        this.tokens = limit.burst;
        this.refilledAt = now;
    }

    public take(now: number): boolean {
        if (now > this.refilledAt) {
            this.tokens = Math.min(this.limit.burst, this.tokens + ((now - this.refilledAt) * this.limit.messagesPerSecond) / 1000);
            this.refilledAt = now;
        }

        if (this.tokens < 1) return false;
        this.tokens -= 1;
        return true;
    }
}

export interface RateLimitReporter<K> {
    // The client has been over the limit for EPISODE_WARNING_MILLIS.
    started(client: K): void;
    // The client was under the limit for EPISODE_QUIET_MILLIS, or (`left`) disconnected. Called for
    // every episode; `summary.warned` says whether started() was called for it.
    ended(client: K, summary: EpisodeSummary, left: boolean): void;
}

// A token bucket and an episode per client, for limitable messages only. Shared by both
// transports; K is the transport's per-client object. take() and record() are separate because a
// held update retried later must not be recorded again.
export class InboundRateLimiter<K> {
    private readonly clients = new Map<K, { bucket: TokenBucket; episode: LimitEpisode }>();
    // Clients with an open episode, so sweep() never walks every connected client.
    private readonly limited = new Set<K>();

    public constructor(
        public readonly limit: RateLimit,
        private readonly reporter: RateLimitReporter<K>
    ) {}

    public take(client: K, now: number): boolean {
        if (this.limit.messagesPerSecond <= 0) return true;
        return this.stateOf(client, now).bucket.take(now);
    }

    public record(client: K, now: number, limited: Limited): void {
        // sweep() has to end every episode, not only warned ones: an open one would take the next
        // episode's messages as its own, however much later.
        this.limited.add(client);
        if (this.stateOf(client, now).episode.record(now, limited)) {
            this.reporter.started(client);
        }
    }

    // Whether the client has an open episode. For the admin UI.
    public isLimited(client: K): boolean {
        return this.limited.has(client);
    }

    // Ends and reports every quiet episode. Call it periodically.
    public sweep(now: number): void {
        for (const client of this.limited) {
            const summary = this.clients.get(client)?.episode.endIfQuiet(now);
            if (!summary) continue;

            this.limited.delete(client);
            this.reporter.ended(client, summary, false);
        }
    }

    // Reports the client's open episode, if any, and drops its state.
    public forget(client: K): void {
        const summary = this.clients.get(client)?.episode.end();
        this.clients.delete(client);
        this.limited.delete(client);
        if (summary) this.reporter.ended(client, summary, true);
    }

    private stateOf(client: K, now: number): { bucket: TokenBucket; episode: LimitEpisode } {
        let state = this.clients.get(client);
        if (!state) {
            state = { bucket: new TokenBucket(this.limit, now), episode: new LimitEpisode() };
            this.clients.set(client, state);
        }
        return state;
    }
}

// What both limits' warnings say happens to a limited client's messages.
export const LIMITED_TRAFFIC =
    'its model updates are held back and merged per object (intermediate states are skipped, the latest ' +
    'value of every field still arrives) and its broadcast::* messages are dropped';

export const rateLimitStartWarning = function (who: string, limit: RateLimit): string {
    return (
        `${who} has been sending more than ${limit.messagesPerSecond} model::update and broadcast::* messages a second ` +
        `(CLIENT_MESSAGE_RATE_LIMIT, bursts up to CLIENT_MESSAGE_RATE_BURST=${limit.burst}) for a second now. Until it slows down, ` +
        `${LIMITED_TRAFFIC}. The usual cause is something sending every frame without a rate cap.`
    );
};

// The text only; the caller logs it as a warning if warnsAtEnd, else at debug level.
export const rateLimitEndWarning = function (who: string, summary: EpisodeSummary, left: boolean): string {
    const over = summary.warned ? 'over the message rate limit' : 'briefly over the message rate limit';
    const text = left
        ? `${who} disconnected while ${over}; ${describeEpisode(summary)}.`
        : summary.warned
            ? `${who} is back under the message rate limit; ${describeEpisode(summary)}.`
            : `${who} was ${over}; ${describeEpisode(summary)}.`;
    return text + lostUpdatesNote(summary);
};

// Worker side of the count of TCP messages posted to the main thread and not yet dispatched there.
// The counter is an Int32 in a SharedArrayBuffer owned by TCPServerProxy: this side increments it
// per clientMessage$ it posts, the proxy decrements it on dispatch. It is the only way for the
// worker to see the main thread falling behind; the posted messages would otherwise queue as
// structured clones in memory without bound.
export class InboundBacklog {
    // `counter` absent means nobody decrements, so nothing is counted either.
    public constructor(
        private readonly counter: Int32Array | undefined,
        // 0 turns the limit off; the backlog is still counted.
        public readonly limit: number
    ) {}

    public get pending(): number {
        return this.counter ? Atomics.load(this.counter, 0) : 0;
    }

    public posted(): void {
        if (this.counter) Atomics.add(this.counter, 0, 1);
    }

    public get full(): boolean {
        return this.limit > 0 && this.pending >= this.limit;
    }
}
