import type { NetworkClient } from '../protocol/network.js';
import { RATE_WINDOW_MILLIS, TrafficMeter } from '../limits/client-activity.js';

// A web client's message counts, for the admin UI. What it sends is counted on arrival. Room
// messages (broadcastToApp) are counted once per room, not per member, so a room emit stays one
// step: a client was sent every room message since it joined, less those it was left out of.
export interface WebTraffic {
    readonly meter: TrafficMeter;
    // Messages emitted to it alone (broadcast()).
    direct: number;
    // Room messages it was left out of, as their sender.
    excluded: number;
    // The room's count when it joined.
    readonly roomBase: number;
}

// What WebTrafficCounter needs from the SocketIOServer that owns it.
interface WebTrafficCounterCallbacks {
    isInApp(app: string, clientId: string): boolean;
}

// The SocketIOServer's message counts per web client and per app room.
export class WebTrafficCounter {
    // By client id.
    private readonly traffic = new Map<string, WebTraffic>();
    // Messages emitted to each app's room, while it has clients.
    private readonly roomEmits = new Map<string, number>();
    private sampledAt = 0;

    public constructor(private readonly callbacks: WebTrafficCounterCallbacks) {}

    // Starts a client's counts. Call before it joins its app's room, whose count becomes its roomBase.
    // `now` is on performance.now()'s clock.
    public register(client: NetworkClient, now: number): WebTraffic {
        const traffic: WebTraffic = {
            meter: new TrafficMeter(now),
            direct: 0,
            excluded: 0,
            roomBase: this.roomEmits.get(client.app) ?? 0,
        };
        this.traffic.set(client.id, traffic);
        return traffic;
    }

    public forget(clientId: string): void {
        this.traffic.delete(clientId);
    }

    // The app's room has no client left.
    public forgetRoom(app: string): void {
        this.roomEmits.delete(app);
    }

    public meterOf(clientId: string): TrafficMeter | undefined {
        return this.traffic.get(clientId)?.meter;
    }

    public countDirect(clientId: string): void {
        const traffic = this.traffic.get(clientId);
        if (traffic) traffic.direct += 1;
    }

    public countRoomEmit(app: string, exceptClientId: string | undefined): void {
        this.roomEmits.set(app, (this.roomEmits.get(app) ?? 0) + 1);
        if (exceptClientId === undefined || !this.callbacks.isInApp(app, exceptClientId)) return;

        const traffic = this.traffic.get(exceptClientId);
        if (traffic) traffic.excluded += 1;
    }

    // Samples the clients' rates, at most once per RATE_WINDOW_MILLIS.
    public sample(clients: Iterable<NetworkClient>, now: number): void {
        if (now - this.sampledAt >= RATE_WINDOW_MILLIS) {
            this.sampledAt = now;
            for (const client of clients) {
                const traffic = this.traffic.get(client.id);
                traffic?.meter.sample(now, this.sentTo(client, traffic));
            }
        }
    }

    private sentTo(client: NetworkClient, traffic: WebTraffic): number {
        return traffic.direct + (this.roomEmits.get(client.app) ?? 0) - traffic.roomBase - traffic.excluded;
    }
}
