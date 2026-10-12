import { describe, it, expect } from 'vitest';
import { MessageChannel } from 'worker_threads';
import {
    FrameError,
    FrameReader,
    FrameType,
    PROTOCOL_VERSION,
    V1FramingError,
    encodeHandshakeFrame,
    encodeHeartbeatFrame,
    encodeMessageFrame,
    ownBytes,
} from '../../src/server/modules/networking/protocol.js';

const MAX_FRAME_LENGTH = 1024 * 1024;

const readAll = function (reader: FrameReader, data: Buffer) {
    return Array.from(reader.append(data));
};

const thrownBy = function (fn: () => unknown): unknown {
    try {
        fn();
    } catch (err) {
        return err;
    }
    throw new Error('expected a throw');
};

describe('protocol v3 framing', () => {
    describe('heartbeat frames', () => {
        it('round-trips a ping timestamp', () => {
            const reader = new FrameReader(MAX_FRAME_LENGTH);
            const frame = encodeHeartbeatFrame(123456789012345n);

            const [decoded] = readAll(reader, frame);
            expect(decoded).toEqual({ type: FrameType.Heartbeat, pingTimestamp: 123456789012345n });
        });
    });

    describe('handshake frames', () => {
        it('round-trips version/app/name', () => {
            const reader = new FrameReader(MAX_FRAME_LENGTH);
            const frame = encodeHandshakeFrame(PROTOCOL_VERSION, 'myApp', 'myClient');

            const [decoded] = readAll(reader, frame);
            expect(decoded).toEqual({ type: FrameType.Handshake, version: PROTOCOL_VERSION, app: 'myApp', name: 'myClient' });
        });

        it('throws FrameError on a malformed handshake body', () => {
            const reader = new FrameReader(MAX_FRAME_LENGTH);
            const body = Buffer.from('not-enough-parts', 'utf8');
            const frame = Buffer.alloc(5 + body.length);
            frame.writeUInt32LE(1 + body.length, 0);
            frame.writeUInt8(FrameType.Handshake, 4);
            body.copy(frame, 5);

            expect(() => readAll(reader, frame)).toThrow(FrameError);
        });
    });

    describe('message frames', () => {
        it('round-trips channel, command, and payload bytes', () => {
            const reader = new FrameReader(MAX_FRAME_LENGTH);
            const payload = Buffer.from(JSON.stringify({ x: 1 }), 'utf8');
            const frame = encodeMessageFrame({ channel: 'app::chan', command: 'model::update', payload });

            const [decoded] = readAll(reader, frame);
            expect(decoded).toEqual({
                type: FrameType.Message,
                channel: 'app::chan',
                command: 'model::update',
                payload,
            });
        });

        it('round-trips an empty payload', () => {
            const reader = new FrameReader(MAX_FRAME_LENGTH);
            const frame = encodeMessageFrame({ channel: 'c', command: 'cmd', payload: Buffer.alloc(0) });

            const [decoded] = readAll(reader, frame);
            expect(decoded).toEqual({ type: FrameType.Message, channel: 'c', command: 'cmd', payload: Buffer.alloc(0) });
        });
    });

    describe('fragmentation', () => {
        it('reassembles a frame split across many small chunks', () => {
            const reader = new FrameReader(MAX_FRAME_LENGTH);
            const payload = Buffer.from(JSON.stringify({ points: Array.from({ length: 50 }, (_, i) => i) }), 'utf8');
            const frame = encodeMessageFrame({ channel: 'app::chan', command: 'model::update', payload });

            const decoded: unknown[] = [];
            for (let i = 0; i < frame.length; i++) {
                decoded.push(...readAll(reader, frame.subarray(i, i + 1)));
            }

            expect(decoded).toEqual([
                { type: FrameType.Message, channel: 'app::chan', command: 'model::update', payload },
            ]);
        });

        it('reassembles a frame split into two halves across separate append() calls', () => {
            const reader = new FrameReader(MAX_FRAME_LENGTH);
            const frame = encodeHeartbeatFrame(42n);
            const mid = Math.floor(frame.length / 2);

            expect(readAll(reader, frame.subarray(0, mid))).toEqual([]);
            const decoded = readAll(reader, frame.subarray(mid));

            expect(decoded).toEqual([{ type: FrameType.Heartbeat, pingTimestamp: 42n }]);
        });
    });

    describe('coalescing', () => {
        it('yields multiple frames delivered in a single segment', () => {
            const reader = new FrameReader(MAX_FRAME_LENGTH);
            const a = encodeHeartbeatFrame(1n);
            const b = encodeHandshakeFrame(PROTOCOL_VERSION, 'app', 'name');
            const c = encodeMessageFrame({ channel: 'x', command: 'y', payload: Buffer.from('z') });

            const decoded = readAll(reader, Buffer.concat([a, b, c]));

            expect(decoded).toHaveLength(3);
            expect(decoded[0]).toEqual({ type: FrameType.Heartbeat, pingTimestamp: 1n });
            expect(decoded[1]).toEqual({ type: FrameType.Handshake, version: PROTOCOL_VERSION, app: 'app', name: 'name' });
            expect(decoded[2]).toEqual({ type: FrameType.Message, channel: 'x', command: 'y', payload: Buffer.from('z') });
        });

        it('handles one complete frame plus a trailing partial frame in the same segment', () => {
            const reader = new FrameReader(MAX_FRAME_LENGTH);
            const a = encodeHeartbeatFrame(7n);
            const b = encodeHeartbeatFrame(8n);

            const first = readAll(reader, Buffer.concat([a, b.subarray(0, 3)]));
            expect(first).toEqual([{ type: FrameType.Heartbeat, pingTimestamp: 7n }]);

            const second = readAll(reader, b.subarray(3));
            expect(second).toEqual([{ type: FrameType.Heartbeat, pingTimestamp: 8n }]);
        });
    });

    describe('malformed / oversized input', () => {
        it('throws FrameError on a zero-length frame', () => {
            const reader = new FrameReader(MAX_FRAME_LENGTH);
            const frame = Buffer.alloc(5);
            frame.writeUInt32LE(0, 0);

            expect(() => readAll(reader, frame)).toThrow(FrameError);
        });

        it('throws FrameError when the declared length exceeds maxFrameLength', () => {
            const reader = new FrameReader(16);
            const frame = Buffer.alloc(5);
            frame.writeUInt32LE(1_000_000, 0);
            frame.writeUInt8(FrameType.Heartbeat, 4);

            expect(() => readAll(reader, frame)).toThrow(FrameError);
        });

        // colibri-unity 1.x's handshake, and a 1.x message header: three NULs, an ASCII header
        // and a NUL. Read as a v3 length either is at least 16 MiB.
        it('throws V1FramingError on the Colibri 1.x handshake', () => {
            const handshake = Buffer.from('\0\0\0h\0' + '1::app::host\0', 'utf8');

            const thrown = thrownBy(() => readAll(new FrameReader(MAX_FRAME_LENGTH), handshake));
            expect(thrown).toBeInstanceOf(V1FramingError);
            expect(thrown).toBeInstanceOf(FrameError);
            expect((thrown as Error).message).toBe('Invalid frame length: 1744830464');
        });

        it('throws V1FramingError on a Colibri 1.x message header', () => {
            const message = Buffer.from('\0\0\0' + '42\0', 'utf8');

            expect(thrownBy(() => readAll(new FrameReader(MAX_FRAME_LENGTH), message))).toBeInstanceOf(V1FramingError);
        });

        it('recognises 1.x framing after valid frames in the same chunk', () => {
            const chunk = Buffer.concat([encodeHeartbeatFrame(1n), Buffer.from('\0\0\0h\0', 'utf8')]);

            expect(thrownBy(() => readAll(new FrameReader(MAX_FRAME_LENGTH), chunk))).toBeInstanceOf(V1FramingError);
        });

        it('throws a plain FrameError for an oversized length that is not 1.x framing', () => {
            const frame = Buffer.alloc(5);
            frame.writeUInt32LE(0x7f000000, 0); // three NULs, then a byte that is no 1.x header

            const thrown = thrownBy(() => readAll(new FrameReader(MAX_FRAME_LENGTH), frame));
            expect(thrown).toBeInstanceOf(FrameError);
            expect(thrown).not.toBeInstanceOf(V1FramingError);
        });

        it('throws FrameError on an unknown frame type', () => {
            const reader = new FrameReader(MAX_FRAME_LENGTH);
            const frame = Buffer.alloc(6);
            frame.writeUInt32LE(2, 0);
            frame.writeUInt8(0xff, 4);

            expect(() => readAll(reader, frame)).toThrow(FrameError);
        });

        it('throws FrameError when a message frame\'s channel length overruns the body', () => {
            const reader = new FrameReader(MAX_FRAME_LENGTH);
            const buffer = Buffer.alloc(9);
            buffer.writeUInt32LE(4, 0); // type + 2-byte channelLen field only, no body
            buffer.writeUInt8(FrameType.Message, 4);
            buffer.writeUInt16LE(9999, 5); // claims a channel far longer than what's present

            expect(() => readAll(reader, buffer)).toThrow(FrameError);
        });
    });

    describe('growth and compaction', () => {
        it('grows past the initial capacity for a single large frame', () => {
            const reader = new FrameReader(MAX_FRAME_LENGTH, 16);
            const payload = Buffer.alloc(10_000, 'a');
            const frame = encodeMessageFrame({ channel: 'c', command: 'cmd', payload });

            const decoded = readAll(reader, frame);
            expect(decoded).toEqual([{ type: FrameType.Message, channel: 'c', command: 'cmd', payload }]);
        });

        it('reclaims space after fully consuming buffered frames (pendingBytes returns to 0)', () => {
            const reader = new FrameReader(MAX_FRAME_LENGTH);
            readAll(reader, encodeHeartbeatFrame(1n));
            expect(reader.pendingBytes).toBe(0);

            readAll(reader, encodeHeartbeatFrame(2n));
            expect(reader.pendingBytes).toBe(0);
        });

        it('keeps only the trailing partial frame pending across many small appends', () => {
            const reader = new FrameReader(MAX_FRAME_LENGTH);
            const complete = encodeHeartbeatFrame(1n);
            const partial = encodeHeartbeatFrame(2n).subarray(0, 5);

            readAll(reader, Buffer.concat([complete, partial]));
            expect(reader.pendingBytes).toBe(partial.length);
        });
    });

    // Ingress was fully bounds-checked from the start; egress was not, and an
    // unrepresentable frame surfaced as a raw ERR_OUT_OF_RANGE out of Buffer.writeUInt16LE
    // in the middle of the write path.
    describe('encodeMessageFrame validation', () => {
        it('throws FrameError for a channel longer than the u16 length field', () => {
            expect(() => encodeMessageFrame({
                channel: 'c'.repeat(0x10000),
                command: 'cmd',
                payload: Buffer.alloc(0),
            })).toThrow(FrameError);
        });

        it('throws FrameError for a command longer than the u16 length field', () => {
            expect(() => encodeMessageFrame({
                channel: 'c',
                command: 'x'.repeat(0x10000),
                payload: Buffer.alloc(0),
            })).toThrow(FrameError);
        });

        it('throws FrameError rather than emitting a frame the reader would reject', () => {
            const maxFrameLength = 1024;
            expect(() => encodeMessageFrame({
                channel: 'c',
                command: 'cmd',
                payload: Buffer.alloc(maxFrameLength),
            }, maxFrameLength)).toThrow(FrameError);
        });

        it('accepts a frame exactly at the limit', () => {
            const maxFrameLength = 1024;
            // 1 type + 2 + 1 channel + 2 + 3 command = 9 bytes of overhead.
            const payload = Buffer.alloc(maxFrameLength - 9);
            const frame = encodeMessageFrame({ channel: 'c', command: 'cmd', payload }, maxFrameLength);

            const reader = new FrameReader(maxFrameLength);
            expect(readAll(reader, frame)).toEqual([
                { type: FrameType.Message, channel: 'c', command: 'cmd', payload },
            ]);
        });
    });

    describe('handshake field validation', () => {
        it('rejects a handshake with fewer than three fields', () => {
            const reader = new FrameReader(MAX_FRAME_LENGTH);
            const body = Buffer.from(`${PROTOCOL_VERSION}::appOnly`, 'utf8');
            const frame = Buffer.alloc(5 + body.length);
            frame.writeUInt32LE(1 + body.length, 0);
            frame.writeUInt8(FrameType.Handshake, 4);
            body.copy(frame, 5);

            expect(() => readAll(reader, frame)).toThrow(FrameError);
        });

        // '::' is the field separator and docs/protocol.md forbids it inside a field; the
        // parser used to silently keep the first three parts and drop the rest of the name.
        it('rejects a handshake whose name contains the field separator', () => {
            const reader = new FrameReader(MAX_FRAME_LENGTH);
            const frame = encodeHandshakeFrame(PROTOCOL_VERSION, 'app', 'na::me');

            expect(() => readAll(reader, frame)).toThrow(FrameError);
        });

        // A ':' at either end of a field merges with the separator next to it into ':::', which
        // split('::') reads as '::' + ':'. "2::app:::name" used to decode as app 'app', name
        // ':name' - the client silently joined another app than the one it announced.
        it.each([
            ['an app ending in a colon', PROTOCOL_VERSION, 'app:', 'name'],
            ['a name starting with a colon', PROTOCOL_VERSION, 'app', ':name'],
            ['an app starting with a colon', PROTOCOL_VERSION, ':app', 'name'],
            ['a name ending in a colon', PROTOCOL_VERSION, 'app', 'name:'],
            ['a version ending in a colon', `${PROTOCOL_VERSION}:`, 'app', 'name'],
            ['an app that is a single colon', PROTOCOL_VERSION, ':', 'name'],
        ])('rejects a handshake with %s', (_case, version, app, name) => {
            const reader = new FrameReader(MAX_FRAME_LENGTH);
            const frame = encodeHandshakeFrame(version, app, name);

            expect(() => readAll(reader, frame)).toThrow(FrameError);
        });

        it('rejects the body "2::app:::name" rather than reading it as app "app", name ":name"', () => {
            const body = Buffer.from(`${PROTOCOL_VERSION}::app:::name`, 'utf8');
            const frame = Buffer.alloc(5 + body.length);
            frame.writeUInt32LE(1 + body.length, 0);
            frame.writeUInt8(FrameType.Handshake, 4);
            body.copy(frame, 5);

            expect(() => readAll(new FrameReader(MAX_FRAME_LENGTH), frame)).toThrow(FrameError);
        });

        it('still accepts a single colon inside a field', () => {
            const reader = new FrameReader(MAX_FRAME_LENGTH);
            const frame = encodeHandshakeFrame(PROTOCOL_VERSION, 'room:1', 'quest:3');

            expect(readAll(reader, frame)).toEqual([
                { type: FrameType.Handshake, version: PROTOCOL_VERSION, app: 'room:1', name: 'quest:3' },
            ]);
        });
    });

    // Every decoded payload is posted to the main thread, and structured clone copies a view's
    // whole backing ArrayBuffer. A payload sharing a 64 KiB Buffer-pool slab crossed the thread
    // boundary as 64 KiB, however small it was.
    describe('payload ownership', () => {
        const decodePayloads = function (...payloads: string[]): Buffer[] {
            const reader = new FrameReader(MAX_FRAME_LENGTH);
            const chunk = Buffer.concat(payloads.map(p => encodeMessageFrame({ channel: 'c', command: 'model::update', payload: Buffer.from(p) })));
            return reader.append(chunk).map(frame => {
                if (frame.type !== FrameType.Message) throw new Error('expected a message frame');
                return frame.payload;
            });
        };

        // A real MessagePort, so this is the clone a worker's postMessage actually makes.
        const roundTrip = async function (payload: Buffer): Promise<Uint8Array> {
            const { port1, port2 } = new MessageChannel();
            try {
                const received = new Promise<Uint8Array>(resolve => port2.once('message', (msg: { payload: Uint8Array }) => resolve(msg.payload)));
                port1.postMessage({ payload });
                return await received;
            } finally {
                port1.close();
                port2.close();
            }
        };

        it('gives every decoded payload a backing buffer of exactly its own length', () => {
            const payloads = decodePayloads('{"id":"a","x":1}', '{"id":"b"}', '');

            expect(payloads.map(p => p.toString())).toEqual(['{"id":"a","x":1}', '{"id":"b"}', '']);
            for (const payload of payloads) {
                expect(payload.byteOffset).toBe(0);
                expect(payload.buffer.byteLength).toBe(payload.length);
            }
        });

        it('clones only a small payload\'s own bytes across a MessagePort', async () => {
            const [payload] = decodePayloads('{"id":"a","x":1}');

            const received = await roundTrip(payload!);

            expect(Buffer.from(received).toString()).toBe('{"id":"a","x":1}');
            expect(received.buffer.byteLength).toBe(payload!.length);
        });

        describe('ownBytes', () => {
            it('copies a view into the Buffer pool out into a buffer of its own', () => {
                const pooled = Buffer.from('12345678', 'utf8');
                expect(pooled.buffer.byteLength).toBeGreaterThan(pooled.length);

                const owned = ownBytes(pooled);

                expect(owned.toString()).toBe('12345678');
                expect(owned.byteOffset).toBe(0);
                expect(owned.buffer.byteLength).toBe(8);
            });

            it('passes a buffer that already owns its bytes through without copying', () => {
                const exact = Buffer.allocUnsafeSlow(4).fill(7);

                expect(ownBytes(exact)).toBe(exact);
            });

            it('wraps a plain Uint8Array that owns its bytes as a Buffer over the same memory', () => {
                const bytes = new Uint8Array([1, 2, 3]);

                const owned = ownBytes(bytes);

                expect(Buffer.isBuffer(owned)).toBe(true);
                expect(owned.buffer).toBe(bytes.buffer);
                expect([...owned]).toEqual([1, 2, 3]);
            });

            it('keeps an empty payload empty', () => {
                expect(ownBytes(Buffer.alloc(0)).length).toBe(0);
                expect(ownBytes(Buffer.from('')).buffer.byteLength).toBe(0);
            });
        });
    });
});
