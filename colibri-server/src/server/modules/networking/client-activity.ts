// What the admin UI's client view shows of a client's traffic, on either transport.

// Which load limit holds a client's updates back: its own message rate (CLIENT_MESSAGE_RATE_LIMIT),
// or, for a TCP client, the main thread falling behind (TCP_INBOUND_BACKLOG_LIMIT).
export type LoadLimit = 'rate' | 'backlog';

export interface ClientActivity {
    // Messages a second it sent and was sent, over the last RATE_WINDOW_MILLIS. null until a full
    // window has passed since it connected. The heartbeats, the latency pings and their echoes are
    // not messages here.
    in: number | null;
    out: number | null;
    // The limit holding its model updates back, or dropping its broadcasts, now; null if none is.
    limit: LoadLimit | null;
    // How many objects it has model updates held back for.
    held: number;
    // Its last rates, oldest first (see TrafficMeter.history); only when asked for.
    history?: RateSample[];
}

// One of a client's rates: [Date.now() of its sample, messages a second in, out].
export type RateSample = [number, number, number];

// How often a transport turns its per-client message counts into rates.
export const RATE_WINDOW_MILLIS = 1000;

// How many of its rates a client keeps, at least a second apart: a little over the 2 minutes the
// admin UI's throughput chart shows, which a page opened later shows at once.
export const RATE_HISTORY_LENGTH = 125;

// A client's message counts, and its rates over the last window. The transport counts each message
// with a plain increment and calls sample() about once a window, so the cost per message is that
// increment, whether or not anyone looks at the rates.
//
// Each sample also keeps its rates, the last RATE_HISTORY_LENGTH of them, so that the admin UI's
// throughput chart is full when a page opens. They are kept whether or not a page is open: the
// transports sample every client each second anyway, and keeping a sample is three numbers in a
// ring. Sampling only while a page is open would leave the chart empty again for the first page
// after a quiet spell, and asking the TCP worker for its rates each second would cost a message
// both ways. The worker sends them only when asked, for a page's first snapshot.
export class TrafficMeter {
    public received = 0;
    public sent = 0;
    public receivedPerSecond: number | null = null;
    public sentPerSecond: number | null = null;

    private sampledReceived = 0;
    private sampledSent = 0;

    // When, in, out: three numbers per sample, in a ring of RATE_HISTORY_LENGTH.
    private readonly rates = new Float64Array(RATE_HISTORY_LENGTH * 3);
    private samples = 0;

    public constructor(private sampledAt: number) {}

    // `sent`: for a transport that counts what it sends some other way (see SocketIOServer).
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

    // The rates it keeps, oldest first, each at the Date.now() of its sample. `now` is the present
    // on the clock sample() is given, `wallNow` the same instant by Date.now().
    public history(now: number, wallNow = Date.now()): RateSample[] {
        const history: RateSample[] = [];
        for (let n = Math.max(0, this.samples - RATE_HISTORY_LENGTH); n < this.samples; n++) {
            const at = (n % RATE_HISTORY_LENGTH) * 3;
            history.push([ Math.round(wallNow - (now - this.rates[at]!)), this.rates[at + 1]!, this.rates[at + 2]! ]);
        }
        return history;
    }
}
