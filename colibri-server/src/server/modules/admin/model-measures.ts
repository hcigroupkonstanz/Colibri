import type { ModelEntry } from '../models/data-store.js';
import { formatJson } from './format-json.js';
import type { FormattedJson } from './format-json.js';

// About 20 ms of main thread a second. The bucket holds at most one second's worth.
export const MODEL_BYTES_PER_SECOND = 2 * 1024 * 1024;

// A changed model keeps its old size this long before it is measured again, so one that changes
// every frame is not measured on every refresh. Large models (about 10 ms a MiB) wait longer.
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

interface Formatted extends FormattedJson {
    version: number;
}

/**
 * Measures and formats models for the admin UI snapshots. Measuring costs main thread time in
 * proportion to the model, so the budget is per instance and all pages share one. What it caches
 * lives here, not in the store.
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
