import { bench, describe } from 'vitest';
import { formatJson, MAX_MODEL_JSON_LENGTH } from '../src/server/modules/admin/model-measures.js';

// The admin UI snapshots call formatJson with MAX_MODEL_JSON_LENGTH for every open model. The inputs
// are built once; each bench only formats. The cases cover the writer's paths: plain fields, deep
// recursion, runs of scalars, many small objects, and a string that ends the output early.

// A small synced model, like a transform with a few extra fields.
const FLAT_FIELD_COUNT = 10;
const flatModel: Record<string, unknown> = {};
for (let i = 0; i < FLAT_FIELD_COUNT; i++) flatModel[`field${i}`] = i % 2 === 0 ? i * 1.5 : `value-${i}`;

const NESTED_DEPTH = 20;
let nestedModel: Record<string, unknown> = { leaf: true };
for (let i = 0; i < NESTED_DEPTH; i++) nestedModel = { level: i, child: nestedModel };

// Longer than MAX_MODEL_JSON_LENGTH once indented, so the scalar runs end at the cut.
const NUMBER_COUNT = 100_000;
const numbersModel = Array.from({ length: NUMBER_COUNT }, (_, i) => i);

const OBJECT_COUNT = 2_000;
const objectsModel = Array.from({ length: OBJECT_COUNT }, (_, i) => ({ id: `obj-${i}`, x: i, y: i * 2, active: i % 3 === 0 }));

// The first string already passes the limit, the other fields are never written.
const LONG_STRING_LENGTH = 1_000_000;
const longStringsModel = {
    title: 'lorem ipsum "dolor" sit amet\n'.repeat(Math.ceil(LONG_STRING_LENGTH / 29)),
    notes: 'consectetur adipiscing elit\n'.repeat(Math.ceil(LONG_STRING_LENGTH / 28)),
    id: 'model-1',
    tail: [1, 2, 3],
};

describe('formatJson (maxLength = MAX_MODEL_JSON_LENGTH)', () => {
    bench('small flat model (10 fields)', () => {
        formatJson(flatModel, MAX_MODEL_JSON_LENGTH);
    });

    bench('deeply nested object (depth 20)', () => {
        formatJson(nestedModel, MAX_MODEL_JSON_LENGTH);
    });

    bench('array of 100,000 numbers (scalar runs)', () => {
        formatJson(numbersModel, MAX_MODEL_JSON_LENGTH);
    });

    bench('array of 2,000 small objects', () => {
        formatJson(objectsModel, MAX_MODEL_JSON_LENGTH);
    });

    bench('long strings (passes maxLength early)', () => {
        formatJson(longStringsModel, MAX_MODEL_JSON_LENGTH);
    });
});
