import { errorMessage } from '../core/error-message.js';
import type { StoreDatabase } from './store-database.js';

const DAY_MILLIS = 24 * 60 * 60 * 1000;
const EXPIRY_INTERVAL_MILLIS = 60 * 60 * 1000;

// What StoreExpiry needs from the RestAPI that owns it. The store is opened in init(), so it is
// asked for at every sweep. The log methods keep the RestAPI as the lines' origin.
interface StoreExpiryCallbacks {
    store(): StoreDatabase | undefined;
    now(): number;
    logInfo(msg: string): void;
    logError(msg: string, printStacktrace: boolean): void;
}

// The RestAPI's sweep that deletes the values not written for STORE_EXPIRY_DAYS: once at startup,
// then every hour.
export class StoreExpiry {
    private expiryTimer: NodeJS.Timeout | undefined;

    // expiryDays: 0 or less never sweeps.
    public constructor(private readonly expiryDays: number, private readonly callbacks: StoreExpiryCallbacks) {}

    public start(): void {
        if (this.expiryDays > 0) {
            this.expire();
            this.expiryTimer = setInterval(() => this.expire(), EXPIRY_INTERVAL_MILLIS);
            this.expiryTimer.unref();
        }
    }

    public stop(): void {
        if (this.expiryTimer) clearInterval(this.expiryTimer);
        this.expiryTimer = undefined;
    }

    // Deletes the values not written for expiryDays. Never throws: at startup that would stop the
    // server, and in the timer it would be an uncaught exception, for a store.db another program has
    // locked for a moment or a full disk.
    private expire(): void {
        const store = this.callbacks.store();
        if (!store) return;
        try {
            const removed = store.expire(this.callbacks.now() - this.expiryDays * DAY_MILLIS);
            if (removed > 0) {
                this.callbacks.logInfo(`Data store: removed ${removed} value(s) not written for ${this.expiryDays} days (STORE_EXPIRY_DAYS)`);
            }
        } catch (err) {
            this.callbacks.logError(`Data store: could not remove the values not written for ${this.expiryDays} days: `
                + `${errorMessage(err)}. Tried again in an hour.`, false);
        }
    }
}
