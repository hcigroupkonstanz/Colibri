// A client that is refused may try again for as long as its app runs, so a warning that names it is
// limited to once per remote address per this interval: often enough to be found in the log, rarely
// enough not to bury everything else in it.
export const ADDRESS_WARNING_INTERVAL_MILLIS = 60_000;

// Bounds the memory behind that limit: past this many addresses the least recently warned-about
// is forgotten, which at worst means one extra warning for it.
export const MAX_WARNED_ADDRESSES = 1024;

// Remembers, per remote address, when a warning about it was last logged.
export class AddressThrottle {
    // Kept in warning order (an address is re-inserted each time), so the oldest entry is always
    // first.
    private readonly warnedAt = new Map<string, number>();

    public constructor(
        private readonly intervalMillis = ADDRESS_WARNING_INTERVAL_MILLIS,
        private readonly maxAddresses = MAX_WARNED_ADDRESSES
    ) {}

    public get size(): number {
        return this.warnedAt.size;
    }

    // Whether a warning about this address is due at `now` (a performance.now() reading); if it
    // is, it counts as logged from here on.
    public shouldWarn(address: string, now: number): boolean {
        const lastWarned = this.warnedAt.get(address);
        if (lastWarned !== undefined && now - lastWarned < this.intervalMillis) return false;

        this.warnedAt.delete(address);

        // Oldest first: drop entries whose interval has passed, plus the oldest live ones while
        // the map is full. Stops at the first entry that is neither.
        for (const [warnedAddress, warnedAt] of this.warnedAt) {
            if (now - warnedAt < this.intervalMillis && this.warnedAt.size < this.maxAddresses) break;
            this.warnedAt.delete(warnedAddress);
        }

        this.warnedAt.set(address, now);
        return true;
    }
}
