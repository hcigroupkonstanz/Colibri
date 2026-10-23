// Size and indented JSON of models for the admin UI snapshots. Measuring costs main thread time in
// proportion to the model, so it is budgeted per second for all pages together; formatting stops at
// a fixed length.
import { ModelEntry } from '../command-hooks/data-store.js';

// Bytes measured per second for all pages together, about 20 ms of main thread. The bucket holds at
// most one second's worth.
export const MODEL_BYTES_PER_SECOND = 2 * 1024 * 1024;

// How long the old size of a changed model is shown before it is measured again, so a model that
// changes every frame is not measured on every refresh. Measuring costs about 10 ms a MiB, so large
// models wait longer.
export const MODEL_SIZE_REFRESH_MILLIS = 10_000;
export const LARGE_MODEL_BYTES = 1024 * 1024;
export const LARGE_MODEL_SIZE_REFRESH_MILLIS = 60_000;

// In characters, not bytes.
export const MAX_MODEL_JSON_LENGTH = 512 * 1024;

// Formatted JSON is kept for the models the pages have open.
export const FORMATTED_MODELS_KEPT = 8;

interface Size {
    bytes: number;
    // Model version and performance.now() at measuring.
    version: number;
    at: number;
}

export interface FormattedJson {
    json: string;
    truncated: boolean;
}

interface Formatted extends FormattedJson {
    version: number;
}

/**
 * Measures and formats models for the admin UI snapshots. The measuring budget is per instance, so
 * all pages share one. What it caches lives here, not in the store.
 */
export class ModelMeasures {
    private readonly sizes = new WeakMap<Readonly<ModelEntry>, Size>();
    // Least recently used first, at most FORMATTED_MODELS_KEPT.
    private readonly formatted = new Map<Readonly<ModelEntry>, Formatted>();
    // Token bucket for the measuring budget, in bytes.
    private tokens: number;
    private refilledAt: number;

    public constructor(private readonly bytesPerSecond = MODEL_BYTES_PER_SECOND, now = performance.now()) {
        this.tokens = bytesPerSecond;
        this.refilledAt = now;
    }

    /**
     * The model's size as compact JSON, in bytes. Measured when the budget allows, and for a changed
     * model only once its refresh interval has passed; otherwise the last measured size, or null if
     * it was never measured.
     */
    public bytes(entry: Readonly<ModelEntry>, now = performance.now()): number | null {
        const known = this.sizes.get(entry);
        if (known) {
            const refresh = known.bytes >= LARGE_MODEL_BYTES ? LARGE_MODEL_SIZE_REFRESH_MILLIS : MODEL_SIZE_REFRESH_MILLIS;
            if (known.version === entry.version || now - known.at < refresh) return known.bytes;
        }

        // Measure once the budget covers the last size, capped at a full budget. A model larger than
        // what is left leaves it negative, which later refills pay off.
        const left = this.refill(now);
        if (left <= 0 || left < Math.min(known?.bytes ?? 0, this.bytesPerSecond)) return known?.bytes ?? null;

        const bytes = Buffer.byteLength(JSON.stringify(entry.model), 'utf8');
        this.tokens -= bytes;
        this.sizes.set(entry, { bytes, version: entry.version, at: now });
        return bytes;
    }

    /** The model's value as JSON indented by two spaces, cut to MAX_MODEL_JSON_LENGTH characters. */
    public json(entry: Readonly<ModelEntry>): FormattedJson {
        let formatted = this.formatted.get(entry);
        this.formatted.delete(entry);
        if (!formatted || formatted.version !== entry.version) {
            formatted = { ...formatJson(entry.model, MAX_MODEL_JSON_LENGTH), version: entry.version };
        }
        this.formatted.set(entry, formatted);
        if (this.formatted.size > FORMATTED_MODELS_KEPT) this.formatted.delete(this.formatted.keys().next().value!);
        return { json: formatted.json, truncated: formatted.truncated };
    }

    private refill(now: number): number {
        if (now > this.refilledAt) {
            this.tokens = Math.min(this.bytesPerSecond, this.tokens + ((now - this.refilledAt) * this.bytesPerSecond) / 1000);
            this.refilledAt = now;
        }
        return this.tokens;
    }
}

// What long arrays (samples, vertices) mostly hold.
const isScalar = function (value: unknown): boolean {
    return typeof value === 'number' || typeof value === 'boolean' || value === null;
};

// Longest run of scalars for one JSON.stringify call; bounds how far a run can write past maxLength.
const SCALAR_RUN = 512;

// What JSON.stringify leaves out of an object and writes as null in an array.
const isSkipped = function (value: unknown): boolean {
    return value === undefined || typeof value === 'function' || typeof value === 'symbol';
};

// The value as JSON.stringify sees it: after toJSON, boxed primitives unwrapped.
const prepare = function (value: unknown, key: string | number): unknown {
    let prepared = value;
    if (prepared !== null && typeof prepared === 'object' && typeof (prepared as { toJSON?: unknown }).toJSON === 'function') {
        prepared = (prepared as { toJSON(key: string): unknown }).toJSON(`${key}`);
    }
    if (prepared instanceof Number || prepared instanceof String || prepared instanceof Boolean) return prepared.valueOf();
    return prepared;
};

/**
 * JSON.stringify(value, null, 2) cut to maxLength characters. Stops writing once past maxLength, so
 * the cost depends on maxLength, not on the value. A value that contains itself is cut instead of
 * throwing.
 */
export const formatJson = function (value: unknown, maxLength: number): FormattedJson {
    const parts: string[] = [];
    let length = 0;
    const newlines: string[] = [];
    const newline = (depth: number): string => (newlines[depth] ??= '\n' + '  '.repeat(depth));

    // Each writer returns true once maxLength is passed; callers then stop.
    const write = (text: string): boolean => {
        parts.push(text);
        length += text.length;
        return length > maxLength;
    };

    // Escape only the part that can fit: the escaped prefix of a string is a prefix of the escaped string.
    const writeString = (text: string): boolean => {
        const left = maxLength - length;
        return write(JSON.stringify(text.length > left ? text.slice(0, left + 1) : text));
    };

    const writeValue = (item: unknown, depth: number): boolean => {
        if (typeof item === 'string') return writeString(item);
        // Same output as JSON.stringify, without the call.
        if (typeof item === 'number') return write(Number.isFinite(item) ? String(item) : 'null');
        if (item === null || typeof item !== 'object') return write(JSON.stringify(item) ?? 'null');

        if (Array.isArray(item)) {
            if (item.length === 0) return write('[]');
            if (write('[')) return true;
            const separator = ',' + newline(depth + 1);
            for (let i = 0; i < item.length;) {
                const before = i > 0 ? separator : newline(depth + 1);
                // A run of scalars goes through one JSON.stringify call, which is faster than element
                // by element, one per line. Their text holds no comma, so replacing commas is safe.
                let end = i;
                while (end < item.length && end - i < SCALAR_RUN && isScalar(item[end])) end++;
                if (end > i) {
                    if (write(before + JSON.stringify(item.slice(i, end)).slice(1, -1).replace(/,/g, separator))) return true;
                    i = end;
                    continue;
                }
                const element = prepare(item[i], i);
                if (write(before) || (isSkipped(element) ? write('null') : writeValue(element, depth + 1))) return true;
                i += 1;
            }
            return write(newline(depth) + ']');
        }

        if (write('{')) return true;
        let empty = true;
        for (const key of Object.keys(item)) {
            const field = prepare((item as Record<string, unknown>)[key], key);
            if (isSkipped(field)) continue;
            if (write((empty ? '' : ',') + newline(depth + 1)) || writeString(key) || write(': ') || writeValue(field, depth + 1)) return true;
            empty = false;
        }
        return write(empty ? '}' : newline(depth) + '}');
    };

    const root = prepare(value, '');
    if (!isSkipped(root)) writeValue(root, 0);

    const json = parts.join('');
    return json.length > maxLength ? { json: json.slice(0, maxLength), truncated: true } : { json, truncated: false };
};
