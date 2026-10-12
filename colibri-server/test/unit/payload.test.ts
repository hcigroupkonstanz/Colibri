import { describe, it, expect, vi } from 'vitest';
import { Payload } from '../../src/server/modules/core/payload.js';

describe('Payload', () => {
    it('fromString: asString() returns the raw string without parsing', () => {
        const payload = Payload.fromString('{"x":1}');
        expect(payload.asString()).toBe('{"x":1}');
    });

    it('fromString: asValue() parses lazily and memoizes the result', () => {
        const payload = Payload.fromString('{"x":1}');
        const first = payload.asValue<{ x: number }>();
        const second = payload.asValue<{ x: number }>();
        expect(first).toEqual({ x: 1 });
        expect(first).toBe(second);
    });

    it('fromValue: asValue() returns the value without stringifying', () => {
        const value = { x: 1 };
        const payload = Payload.fromValue(value);
        expect(payload.asValue()).toBe(value);
    });

    it('fromValue: asString() stringifies lazily and memoizes the result', () => {
        const payload = Payload.fromValue({ x: 1 });
        const spy = vi.spyOn(JSON, 'stringify');
        const first = payload.asString();
        const second = payload.asString();
        expect(first).toBe('{"x":1}');
        expect(second).toBe('{"x":1}');
        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockRestore();
    });

    it('fromBytes: asBytes() returns the raw bytes without transcoding', () => {
        const bytes = Buffer.from('{"x":1}', 'utf8');
        const payload = Payload.fromBytes(bytes);
        expect(payload.asBytes()).toBe(bytes);
    });

    it('fromBytes: asString() decodes utf8 lazily and memoizes the result', () => {
        const bytes = Buffer.from('{"x":1}', 'utf8');
        const payload = Payload.fromBytes(bytes);
        expect(payload.asString()).toBe('{"x":1}');
    });

    it('fromBytes: asValue() decodes and parses lazily', () => {
        const bytes = Buffer.from('{"x":1}', 'utf8');
        const payload = Payload.fromBytes(bytes);
        expect(payload.asValue()).toEqual({ x: 1 });
    });

    it('fromString: asBytes() utf8-encodes lazily and memoizes the result', () => {
        const payload = Payload.fromString('{"x":1}');
        const first = payload.asBytes();
        const second = payload.asBytes();
        expect(first).toEqual(Buffer.from('{"x":1}', 'utf8'));
        expect(first).toBe(second);
    });

    it('fromValue: asBytes() stringifies then encodes lazily', () => {
        const payload = Payload.fromValue({ x: 1 });
        expect(payload.asBytes()).toEqual(Buffer.from('{"x":1}', 'utf8'));
    });

    // JSON.stringify(undefined) returns undefined rather than a string, which used to make
    // asString() return undefined despite its type and asBytes() throw ERR_INVALID_ARG_TYPE
    // - killing the process on the first payload-less broadcast relayed to a TCP client.
    describe('missing and empty payloads', () => {
        it('fromValue(undefined): asString() is an empty string', () => {
            const payload = Payload.fromValue(undefined);
            expect(payload.asString()).toBe('');
        });

        it('fromValue(undefined): asBytes() is an empty buffer', () => {
            const payload = Payload.fromValue(undefined);
            expect(payload.asBytes()).toEqual(Buffer.alloc(0));
        });

        it('fromValue(undefined): asValue() stays undefined', () => {
            expect(Payload.fromValue(undefined).asValue()).toBeUndefined();
        });

        it('fromValue(undefined): asString() memoizes instead of re-stringifying', () => {
            const payload = Payload.fromValue(undefined);
            const spy = vi.spyOn(JSON, 'stringify');
            payload.asString();
            payload.asString();
            expect(spy).toHaveBeenCalledTimes(1);
            spy.mockRestore();
        });

        it('fromValue(null): round-trips as JSON null', () => {
            const payload = Payload.fromValue(null);
            expect(payload.asString()).toBe('null');
            expect(payload.asBytes()).toEqual(Buffer.from('null', 'utf8'));
            expect(payload.asValue()).toBeNull();
        });

        it('fromString(""): asValue() is undefined and asBytes() is empty', () => {
            const payload = Payload.fromString('');
            expect(payload.asValue()).toBeUndefined();
            expect(payload.asBytes()).toEqual(Buffer.alloc(0));
        });

        it('fromBytes(empty): asString() is empty and asValue() is undefined', () => {
            const payload = Payload.fromBytes(Buffer.alloc(0));
            expect(payload.asString()).toBe('');
            expect(payload.asValue()).toBeUndefined();
        });
    });

    describe('payloads that are not JSON', () => {
        it('asValue() throws but asString() still returns the raw text', () => {
            const payload = Payload.fromString('not json');
            expect(() => payload.asValue()).toThrow();
            expect(payload.asString()).toBe('not json');
        });

        it('caches the parse failure instead of re-parsing on every call', () => {
            const payload = Payload.fromBytes(Buffer.from('not json', 'utf8'));
            const spy = vi.spyOn(JSON, 'parse');

            const first = (() => { try { payload.asValue(); } catch (err) { return err; } })();
            const second = (() => { try { payload.asValue(); } catch (err) { return err; } })();

            expect(spy).toHaveBeenCalledTimes(1);
            expect(first).toBe(second);
            spy.mockRestore();
        });
    });
});
