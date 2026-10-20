// JSON.parse accepts any depth, but JSON.stringify and Socket.IO's encoder recurse and overflow the
// stack at a few thousand levels, so deeper payloads are refused. Colibri's own values nest a handful.
export const MAX_PAYLOAD_DEPTH = 100;

// Iterative, so it is safe on the values it exists to catch. Binary data is a leaf, not walked.
export const nestsDeeperThan = function (value: unknown, maxDepth: number = MAX_PAYLOAD_DEPTH): boolean {
    if (typeof value !== 'object' || value === null) return false;
    const pending: Array<{ node: object; depth: number }> = [{ node: value, depth: 1 }];
    while (pending.length > 0) {
        const { node, depth } = pending.pop()!;
        if (depth > maxDepth) return true;
        if (ArrayBuffer.isView(node) || node instanceof ArrayBuffer) continue;
        for (const child of Object.values(node)) {
            if (typeof child === 'object' && child !== null) pending.push({ node: child as object, depth: depth + 1 });
        }
    }
    return false;
};

// A NetworkMessage's payload in the form the producer had (bytes, string or parsed value); the
// others are derived on first use and cached. A same-transport relay does no JSON work, and
// TCP to TCP never decodes to a string.
export class Payload {
    private bytes: Buffer | undefined;
    private raw: string | undefined;
    private value: unknown;
    private valueResolved: boolean;
    // Caches a failed asValue() so a non-JSON payload is parsed once, not on every relay.
    private parseError: Error | undefined;

    private constructor(bytes: Buffer | undefined, raw: string | undefined, value: unknown, valueResolved: boolean) {
        this.bytes = bytes;
        this.raw = raw;
        this.value = value;
        this.valueResolved = valueResolved;
    }

    public static fromBytes(bytes: Buffer): Payload {
        return new Payload(bytes, undefined, undefined, false);
    }

    public static fromString(raw: string): Payload {
        return new Payload(undefined, raw, undefined, false);
    }

    public static fromValue(value: unknown): Payload {
        return new Payload(undefined, undefined, value, true);
    }

    public asBytes(): Buffer {
        if (this.bytes === undefined) {
            this.bytes = Buffer.from(this.asString(), 'utf8');
        }
        return this.bytes;
    }

    // JSON.stringify(undefined) is undefined, so a payload-less message (a Socket.IO event without
    // `payload`) serializes to '' instead.
    public asString(): string {
        if (this.raw === undefined) {
            this.raw = this.bytes !== undefined ? this.bytes.toString('utf8') : (JSON.stringify(this.value) ?? '');
        }
        return this.raw;
    }

    // Throws if the payload is not JSON; SocketIOServer.resolvePayload falls back to asString().
    public asValue<T = unknown>(): T {
        if (this.parseError !== undefined) throw this.parseError;

        if (!this.valueResolved) {
            const raw = this.asString();
            try {
                this.value = raw ? JSON.parse(raw) : undefined;
            } catch (err) {
                this.parseError = err instanceof Error ? err : new Error(String(err));
                throw this.parseError;
            }
            this.valueResolved = true;
        }
        return this.value as T;
    }
}
