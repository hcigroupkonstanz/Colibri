import type { ModelEntry } from '../../models/data-store.js';

export const fieldCount = function (entry: Readonly<ModelEntry>): number {
    let count = 0;
    for (const key in entry.model) {
        if (key !== 'id' && Object.hasOwn(entry.model, key)) count += 1;
    }
    return count;
};
