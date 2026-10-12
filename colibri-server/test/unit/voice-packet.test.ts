import { describe, it, expect } from 'vitest';
import {
    VOICE_APP_ID_OFFSET,
    VOICE_HEADER_LENGTH,
    VOICE_HEADER_VERSION,
    VOICE_VERSION_AND_CODEC_OFFSET,
    VoiceCodec,
    encodeVoicePacket,
    voiceAppId,
} from '../../src/server/modules/web/voice-packet.js';

describe('voice packet format', () => {
    describe('voiceAppId', () => {
        // The published 32-bit FNV-1a test values.
        it.each([
            [ '', 0x811c9dc5 ],
            [ 'a', 0xe40c292c ],
            [ 'foobar', 0xbf9cf968 ],
        ])('is 32-bit FNV-1a: %j hashes to %i', (app, expected) => {
            expect(voiceAppId(app)).toBe(expected);
        });

        it('hashes the UTF-8 bytes of the app name', () => {
            // 'ü' is c3 bc in UTF-8; as one Latin-1 byte (fc) it would hash to 0x790b80bb.
            expect(voiceAppId('ü')).toBe(0x119dd44a);
            expect(voiceAppId('Bjorn-ü中')).toBe(0xc44c843d);
        });

        it('is an unsigned 32-bit number', () => {
            for (const app of [ '', 'a', 'myApp', 'Bjorn-ü中' ]) {
                const id = voiceAppId(app);
                expect(Number.isInteger(id) && id >= 0 && id <= 0xffffffff).toBe(true);
            }
        });
    });

    describe('encodeVoicePacket', () => {
        it('lays the header out as documented', () => {
            const packet = encodeVoicePacket({
                appId: 0x11223344,
                userId: 1,
                sequence: -1,
                frameSize: 960,
                codec: VoiceCodec.OPUS,
                data: Buffer.from([ 0xaa, 0xbb ]),
            });

            // userId 01 00, sequence ff ff, frameSize c0 03, version 2 and Opus 21, appId 44 33 22 11.
            expect(packet.toString('hex')).toBe('0100ffffc0032144332211aabb');
            expect(VOICE_HEADER_LENGTH).toBe(11);
            expect(packet[VOICE_VERSION_AND_CODEC_OFFSET]! >> 4).toBe(VOICE_HEADER_VERSION);
            expect(packet.readUInt32LE(VOICE_APP_ID_OFFSET)).toBe(0x11223344);
        });

        it('writes a header on its own for no data, with PCM as codec 0', () => {
            const packet = encodeVoicePacket({
                appId: voiceAppId(''), userId: 32000, sequence: 0, frameSize: 0, codec: VoiceCodec.PCM, data: Buffer.alloc(0),
            });

            expect(packet.toString('hex')).toBe('007d00000000' + '20' + 'c59d1c81');
        });
    });
});
