import { bench, describe } from 'vitest';
import { DataStore } from '../src/server/modules/command-hooks/data-store.js';

// DataStore now nests app -> channel -> model id as Maps (Phase 1 item 13), replacing the
// array + Array.find/Array.filter storage the Phase 0 numbers were measured against. Sized
// to resemble a busy app with a few hundred synced objects on one channel.
const MODEL_COUNT = 500;

const seeded = function (): DataStore {
    const store = new DataStore();
    for (let i = 0; i < MODEL_COUNT; i++) {
        store.updateModel('app', 'channel', { id: `model-${i}`, x: i, y: i * 2 });
    }
    return store;
};

describe('DataStore (v2: nested Map storage)', () => {
    bench('updateModel - update existing (worst case: last element)', () => {
        const store = seeded();
        store.updateModel('app', 'channel', { id: `model-${MODEL_COUNT - 1}`, x: 1, y: 2 });
    });

    bench('getModel - lookup last element', () => {
        const store = seeded();
        store.getModel('app', 'channel', `model-${MODEL_COUNT - 1}`);
    });

    bench('removeModel - remove last element', () => {
        const store = seeded();
        store.removeModel('app', 'channel', `model-${MODEL_COUNT - 1}`);
    });

    bench('clearApp - single matching app', () => {
        const store = seeded();
        store.clearApp('app');
    });
});
