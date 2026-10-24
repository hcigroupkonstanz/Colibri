// Per-client traffic for the admin UI's client view, on either transport.

// What holds back a client's model updates or drops its broadcasts: its message rate
// (CLIENT_MESSAGE_RATE_LIMIT) or, for a TCP client, the main thread falling behind
// (TCP_INBOUND_BACKLOG_LIMIT).
export type LoadLimit = 'rate' | 'backlog';

export interface ClientActivity {
    // Messages per second received and sent over the last RATE_WINDOW_MILLIS; null until one full
    // window has passed. Heartbeats and latency pings (and their echoes) are not counted.
    in: number | null;
    out: number | null;
    // The limit in effect now, if any.
    limit: LoadLimit | null;
    // Objects with model updates held back.
    held: number;
    // Oldest first (see TrafficMeter.history); only when requested.
    history?: RateSample[];
}

// [Date.now() of the sample, messages per second in, out].
export type RateSample = [number, number, number];

// Interval at which a transport samples its per-client message counts.
export const RATE_WINDOW_MILLIS = 1000;

// Rates kept per client, at least a second apart: a little over the 2 minutes of the admin UI's
// throughput chart, so a page opened later is full at once.
export const RATE_HISTORY_LENGTH = 125;

// Message counts and rates of one client. The transport counts messages with plain increments and
// calls sample() about once per RATE_WINDOW_MILLIS.
// The history is kept with or without an admin page open: it is three numbers per sample, and
// sampling only for open pages would leave the chart empty for the first page after a quiet spell.
// The TCP worker sends its history only when requested (a page's first snapshot): asking for it
// each second would cost a message each way.
export class TrafficMeter {
    public received = 0;
    public sent = 0;
    public receivedPerSecond: number | null = null;
    public sentPerSecond: number | null = null;

    private sampledReceived = 0;
    private sampledSent = 0;

    // [when, in, out] per sample, in a ring of RATE_HISTORY_LENGTH.
    private readonly rates = new Float64Array(RATE_HISTORY_LENGTH * 3);
    private samples = 0;

    public constructor(private sampledAt: number) {}

    // `sent`: for a transport that does not count sends in this.sent (see WebTrafficCounter.sentTo).
    public sample(now: number, sent = this.sent): void {
        const elapsed = now - this.sampledAt;
        if (elapsed < RATE_WINDOW_MILLIS) return;

        this.receivedPerSecond = ((this.received - this.sampledReceived) * 1000) / elapsed;
        this.sentPerSecond = ((sent - this.sampledSent) * 1000) / elapsed;
        this.sampledReceived = this.received;
        this.sampledSent = sent;
        this.sampledAt = now;

        const at = (this.samples % RATE_HISTORY_LENGTH) * 3;
        this.rates[at] = now;
        this.rates[at + 1] = this.receivedPerSecond;
        this.rates[at + 2] = this.sentPerSecond;
        this.samples += 1;
    }

    // Oldest first, each at the Date.now() of its sample. `now` is the present on sample()'s clock,
    // `wallNow` the same instant by Date.now().
    public history(now: number, wallNow = Date.now()): RateSample[] {
        const history: RateSample[] = [];
        for (let n = Math.max(0, this.samples - RATE_HISTORY_LENGTH); n < this.samples; n++) {
            const at = (n % RATE_HISTORY_LENGTH) * 3;
            history.push([ Math.round(wallNow - (now - this.rates[at]!)), this.rates[at + 1]!, this.rates[at + 2]! ]);
        }
        return history;
    }
}
