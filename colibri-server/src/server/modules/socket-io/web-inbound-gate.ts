import type { Metadata } from '../core/log-message.js';
import { Payload } from '../protocol/payload.js';
import type { NetworkClient, NetworkMessage } from '../protocol/network.js';
import type {
    HeldUpdate,
    RateLimit,
} from '../limits/inbound-limits.js';
import {
    DEFAULT_RATE_LIMIT,
    HeldUpdates,
    InboundRateLimiter,
    MODEL_UPDATE_COMMAND,
    asModelUpdate,
    rateLimitEndWarning,
    rateLimitStartWarning,
    warnsAtEnd,
} from '../limits/inbound-limits.js';
import { aboutClient } from './about-client.js';

// What WebInboundGate needs from the SocketIOServer that owns it.
interface WebInboundGateCallbacks {
    // Passes a client message on to the server's hooks (messages$), synchronously.
    emit(msg: NetworkMessage): void;
    logDebug(msg: string, metadata: Metadata): void;
    logWarning(msg: string, metadata: Metadata): void;
}

// The SocketIOServer's per-client rate limit and the model updates it holds back. One for the server's lifetime.
export class WebInboundGate {
    // The same per-client backstop as the TCP worker's, against a web client's runaway send loop,
    // with the same treatment of what is over it: updates held back and merged, broadcasts dropped.
    private rateLimiter = this.createRateLimiter(DEFAULT_RATE_LIMIT);
    private readonly heldUpdates = new Map<NetworkClient, HeldUpdates>();

    public constructor(private readonly callbacks: WebInboundGateCallbacks) {}

    public configure(limit: RateLimit): void {
        this.rateLimiter = this.createRateLimiter(limit);
    }

    private createRateLimiter(limit: RateLimit): InboundRateLimiter<NetworkClient> {
        const describe = (client: NetworkClient) => `Web client ${client.id} (app '${client.app}', ${client.name})`;
        return new InboundRateLimiter<NetworkClient>(limit, {
            started: (client) => this.callbacks.logWarning(rateLimitStartWarning(describe(client), limit), aboutClient(client)),
            ended: (client, summary, left) => {
                const text = rateLimitEndWarning(describe(client), summary, left);
                if (warnsAtEnd(summary)) this.callbacks.logWarning(text, aboutClient(client));
                else this.callbacks.logDebug(text, aboutClient(client));
            },
        });
    }

    // A model::update or broadcast::* (see isLimitable) from a client: on at once while it is
    // under its rate limit and has nothing held back, otherwise an update is held back and merged
    // per object (see HeldUpdates) and a broadcast dropped. Mirrors TCPServerWorker, minus the
    // backlog limit: a Socket.IO message is handled as it is read, so there is no queue to bound.
    public acceptLimitable(msg: NetworkMessage & { origin: NetworkClient }, value: unknown, now: number): void {
        const client = msg.origin;
        if (this.drainHeld(client, now) && this.rateLimiter.take(client, now)) {
            this.callbacks.emit(msg);
            return;
        }

        // A broadcast, or an update the server could not apply anyway, is dropped; an update for one
        // object too many is lost (see Limited).
        const model = msg.command === MODEL_UPDATE_COMMAND ? asModelUpdate(value) : undefined;
        if (!model) {
            this.rateLimiter.record(client, now, 'dropped');
            return;
        }

        let held = this.heldUpdates.get(client);
        if (!held) {
            held = new HeldUpdates();
            this.heldUpdates.set(client, held);
        }
        this.rateLimiter.record(client, now, held.hold(msg.channel, model) ? 'held' : 'lost');
    }

    // Passes on as many of the client's held updates as its rate limit allows, oldest first.
    // True once nothing is held any more.
    private drainHeld(client: NetworkClient, now: number): boolean {
        const held = this.heldUpdates.get(client);
        if (!held) return true;

        while (held.size > 0) {
            if (!this.rateLimiter.take(client, now)) return false;
            this.emitHeld(client, held.shift()!);
        }
        this.heldUpdates.delete(client);
        return true;
    }

    // Every held update regardless of the limit: before something from the same client that must
    // not overtake them, and when it leaves.
    public releaseHeld(client: NetworkClient): void {
        const held = this.heldUpdates.get(client);
        if (!held) return;

        this.heldUpdates.delete(client);
        for (const update of held.takeAll()) this.emitHeld(client, update);
    }

    // A client that left: its held updates go on, and the rate limit forgets it.
    public clientLeft(client: NetworkClient): void {
        this.releaseHeld(client);
        this.rateLimiter.forget(client);
    }

    private emitHeld(client: NetworkClient, update: HeldUpdate): void {
        this.callbacks.emit({
            origin: client,
            channel: update.channel,
            command: MODEL_UPDATE_COMMAND,
            payload: Payload.fromValue(update.model),
        });
    }

    // Passes on held updates as the clients' tokens refill, and reports finished episodes.
    public sweep(now: number): void {
        for (const client of Array.from(this.heldUpdates.keys())) this.drainHeld(client, now);
        this.rateLimiter.sweep(now);
    }

    // How many of the client's updates are held back.
    public heldSize(client: NetworkClient): number {
        return this.heldUpdates.get(client)?.size ?? 0;
    }

    public isLimited(client: NetworkClient): boolean {
        return this.rateLimiter.isLimited(client);
    }
}
