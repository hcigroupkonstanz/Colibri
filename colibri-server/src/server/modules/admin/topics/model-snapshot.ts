import type { DataStore } from '../../models/data-store.js';
import { ModelMeasures } from '../model-measures.js';
import { fieldCount } from './field-count.js';
import { clip } from './name-length.js';
import { fieldsOf, queryName } from './query-fields.js';
import { wallClock } from './wall-clock.js';

export interface ModelQuery {
    app: string;
    channel: string;
    id: string;
}

export const parseModelQuery = function (body: unknown): ModelQuery {
    const fields = fieldsOf(body);
    return { app: queryName(fields, 'app'), channel: queryName(fields, 'channel'), id: queryName(fields, 'id') };
};

export interface ModelSnapshot {
    at: number;
    app: string;
    channel: string;
    id: string;
    // Whether the store holds the model. If not, deletedAt says when it was deleted, if that was
    // within the tombstone time.
    found: boolean;
    deletedAt?: number;
    fields?: number;
    // As in ModelRow.
    bytes?: number | null;
    updatedAt?: number;
    // The value as JSON indented by two spaces, cut to MAX_MODEL_JSON_LENGTH characters.
    json?: string;
    truncated?: boolean;
}

export const modelSnapshot = function (store: DataStore, query: ModelQuery, measures = new ModelMeasures()): ModelSnapshot {
    const now = Date.now();
    const head = { at: now, app: clip(query.app), channel: clip(query.channel), id: clip(query.id) };
    const entry = store.getEntry(query.app, query.channel, query.id);
    if (!entry) {
        const tombstone = store.liveDeletion(query.app, query.channel, query.id);
        return tombstone
            ? { ...head, found: false, deletedAt: wallClock(tombstone.deletedAt, now, performance.now()) }
            : { ...head, found: false };
    }

    const { json, truncated } = measures.json(entry);
    return {
        ...head,
        found: true,
        fields: fieldCount(entry),
        bytes: measures.bytes(entry),
        updatedAt: entry.updatedAt,
        json,
        truncated,
    };
};
