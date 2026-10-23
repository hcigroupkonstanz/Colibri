export interface FormattedJson {
    json: string;
    truncated: boolean;
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

// Each write method returns true once maxLength is passed; callers then stop.
class JsonWriter {
    public readonly parts: string[] = [];
    private length = 0;
    private readonly newlines: string[] = [];

    public constructor(private readonly maxLength: number) {}

    private newline(depth: number): string {
        return (this.newlines[depth] ??= '\n' + '  '.repeat(depth));
    }

    private write(text: string): boolean {
        this.parts.push(text);
        this.length += text.length;
        return this.length > this.maxLength;
    }

    // Escape only the part that can fit: the escaped prefix of a string is a prefix of the escaped string.
    private writeString(text: string): boolean {
        const left = this.maxLength - this.length;
        return this.write(JSON.stringify(text.length > left ? text.slice(0, left + 1) : text));
    }

    public writeValue(item: unknown, depth: number): boolean {
        if (typeof item === 'string') return this.writeString(item);
        // Same output as JSON.stringify, without the call.
        if (typeof item === 'number') return this.write(Number.isFinite(item) ? String(item) : 'null');
        if (item === null || typeof item !== 'object') return this.write(JSON.stringify(item) ?? 'null');
        return Array.isArray(item) ? this.writeArray(item, depth) : this.writeObject(item, depth);
    }

    private writeArray(item: unknown[], depth: number): boolean {
        if (item.length === 0) return this.write('[]');
        if (this.write('[')) return true;
        const separator = ',' + this.newline(depth + 1);
        for (let i = 0; i < item.length;) {
            const before = i > 0 ? separator : this.newline(depth + 1);
            // A run of scalars goes through one JSON.stringify call, which is faster than element
            // by element, one per line. Their text holds no comma, so replacing commas is safe.
            let end = i;
            while (end < item.length && end - i < SCALAR_RUN && isScalar(item[end])) end++;
            if (end > i) {
                if (this.write(before + JSON.stringify(item.slice(i, end)).slice(1, -1).replace(/,/g, separator))) return true;
                i = end;
                continue;
            }
            const element = prepare(item[i], i);
            if (this.write(before) || (isSkipped(element) ? this.write('null') : this.writeValue(element, depth + 1))) return true;
            i += 1;
        }
        return this.write(this.newline(depth) + ']');
    }

    private writeObject(item: object, depth: number): boolean {
        if (this.write('{')) return true;
        let empty = true;
        for (const key of Object.keys(item)) {
            const field = prepare((item as Record<string, unknown>)[key], key);
            if (isSkipped(field)) continue;
            if (this.write((empty ? '' : ',') + this.newline(depth + 1)) || this.writeString(key) || this.write(': ') || this.writeValue(field, depth + 1)) return true;
            empty = false;
        }
        return this.write(empty ? '}' : this.newline(depth) + '}');
    }
}

/**
 * JSON.stringify(value, null, 2) cut to maxLength characters. Stops writing once past maxLength, so
 * the cost depends on maxLength, not on the value. A value that contains itself is cut instead of
 * throwing.
 */
export const formatJson = function (value: unknown, maxLength: number): FormattedJson {
    const writer = new JsonWriter(maxLength);
    const root = prepare(value, '');
    if (!isSkipped(root)) writer.writeValue(root, 0);

    const json = writer.parts.join('');
    return json.length > maxLength ? { json: json.slice(0, maxLength), truncated: true } : { json, truncated: false };
};
