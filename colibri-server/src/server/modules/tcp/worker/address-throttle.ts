// A refused client may retry for as long as its app runs, so warnings that name an address are
// limited to one per address per interval.
export const ADDRESS_WARNING_INTERVAL_MILLIS = 60_000;

// Bounds memory. At capacity the least recently warned address is evicted, which at worst costs it
// one extra warning.
export const MAX_WARNED_ADDRESSES = 1024;

// Last warning time per remote address.
export class AddressThrottle {
    // In warning order (shouldWarn re-inserts), so the oldest entry is first.
    private readonly warnedAt = new Map<string, number>();

    public constructor(
        private readonly intervalMillis = ADDRESS_WARNING_INTERVAL_MILLIS,
        private readonly maxAddresses = MAX_WARNED_ADDRESSES
    ) {}

    public get size(): number {
        return this.warnedAt.size;
    }

    // True if a warning about `address` is due at `now` (a performance.now() reading); it is then
    // recorded as logged.
    public shouldWarn(address: string, now: number): boolean {
        const lastWarned = this.warnedAt.get(address);
        if (lastWarned !== undefined && now - lastWarned < this.intervalMillis) return false;

        this.warnedAt.delete(address);

        // Evicts expired entries, then the oldest live ones while at capacity; stops at the first
        // entry that is neither.
        for (const [warnedAddress, warnedAt] of this.warnedAt) {
            if (now - warnedAt < this.intervalMillis && this.warnedAt.size < this.maxAddresses) break;
            this.warnedAt.delete(warnedAddress);
        }

        this.warnedAt.set(address, now);
        return true;
    }
}
