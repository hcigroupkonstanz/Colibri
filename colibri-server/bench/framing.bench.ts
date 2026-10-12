import { bench, describe } from 'vitest';
import { encodeMessageFrame } from '../src/server/modules/networking/protocol.js';

// v3 fixed-header framing: a single pre-sized Buffer write, no flatbuffers.Builder, no
// TextEncoder, no merged Uint8Array (the v1 flatbuffer encoder is what the Phase 0 numbers
// for this bench were measured against).
const SMALL_PAYLOAD = Buffer.from(JSON.stringify({ x: 1, y: 2, z: 3 }), 'utf8');
const LARGE_PAYLOAD = Buffer.from(
    JSON.stringify({ points: Array.from({ length: 100 }, (_, i) => ({ x: i, y: i })) }),
    'utf8'
);

describe('TCP v3 packet encoding (fixed-header binary framing)', () => {
    bench('encode small payload (~30 bytes)', () => {
        encodeMessageFrame({ channel: 'app::channel', command: 'model::update', payload: SMALL_PAYLOAD });
    });

    bench('encode large payload (~2KB)', () => {
        encodeMessageFrame({ channel: 'app::channel', command: 'model::update', payload: LARGE_PAYLOAD });
    });
});
