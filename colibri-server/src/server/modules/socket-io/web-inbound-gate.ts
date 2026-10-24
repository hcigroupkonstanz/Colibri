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
    // Passes a client message on to messages$, synchronously: the callers' ordering depends on it.
    emit(msg: NetworkMessage): void;
    logDebug(msg: string, metadata: Metadata): void;
    logWarning(msg: string, metadata: Metadata): void;
}

// The SocketIOServer's per-client rate limit and the model updates it holds back.
export class WebInboundGate {
    // The same per-client limit as the TCP worker's: updates over it are held back and merged,
    // broadcasts dropped.
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

    // A model::update or broadcast::* (see isLimitable) from a client: passed on at once while it is
    // under its rate limit and has nothing held back, otherwise held or dropped. Like the TCP
    // worker's InboundGate, minus the backlog limit: a Socket.IO message is handled as it is read,
    // so there is no queue to bound.
    public acceptLimitable(msg: NetworkMessage & { origin: NetworkClient }, value: unknown, now: number): void {
        const client = msg.origin;
        if (this.drainHeld(client, now) && this.rateLimiter.take(client, now)) {
            this.callbacks.emit(msg);
            return;
        }

        // A broadcast, or an update the server could not apply anyway, is dropped; one over
        // MAX_HELD_OBJECTS is lost (see Limited).
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

    // Passes on every held update of the client regardless of the limit: before a message that must
    // not overtake them, and when it leaves.
    public releaseHeld(client: NetworkClient): void {
        const held = this.heldUpdates.get(client);
        if (!held) return;

        this.heldUpdates.delete(client);
        for (const update of held.takeAll()) this.emitHeld(client, update);
    }

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

    public heldSize(client: NetworkClient): number {
        return this.heldUpdates.get(client)?.size ?? 0;
    }

    public isLimited(client: NetworkClient): boolean {
        return this.rateLimiter.isLimited(client);
    }
}
