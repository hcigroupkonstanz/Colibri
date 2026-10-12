import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DataStore } from '../../src/server/modules/command-hooks/data-store.js';
import {
    FORMATTED_MODELS_KEPT,
    LARGE_MODEL_BYTES,
    LARGE_MODEL_SIZE_REFRESH_MILLIS,
    MAX_MODEL_JSON_LENGTH,
    MODEL_SIZE_REFRESH_MILLIS,
    ModelMeasures,
    formatJson,
} from '../../src/server/modules/web/model-measures.js';

describe('formatJson', () => {
    const values: [string, unknown][] = [
        ['a flat object', { id: 'a', x: 1, y: -2.5e-7, on: true, off: false, none: null }],
        ['nesting', { id: 'a', pos: { x: 1, y: [1, [2, { z: [] }], {}] }, empty: {}, list: [] }],
        ['escapes and unicode', { 'k"ey\n': 'tab\there "quoted" \\ \u0001 äö 😀', '': '' }],
        ['what JSON leaves out or writes as null', { u: undefined, f: () => 1, list: [undefined, () => 1, NaN, Infinity, -0] }],
        ['toJSON and boxed values', { when: new Date(0), n: new Number(3), s: new String('x'), b: new Boolean(false) }],
        ['integer keys first', { b: 1, 2: 'two', a: 3, 1: 'one' }],
        ['a bare array', [1, 'two', null]],
        ['runs of scalars between other values', [1, 2.5, -0, NaN, true, null, 'x', { y: [3, 4] }, [5, [6]], undefined, 7, false, () => 1, Infinity]],
        ['a long array of numbers', Array.from({ length: 2000 }, (_, i) => Math.sin(i) * 1e3)],
        ['a bare string', 'text'],
        ['a bare number', 42],
    ];

    it.each(values)('writes %s as JSON.stringify(value, null, 2) does', (_what, value) => {
        expect(formatJson(value, 1e6)).toEqual({ json: JSON.stringify(value, null, 2), truncated: false });
    });

    it('cuts at maxLength, and is then the start of the whole', () => {
        const value = { id: 'a', list: Array.from({ length: 200 }, (_, i) => ({ i, name: `item-${i}`, text: 'ä'.repeat(i) })) };
        const full = JSON.stringify(value, null, 2);
        for (const max of [0, 1, 10, 137, 1000, full.length - 1]) {
            expect(formatJson(value, max)).toEqual({ json: full.slice(0, max), truncated: true });
        }
        expect(formatJson(value, full.length)).toEqual({ json: full, truncated: false });
    });

    it('cuts a long string, or key, without escaping all of it', () => {
        const long = 'x'.repeat(100_000) + '"';
        const stringify = vi.spyOn(JSON, 'stringify');
        expect(formatJson({ id: 'a', long }, 1000)).toEqual({ json: JSON.stringify({ id: 'a', long }, null, 2).slice(0, 1000), truncated: true });
        expect(formatJson({ [long]: 1 }, 1000).json).toBe(`{\n  "${'x'.repeat(995)}`);
        for (const [arg] of stringify.mock.calls) {
            if (typeof arg === 'string') expect(arg.length).toBeLessThanOrEqual(1001);
        }
        stringify.mockRestore();
    });

    it('stops at the cut in a large array, and in a value that contains itself', () => {
        const numbers = Array.from({ length: 1_000_000 }, (_, i) => i);
        const { json, truncated } = formatJson({ id: 'mesh', numbers }, 1000);
        expect(truncated).toBe(true);
        expect(json).toBe(JSON.stringify({ id: 'mesh', numbers: numbers.slice(0, 200) }, null, 2).slice(0, 1000));

        const loop: Record<string, unknown> = { id: 'loop' };
        loop['self'] = loop;
        expect(formatJson(loop, 500)).toMatchObject({ truncated: true });
    });
});

describe('ModelMeasures', () => {
    let store: DataStore;
    // How often a model was serialized: JSON.stringify and formatJson both call toJSON.
    let serialized: number;
    const probe = { toJSON: () => { serialized += 1; return 0; } };
    const entry = (id: string) => store.getEntry('app', 'c', id)!;

    beforeEach(() => {
        vi.useFakeTimers();
        store = new DataStore();
        serialized = 0;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('measures a model\'s compact UTF-8 size once while it is unchanged', () => {
        store.updateModel('app', 'c', { id: 'a', text: 'äö', probe });
        const measures = new ModelMeasures();

        const first = measures.bytes(entry('a'));
        vi.advanceTimersByTime(60_000);
        const later = measures.bytes(entry('a'));
        expect(serialized).toBe(1);
        expect([first, later]).toEqual([Buffer.byteLength('{"id":"a","text":"äö","probe":0}'), first]);
    });

    it('measures a model that changes every frame once per MODEL_SIZE_REFRESH_MILLIS', () => {
        store.updateModel('app', 'c', { id: 'a', x: 0, probe });
        const measures = new ModelMeasures();

        for (let second = 1; second <= 60; second++) {
            for (let frame = 0; frame < 30; frame++) store.updateModel('app', 'c', { id: 'a', x: second * 30 + frame });
            vi.advanceTimersByTime(1000);
            measures.bytes(entry('a'));
        }
        // 60 s: the first measure, and one each 10 s after it
        expect(serialized).toBe(60_000 / MODEL_SIZE_REFRESH_MILLIS);
    });

    it('measures a large model that changes once per LARGE_MODEL_SIZE_REFRESH_MILLIS, each measure a longer stall', () => {
        store.updateModel('app', 'c', { id: 'a', text: 'x'.repeat(LARGE_MODEL_BYTES), probe });
        const measures = new ModelMeasures();

        for (let second = 1; second <= 120; second++) {
            store.updateModel('app', 'c', { id: 'a', x: second });
            vi.advanceTimersByTime(1000);
            measures.bytes(entry('a'));
        }
        expect(serialized).toBe(120_000 / LARGE_MODEL_SIZE_REFRESH_MILLIS);
    });

    it('measures no more a second than its budget, whatever asks', () => {
        // 1021 to 1022 bytes each
        for (let i = 0; i < 100; i++) store.updateModel('app', 'c', { id: `m${i}`, text: 'x'.repeat(990), probe });
        const measures = new ModelMeasures(10_000);

        const measured: number[] = [];
        for (let second = 0; second < 5; second++) {
            const before = serialized;
            // ten pages asking each second
            for (let page = 0; page < 10; page++) {
                for (let i = 0; i < 100; i++) measures.bytes(entry(`m${i}`));
            }
            measured.push(serialized - before);
            vi.advanceTimersByTime(1000);
        }
        // a second's budget, and one model more while any of it is left, whose debt the next
        // second pays off
        for (const count of measured) expect(count === 9 || count === 10).toBe(true);
        expect(measured.reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(Math.ceil(5 * 10_000 / 1021) + 1);
    });

    it('measures a model larger than its budget once the budget is full, and pays it off before the next', () => {
        store.updateModel('app', 'c', { id: 'big', text: 'x'.repeat(4978) });
        store.updateModel('app', 'c', { id: 'small' });
        store.updateModel('app', 'c', { id: 'mid', text: 'x'.repeat(578) });
        const measures = new ModelMeasures(1000);

        // 5000 bytes: 4000 in debt, nothing measured for 4 s
        expect(measures.bytes(entry('big'))).toBe(5000);
        vi.advanceTimersByTime(4000);
        expect(measures.bytes(entry('small'))).toBeNull();
        vi.advanceTimersByTime(100);
        expect(measures.bytes(entry('small'))).toBe('{"id":"small"}'.length);

        // Changed, it keeps its size until the budget holds as much as a second's worth again.
        vi.advanceTimersByTime(MODEL_SIZE_REFRESH_MILLIS);
        expect(measures.bytes(entry('mid'))).toBe(600);
        store.updateModel('app', 'c', { id: 'big', text: 'y' });
        expect(measures.bytes(entry('big'))).toBe(5000);
        vi.advanceTimersByTime(600);
        expect(measures.bytes(entry('big'))).toBe('{"id":"big","text":"y"}'.length);
    });

    it('formats a model once per change, and keeps FORMATTED_MODELS_KEPT of them', () => {
        for (let i = 0; i <= FORMATTED_MODELS_KEPT; i++) store.updateModel('app', 'c', { id: `m${i}`, x: 1, probe });
        const measures = new ModelMeasures();

        const formatted = measures.json(entry('m0'));
        measures.json(entry('m0'));
        expect(serialized).toBe(1);
        expect(formatted).toEqual({ json: JSON.stringify({ id: 'm0', x: 1, probe: 0 }, null, 2), truncated: false });

        store.updateModel('app', 'c', { id: 'm0', x: 2 });
        serialized = 0;
        const changed = measures.json(entry('m0'));
        expect(serialized).toBe(1);
        expect(changed.json).toContain('"x": 2');

        // one more than it keeps pushes the least recently used out
        for (let i = 1; i <= FORMATTED_MODELS_KEPT; i++) measures.json(entry(`m${i}`));
        serialized = 0;
        measures.json(entry('m0'));
        expect(serialized).toBe(1);
    });

    it('cuts a model\'s JSON at MAX_MODEL_JSON_LENGTH', () => {
        store.updateModel('app', 'c', { id: 'a', text: 'x'.repeat(4 * MAX_MODEL_JSON_LENGTH) });
        const { json, truncated } = new ModelMeasures().json(entry('a'));
        expect(json).toHaveLength(MAX_MODEL_JSON_LENGTH);
        expect(truncated).toBe(true);
    });
});
