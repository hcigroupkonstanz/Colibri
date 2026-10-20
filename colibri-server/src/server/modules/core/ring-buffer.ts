// Fixed-capacity FIFO: push() is O(1) even once full (overwrites the oldest slot instead
// of shift()ing every remaining element), and at()/last() give O(1) random access to
// recent entries without materializing the whole buffer - the shape both measure-latency's
// per-client samples and WebLog's message history need. shift() drops the oldest entry early,
// for a buffer that is bounded by something besides its count (WebLog's by size, too).
export class RingBuffer<T> {
    private readonly items: (T | undefined)[] = [];
    private start = 0;
    private count = 0;

    public constructor(private readonly capacity: number) {
        if (capacity <= 0) {
            throw new Error(`RingBuffer capacity must be positive, got ${capacity}`);
        }
    }

    public get length(): number {
        return this.count;
    }

    public push(item: T): void {
        if (this.count < this.capacity) {
            this.items[(this.start + this.count) % this.capacity] = item;
            this.count += 1;
        } else {
            this.items[this.start] = item;
            this.start = (this.start + 1) % this.capacity;
        }
    }

    // Removes and returns the oldest entry.
    public shift(): T | undefined {
        if (this.count === 0) {
            return undefined;
        }
        const item = this.items[this.start];
        this.items[this.start] = undefined;
        this.start = (this.start + 1) % this.capacity;
        this.count -= 1;
        return item;
    }

    // Index 0 is the oldest surviving entry, length - 1 is the most recent.
    public at(index: number): T | undefined {
        if (index < 0 || index >= this.count) {
            return undefined;
        }
        return this.items[(this.start + index) % this.capacity];
    }

    // The n most recent entries, oldest first.
    public last(n: number): T[] {
        const result: T[] = [];
        for (let i = Math.max(0, this.length - n); i < this.length; i++) {
            const item = this.at(i);
            if (item !== undefined) {
                result.push(item);
            }
        }
        return result;
    }

    // Full contents, oldest first.
    public toArray(): T[] {
        return this.last(this.length);
    }
}
