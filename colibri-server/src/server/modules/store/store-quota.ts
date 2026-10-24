import type { StoreDatabase } from './store-database.js';

// A full store refuses every PUT that would grow it; the warning that says so is logged at most
// this often.
const FULL_WARNING_INTERVAL_MILLIS = 60_000;

// What StoreQuota needs from the RestAPI that owns it: the store, which is opened in init() and so
// is asked for at every check, its clock, and its warning log method, so that the line keeps the
// RestAPI's name as its origin.
interface StoreQuotaCallbacks {
    store(): StoreDatabase;
    now(): number;
    logWarning(msg: string): void;
}

// The RestAPI's limit on the bytes of JSON the store holds (STORE_MAX_MB), and the throttled warning
// when a PUT is refused for it. One for the RestAPI's lifetime.
export class StoreQuota {
    private fullWarnedAt = -Infinity;

    // maxBytes: 0 or less never refuses.
    public constructor(public readonly maxBytes: number, private readonly callbacks: StoreQuotaCallbacks) {}

    // Whether storing `json` would take the store above maxBytes. A replaced value counts only by
    // how much it grows, so that a full store still takes a value that does not grow.
    public wouldExceedMaxBytes(app: string, name: string, json: string): boolean {
        if (this.maxBytes <= 0) return false;
        const store = this.callbacks.store();
        const previous = store.sizeOf(app, name) ?? 0;
        const growth = Buffer.byteLength(json, 'utf8') - previous;
        return growth > 0 && store.counts().bytes + growth > this.maxBytes;
    }

    public warnFull(error: string): void {
        const now = this.callbacks.now();
        if (now - this.fullWarnedAt < FULL_WARNING_INTERVAL_MILLIS) return;
        this.fullWarnedAt = now;
        this.callbacks.logWarning(`PUT answered 507: ${error}. Delete values or raise STORE_MAX_MB. `
            + 'This is logged at most once a minute.');
    }
}
