import { errorMessage } from '../../core/error-message.js';
import { ownBytes } from '../../protocol/protocol.js';
import type {
    HeldUpdate,
    Limited,
    RateLimit,
} from '../../limits/inbound-limits.js';
import {
    DEFAULT_RATE_LIMIT,
    EPISODE_QUIET_MILLIS,
    InboundBacklog,
    InboundRateLimiter,
    LIMITED_TRAFFIC,
    LimitEpisode,
    MODEL_UPDATE_COMMAND,
    asModelUpdate,
    describeEpisode,
    lostUpdatesNote,
    rateLimitEndWarning,
    rateLimitStartWarning,
    warnsAtEnd,
} from '../../limits/inbound-limits.js';
import type { TcpServerOptions } from '../worker-messages.js';
import type { Refusal, TcpClient } from './tcp-client.js';

// How many TCP messages may be waiting for the main thread before the worker starts holding back
// model updates and dropping broadcasts (see isLimitable). At the main thread's saturation point on
// a 4-core test machine (about 15k model::update/s) 2000 is roughly 130 ms of work: well clear of a
// normal burst, and short enough that what does get through is not seconds old.
const DEFAULT_INBOUND_BACKLOG_LIMIT = 2000;

interface InboundGateCallbacks {
    postMessage(channel: string, content: { [key: string]: unknown }): void;
    logDebug(msg: string): void;
    logWarning(msg: string): void;
}

// The TCP worker's inbound limits (TCP_INBOUND_BACKLOG_LIMIT and the per-client rate limit): every
// client message for the main thread's hooks is posted through it, and model updates over a limit
// wait in it.
export class InboundGate {
    private inboundBacklog = new InboundBacklog(undefined, DEFAULT_INBOUND_BACKLOG_LIMIT);
    // At most two log lines per episode (its start once it has lasted EPISODE_WARNING_MILLIS, and its
    // end), not one per message: under overload that is thousands of posts a second to the thread that
    // is already behind. A shorter episode only gets a summary at its end.
    private readonly backlogEpisode = new LimitEpisode();
    // Clients with updates held back, for the tick to pass on as room frees up.
    private readonly clientsHolding = new Set<TcpClient>();

    // The backstop for one runaway client, which alone can push the main thread into the backlog limit
    // and so slow every other client's updates down too.
    private rateLimiter = this.createRateLimiter(DEFAULT_RATE_LIMIT);

    public constructor(private readonly callbacks: InboundGateCallbacks) {}

    public configure(options: Pick<TcpServerOptions, 'inboundBacklog' | 'inboundBacklogLimit' | 'rateLimit'>): void {
        this.inboundBacklog = new InboundBacklog(
            options.inboundBacklog,
            options.inboundBacklogLimit ?? DEFAULT_INBOUND_BACKLOG_LIMIT
        );
        this.rateLimiter = this.createRateLimiter(options.rateLimit ?? DEFAULT_RATE_LIMIT);
    }

    private createRateLimiter(limit: RateLimit): InboundRateLimiter<TcpClient> {
        const describe = (client: TcpClient) => `Unity client '${client.name}' (${client.id}, app '${client.app}', ${client.address})`;
        return new InboundRateLimiter<TcpClient>(limit, {
            started: (client) => this.callbacks.logWarning(rateLimitStartWarning(describe(client), limit)),
            ended: (client, summary, left) => {
                const text = rateLimitEndWarning(describe(client), summary, left);
                if (warnsAtEnd(summary)) this.callbacks.logWarning(text);
                else this.callbacks.logDebug(text);
            },
        });
    }

    // Called from the worker's tick; `now` is performance.now().
    public tick(now: number): void {
        this.drainAllHeld(now);
        this.rateLimiter.sweep(now);
        this.endBacklogEpisodeIfQuiet(now);
    }

    private endBacklogEpisodeIfQuiet(now: number): void {
        const backlogSummary = this.backlogEpisode.endIfQuiet(now);
        if (backlogSummary?.warned) {
            this.callbacks.logWarning(
                `The main thread has caught up with TCP messages again; ${describeEpisode(backlogSummary)} while it was behind.` +
                    lostUpdatesNote(backlogSummary)
            );
        } else if (backlogSummary) {
            const text =
                `The main thread was briefly ${this.inboundBacklog.limit} TCP messages behind (TCP_INBOUND_BACKLOG_LIMIT) and has ` +
                `caught up; ${describeEpisode(backlogSummary)} while it was behind.` +
                lostUpdatesNote(backlogSummary);
            if (warnsAtEnd(backlogSummary)) this.callbacks.logWarning(text);
            else this.callbacks.logDebug(text);
        }
    }

    // The limit holding the client's updates back now: the one that last refused one of its
    // messages, as long as it still has updates held back or was refused within the last
    // EPISODE_QUIET_MILLIS (a client that only sends broadcasts never has anything held).
    public limitOf(client: TcpClient, now: number): Refusal | null {
        if (!client.limitedBy) return null;
        if (client.held.size > 0 || now - client.limitedAt < EPISODE_QUIET_MILLIS) return client.limitedBy;
        return null;
    }

    // Objects with updates held back.
    public heldSize(client: TcpClient): number {
        return client.held.size;
    }

    // Every message for the main thread's hooks goes through here, so each one is counted in the
    // backlog that TCPServerProxy counts back down once it has been dispatched.
    public postClientMessage(client: TcpClient, channel: string, command: string, payload: Buffer): void {
        this.inboundBacklog.posted();
        this.callbacks.postMessage('clientMessage$', {
            channel,
            command,
            payload,
            origin: {
                id: client.id,
                app: client.app,
                name: client.name,
                version: client.version,
                metadata: {},
            },
        });
    }

    // A model::update or broadcast::* (see isLimitable). It passes on if neither limit is in the way
    // and none of this client's updates are held back, which is every message while the server keeps
    // up. Otherwise an update is held and merged with the client's other updates to the same object,
    // and a broadcast is dropped.
    // Past the backlog limit further messages would only age in the queue; merging per object bounds
    // memory and age without losing any field's latest value.
    public acceptLimitable(client: TcpClient, channel: string, command: string, payload: Buffer, now: number): void {
        // Held updates go first, so this message cannot overtake them; if they cannot all go,
        // neither can it.
        const refusedBy = this.drainHeld(client, now) ?? this.admit(client, now);
        if (!refusedBy) {
            this.postClientMessage(client, channel, command, payload);
            return;
        }

        // A broadcast is dropped; see hold() for an update.
        const limited = command === MODEL_UPDATE_COMMAND ? this.hold(client, channel, payload) : 'dropped';
        this.recordLimited(client, refusedBy, limited, now);
    }

    // Which limit, if any, keeps a client from passing on one more limitable message now. The backlog
    // is checked first so a token is only spent on a message that goes on, not twice for one held back.
    private admit(client: TcpClient, now: number): Refusal | undefined {
        if (this.inboundBacklog.full) return 'backlog';
        if (!this.rateLimiter.take(client, now)) return 'rate';
        return undefined;
    }

    // Holds a model update back. It is dropped if the server could not apply it anyway (not a JSON
    // object with a string id, which ModelSynchronization refuses), and lost if it is for one object
    // too many (see Limited).
    private hold(client: TcpClient, channel: string, payload: Buffer): Limited {
        let model;
        try {
            model = asModelUpdate(JSON.parse(payload.toString('utf8')));
        } catch {
            return 'dropped';
        }
        if (!model) return 'dropped';
        if (!client.held.hold(channel, model)) return 'lost';

        this.clientsHolding.add(client);
        return 'held';
    }

    // Passes on as many of the client's held updates as the limits allow, oldest first. Returns
    // the limit that stopped it, or undefined once nothing is held any more.
    private drainHeld(client: TcpClient, now: number): Refusal | undefined {
        // The case for every message while the server keeps up.
        if (client.held.size === 0) return undefined;

        while (client.held.size > 0) {
            // The backlog first, so a full one does not cost the client a token.
            if (this.inboundBacklog.full) return 'backlog';
            if (!this.rateLimiter.take(client, now)) return 'rate';
            this.postHeld(client, client.held.shift()!);
        }
        this.clientsHolding.delete(client);
        return undefined;
    }

    // Every held update, regardless of the limits: before something from the same client that
    // must not overtake them, and when it leaves. There are at most MAX_HELD_OBJECTS of them.
    public releaseHeld(client: TcpClient): void {
        if (client.held.size === 0) return;

        for (const update of client.held.takeAll()) this.postHeld(client, update);
        this.clientsHolding.delete(client);
    }

    // Posts the held updates of a client that left and drops its rate limit state.
    public clientLeft(client: TcpClient): void {
        this.releaseHeld(client);
        this.rateLimiter.forget(client);
    }

    // The tick's share of whatever room there is: one update per holding client per round, so under
    // a sustained overload every client's objects keep moving instead of the first in line taking all.
    private drainAllHeld(now: number): void {
        let progressed = true;
        while (progressed && this.clientsHolding.size > 0) {
            progressed = false;
            for (const client of this.clientsHolding) {
                if (this.inboundBacklog.full) return;
                if (!this.rateLimiter.take(client, now)) continue;

                const update = client.held.shift();
                if (update) {
                    this.postHeld(client, update);
                    progressed = true;
                }
                if (client.held.size === 0) this.clientsHolding.delete(client);
            }
        }
    }

    private postHeld(client: TcpClient, update: HeldUpdate): void {
        // asModelUpdate keeps the nesting that overflows JSON.stringify out of `held`. Should
        // anything else make it throw, one update is lost, not the worker and every Unity client
        // on it.
        let json: string;
        try {
            json = JSON.stringify(update.model);
        } catch (err) {
            this.callbacks.logWarning(
                `Dropped a held model::update for '${update.model.id}' on channel '${update.channel}' from client ${client.id}: ` +
                    `it could not be written out again (${errorMessage(err)})`
            );
            return;
        }
        this.postClientMessage(client, update.channel, MODEL_UPDATE_COMMAND, ownBytes(Buffer.from(json, 'utf8')));
    }

    private recordLimited(client: TcpClient, refusedBy: Refusal, limited: Limited, now: number): void {
        client.limitedBy = refusedBy;
        client.limitedAt = now;
        if (refusedBy === 'rate') {
            this.rateLimiter.record(client, now, limited);
            return;
        }

        if (this.backlogEpisode.record(now, limited)) {
            // The limit, not a fresh read of the counter: the main thread may have counted down since
            // `full` read it, and "1998 behind, limit 2000" confuses.
            this.callbacks.logWarning(
                `The main thread has kept falling ${this.inboundBacklog.limit} TCP messages behind (TCP_INBOUND_BACKLOG_LIMIT) for a ` +
                    'second now: the server is taking in more than it can process. Until it catches up, for every Unity client ' +
                    `${LIMITED_TRAFFIC}, ` +
                    'so synced objects move less smoothly. Fewer synced objects, a lower sync rate or fewer clients per app reduce the load.'
            );
        }
    }
}
