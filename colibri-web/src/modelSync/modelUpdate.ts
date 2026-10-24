import type { SyncModel } from '../SyncModel';
import { toJsonOf } from './syncModelMethods';

// A model::update with nothing but the id is the server's answer for a model it does not have.
export const isBare = (modelData: object) => Object.keys(modelData).every(key => key === 'id');

export const withoutKeys = <T>(modelData: Partial<T>, keys: Iterable<string>): Partial<T> => {
    const drop = new Set(keys);
    return Object.fromEntries(Object.entries(modelData).filter(([key]) => !drop.has(key))) as Partial<T>;
};

// `modelData` without the fields that the property names in `changes` are sent as.
export const withoutChanges = <T extends SyncModel<T>>(
    modelData: Partial<T>,
    model: T,
    changes: string[]
): Partial<T> => {
    if (changes.length === 0) return modelData;
    const changed = new Set(Object.keys(toJsonOf(model, changes)).filter(key => key !== 'id'));
    return Object.fromEntries(Object.entries(modelData).filter(([key]) => !changed.has(key))) as Partial<T>;
};

export const fieldsOnTop = <T extends SyncModel<T>>(
    model: T,
    id: string,
    held: string[],
    keys: string[]
): Record<string, unknown> => {
    // toJson() with no properties named is all of them.
    const current = toJsonOf(model) as Record<string, unknown>;
    const fields: Record<string, unknown> = held.length > 0 ? toJsonOf(model, held) : { id };
    for (const key of keys) fields[key] = current[key];
    return fields;
};
