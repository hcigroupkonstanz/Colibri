// What the server does with incoming messages when it, or one client, is taking in more than it can
// process - and the bookkeeping that makes that visible in the log instead of silent.
import { COLIBRI_CHANNEL } from './protocol.js';

// The channel ClientLogger listens on.
const LOG_CHANNEL = 'log';

export const MODEL_UPDATE_COMMAND = 'model::update';

// Whether a message is subject to the inbound limits (the TCP backlog limit and the per-client rate
// limit). Only the two commands that make up the bulk of a sync loop's traffic are:
//
// - model::update is held back and merged per object, never dropped (see HeldUpdates): it is a
//   delta of the fields that changed, not an object's whole state, so a dropped one could lose a
//   field change for good - in every other client and in the server's store alike.
// - broadcast::* is fire-and-forget application traffic with no stored state, so there is nothing
//   to merge it into, and it is dropped.
//
// Nothing else is ever held back or dropped, because nothing later would repair the loss: the
// handshake and heartbeats (not messages at all), model::request (a client waiting for its initial
// state), model::delete (an object that would never go away), a client's log lines, and anything on
// the 'colibri' channel (latency replies, protocol messages, the admin UI).
export const isLimitable = function (channel: string, command: string): boolean {
    if (channel === COLIBRI_CHANNEL || channel === LOG_CHANNEL) return false;
    return command === MODEL_UPDATE_COMMAND || command.startsWith('broadcast::');
};

// What happened to a message over a limit:
// - 'held': a model::update held back, to be merged and passed on later (see HeldUpdates).
// - 'dropped': a broadcast::*, or an update the server could not have applied anyway.
// - 'lost': a model::update that could neither pass nor be held back, for one object more than
//   MAX_HELD_OBJECTS. Unlike a dropped broadcast it is state that nothing sends again: the object
//   reaches the store and the other clients only when it changes again.
export type Limited = 'held' | 'dropped' | 'lost';

// An episode is over once nothing has been over the limit for this long. Long enough that a load
// sitting right at the limit - over it in bursts with gaps between them - is one episode with one
// pair of log lines rather than a pair every few hundred milliseconds.
export const EPISODE_QUIET_MILLIS = 1000;

// How long an episode has to go on before it is worth a warning. The main thread stalling for a
// few hundred milliseconds - a long garbage collection, say - can fill the backlog at a load the
// server otherwise keeps up with, and empty it again just as quickly; the warning that used to
// follow each of those said the server was overloaded when it was not. An overload that matters
// lasts, and is warned about a second in.
export const EPISODE_WARNING_MILLIS = 1000;

export interface EpisodeSummary {
    // model::update messages held back (and merged per object) rather than passed on at once.
    held: number;
    // Broadcasts dropped, and updates the server could not have applied anyway.
    dropped: number;
    // model::update messages lost for good: see Limited.
    lost: number;
    // From the first message over the limit to the last.
    seconds: number;
    // Whether the episode lasted long enough to be warned about (see EPISODE_WARNING_MILLIS). The
    // caller sums up such an episode as a warning too, and a shorter one at debug level - unless it
    // lost updates (see warnsAtEnd).
    warned: boolean;
}

// Whether the summary of an episode is a warning rather than a debug line: one long enough to have
// been warned about, or one that lost model updates, however short. A client creating a few
// thousand objects at once is over its limit for well under a second, and the objects past
// MAX_HELD_OBJECTS were lost with nothing but a debug line, below the default log level, to say so.
export const warnsAtEnd = function (summary: EpisodeSummary): boolean {
    return summary.warned || summary.lost > 0;
};

// One stretch of being over a limit, from the first message held back or dropped until
// EPISODE_QUIET_MILLIS pass without another. The caller logs a warning when record() says the
// episode has gone on for EPISODE_WARNING_MILLIS, and a summary when endIfQuiet() or end() hands
// one back - at most two warnings per episode however much happens in between, the same way the
// egress 'dropping' state in TCPServerWorker.writeToClient logs only transitions.
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

    // Returns true for the one message that makes the episode worth a warning: the first that is
    // still over the limit EPISODE_WARNING_MILLIS after the episode began.
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

// The sentence that follows an episode's summary when it lost updates, with a space ahead of it;
// otherwise nothing.
export const lostUpdatesNote = function (summary: EpisodeSummary): string {
    if (summary.lost === 0) return '';
    return (
        ` The ${summary.lost} lost were for more objects than the ${MAX_HELD_OBJECTS} one client can have held back at once ` +
        '(MAX_HELD_OBJECTS): those objects reach the store and the other clients only when they change again.'
    );
};

// A model::update payload the server can apply: a JSON object with a string id, the same test
// ModelSynchronization makes. Anything else is passed on or dropped as it is, never merged.
export type ModelUpdate = Record<string, unknown> & { id: string };

export const asModelUpdate = function (value: unknown): ModelUpdate | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    return typeof (value as { id?: unknown }).id === 'string' ? (value as ModelUpdate) : undefined;
};

export interface HeldUpdate {
    channel: string;
    model: ModelUpdate;
}

// How many objects one client may have updates held back for at once. Far beyond any typical scene;
// it only bounds the memory a client creating new objects in a runaway loop can take up.
export const MAX_HELD_OBJECTS = 1000;

// The model updates one client sent while over a limit, merged per object and kept in the order
// each object was first held, until there is room to pass them on.
//
// A model::update is a delta: colibri-unity and colibri-web both send only the fields that changed.
// The store merges each into the object field by field (DataStore.updateModel) and so does every
// receiving client, so applying two deltas in turn is the same as applying their field-by-field
// merge once. Holding updates back and merging them therefore skips intermediate states but never
// loses a field: the latest value of every field still arrives, just later. Dropping a delta
// instead - say the one that set a synced bool - would have lost that change for every other
// client and in the store, with nothing ever sending it again.
export class HeldUpdates {
    private readonly byObject = new Map<string, HeldUpdate>();

    public get size(): number {
        return this.byObject.size;
    }

    // Merges `model` into whatever is held for its object. Returns false, holding nothing, if that
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
    // Limitable messages a second a single client may send, sustained. 0 turns the limit off.
    messagesPerSecond: number;
    // How many it may send at once, after a quieter stretch.
    burst: number;
}

// Well above what any legitimate client sends - a Quest syncing 10 objects at 72 Hz sends 720
// updates a second - so this only ever bites on a runaway loop: a sync without a rate cap, or a
// send in Update() with nothing changing, which on its own can saturate the server for everyone.
export const DEFAULT_RATE_LIMIT: RateLimit = { messagesPerSecond: 1000, burst: 2000 };

// The classic token bucket: holds up to `burst` tokens, refills at `messagesPerSecond`, and a
// message passes only if it can take one.
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
    // A client has been over the limit for EPISODE_WARNING_MILLIS since it was last under it.
    started(client: K): void;
    // The client has been under the limit for EPISODE_QUIET_MILLIS, or (`left`) disconnected.
    // Called for every episode; `summary.warned` says whether started() was called for this one.
    ended(client: K, summary: EpisodeSummary, left: boolean): void;
}

// A token bucket per client, for limitable messages only (see isLimitable), plus one episode per
// client so each stretch over the limit is reported once rather than per message. Shared by both
// transports; K is whatever object the transport keeps per client. Taking a token and recording
// what became of a message that could not have one are separate, because a held-back update
// retried later must not be counted again.
export class InboundRateLimiter<K> {
    private readonly clients = new Map<K, { bucket: TokenBucket; episode: LimitEpisode }>();
    // Only these can have an episode to end, so sweep() never walks every connected client.
    private readonly limited = new Set<K>();

    public constructor(
        public readonly limit: RateLimit,
        private readonly reporter: RateLimitReporter<K>
    ) {}

    // Whether this client may pass on one more limitable message now.
    public take(client: K, now: number): boolean {
        if (this.limit.messagesPerSecond <= 0) return true;
        return this.stateOf(client, now).bucket.take(now);
    }

    // What became of a message from this client that take() refused.
    public record(client: K, now: number, limited: Limited): void {
        // Every episode has to be ended by sweep(), not only those long enough to be warned about:
        // one left open would take the next episode's messages, however much later, as its own.
        this.limited.add(client);
        if (this.stateOf(client, now).episode.record(now, limited)) {
            this.reporter.started(client);
        }
    }

    // Whether the client is over its limit now: it had a message held back or dropped within the
    // last EPISODE_QUIET_MILLIS. For the admin UI.
    public isLimited(client: K): boolean {
        return this.limited.has(client);
    }

    // Reports the end of every episode that has gone quiet. Call it periodically.
    public sweep(now: number): void {
        for (const client of this.limited) {
            const summary = this.clients.get(client)?.episode.endIfQuiet(now);
            if (!summary) continue;

            this.limited.delete(client);
            this.reporter.ended(client, summary, false);
        }
    }

    // For a client that has gone: reports its episode if it was in one, and lets go of it.
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

// What a client over a limit is told happens to its messages, in both limits' warnings.
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

// The summary of an episode: a warning for one warnsAtEnd says is one, a debug line otherwise.
export const rateLimitEndWarning = function (who: string, summary: EpisodeSummary, left: boolean): string {
    const over = summary.warned ? 'over the message rate limit' : 'briefly over the message rate limit';
    const text = left
        ? `${who} disconnected while ${over}; ${describeEpisode(summary)}.`
        : summary.warned
            ? `${who} is back under the message rate limit; ${describeEpisode(summary)}.`
            : `${who} was ${over}; ${describeEpisode(summary)}.`;
    return text + lostUpdatesNote(summary);
};

// The worker side of the count of TCP messages posted to the main thread and not yet dispatched
// there - the depth of the worker->main MessagePort queue, which nothing else can observe.
//
// The counter is an Int32 in a SharedArrayBuffer that TCPServerProxy owns: this side increments it
// for every clientMessage$ it posts, the proxy decrements it once that message has been dispatched.
// Without it the worker had no way to know the main thread was behind, kept posting at the rate
// clients sent, and the queue - every message in it a structured clone held in memory - grew
// without bound until the process was killed for running out of memory, while clients stayed
// connected and saw state that was seconds old.
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

    // Without a counter, pending is always 0 and so never reaches a limit.
    public get full(): boolean {
        return this.limit > 0 && this.pending >= this.limit;
    }
}
