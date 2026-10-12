import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../../src/server/modules/core/ring-buffer.js';

describe('RingBuffer', () => {
    it('keeps insertion order while below capacity', () => {
        const buffer = new RingBuffer<number>(5);
        buffer.push(1);
        buffer.push(2);
        buffer.push(3);

        expect(buffer.length).toBe(3);
        expect(buffer.toArray()).toEqual([1, 2, 3]);
    });

    it('overwrites the oldest entry once capacity is exceeded', () => {
        const buffer = new RingBuffer<number>(3);
        buffer.push(1);
        buffer.push(2);
        buffer.push(3);
        buffer.push(4);
        buffer.push(5);

        expect(buffer.length).toBe(3);
        expect(buffer.toArray()).toEqual([3, 4, 5]);
    });

    it('at() gives O(1) random access, oldest at index 0', () => {
        const buffer = new RingBuffer<number>(3);
        [1, 2, 3, 4].forEach(n => buffer.push(n));

        expect(buffer.at(0)).toBe(2);
        expect(buffer.at(2)).toBe(4);
        expect(buffer.at(-1)).toBeUndefined();
        expect(buffer.at(3)).toBeUndefined();
    });

    it('last(n) returns the n most recent entries, oldest first', () => {
        const buffer = new RingBuffer<number>(10);
        [1, 2, 3, 4, 5].forEach(n => buffer.push(n));

        expect(buffer.last(2)).toEqual([4, 5]);
        expect(buffer.last(100)).toEqual([1, 2, 3, 4, 5]);
    });

    it('rejects a non-positive capacity', () => {
        expect(() => new RingBuffer<number>(0)).toThrow();
    });
});
