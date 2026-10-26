import { MAX_NAME_LENGTH } from './name-length.js';

// Cut to one character past MAX_NAME_LENGTH, so the query a snapshot echoes stays small. Rows never
// show a name that long in full, so a page cannot have taken one from a row, and a longer name cut
// to this matches nothing.
export const queryName = function (fields: Record<string, unknown>, name: string): string {
    return stringField(fields, name).slice(0, MAX_NAME_LENGTH + 1);
};

export const fieldsOf = function (body: unknown): Record<string, unknown> {
    return (body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
};

export const stringField = function (fields: Record<string, unknown>, name: string): string {
    const value = fields[name];
    return typeof value === 'string' ? value : '';
};

export const integerField = function (fields: Record<string, unknown>, name: string, fallback: number, min: number, max: number): number {
    const value = fields[name];
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(value)));
};
