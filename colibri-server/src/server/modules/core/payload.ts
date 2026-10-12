// Wraps a NetworkMessage's payload in whichever representation the producer already
// had (raw bytes off the TCP wire, wire string, or parsed value from Socket.IO) and
// memoizes the others on first request. Same-transport relaying (TCP->TCP, web->web)
// then costs zero JSON work and - for TCP->TCP - never even transcodes the payload to
// a JS string; only a genuine cross-transport hop, or a hook that inspects the
// payload, pays for decoding it.
export class Payload {
    private bytes: Buffer | undefined;
    private raw: string | undefined;
    private value: unknown;
    private valueResolved: boolean;
    // Negative cache for asValue(): a payload that isn't JSON (e.g. plain text off the
    // TCP wire) is relayed over and over, and re-running JSON.parse to re-throw the same
    // error on every broadcast is exactly the repeated work this class exists to remove.
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

    // Only decodes to utf8 if nothing has requested a byte view yet; a TCP->TCP relay
    // that never calls asString()/asValue() never pays for this at all.
    public asBytes(): Buffer {
        if (this.bytes === undefined) {
            this.bytes = Buffer.from(this.asString(), 'utf8');
        }
        return this.bytes;
    }

    // JSON.stringify(undefined) returns undefined, not a string - so a payload-less
    // message (Payload.fromValue(undefined), which is what a Socket.IO event with no
    // `payload` key produces) has to serialize to an empty body. Without the `?? ''` this
    // returned undefined despite its type, never memoized, and made asBytes() throw
    // ERR_INVALID_ARG_TYPE on the way out to a TCP client.
    public asString(): string {
        if (this.raw === undefined) {
            this.raw = this.bytes !== undefined ? this.bytes.toString('utf8') : (JSON.stringify(this.value) ?? '');
        }
        return this.raw;
    }

    // Throws for a payload that isn't valid JSON; callers that relay across transports
    // (SocketIOServer.resolvePayload) fall back to asString() instead.
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
