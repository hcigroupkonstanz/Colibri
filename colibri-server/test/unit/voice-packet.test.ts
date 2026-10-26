import { describe, it, expect } from 'vitest';
import {
    VOICE_APP_ID_OFFSET,
    VOICE_HEADER_LENGTH,
    VOICE_HEADER_VERSION,
    VOICE_VERSION_AND_CODEC_OFFSET,
    VoiceCodec,
    encodeVoicePacket,
    readVoiceHeader,
    voiceAppId,
} from '../../src/server/modules/voice/voice-packet.js';

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

    describe('readVoiceHeader', () => {
        // |userId(2)|sequence(2)|frameSize(2)|codec(1)|data|: the header colibri-unity 1.x sends.
        const v1Packet = function (codec: VoiceCodec, data: number[]): Buffer {
            const header = Buffer.alloc(7);
            header.writeInt16LE(1, 0);
            header.writeInt16LE(0, 2);
            header.writeInt16LE(960, 4);
            header.writeUInt8(codec, 6);
            return Buffer.concat([ header, Buffer.from(data) ]);
        };

        it('reads each field of the documented layout', () => {
            // userId 01 00, sequence ff ff, frameSize c0 03, version 2 and Opus 21, appId 44 33 22 11.
            const reading = readVoiceHeader(Buffer.from('0100ffffc0032144332211aabb', 'hex'));

            expect(reading).toEqual({
                kind: 'header',
                header: { userId: 1, sequence: -1, frameSize: 960, codec: VoiceCodec.OPUS, appId: 0x11223344 },
            });
        });

        it('reads back what encodeVoicePacket writes, a header without data included', () => {
            // An appId above 0x7fffffff (0xc44c843d), read back unsigned.
            const header = { appId: voiceAppId('Bjorn-ü中'), userId: -2, sequence: 513, frameSize: 480, codec: VoiceCodec.PCM };

            for (const data of [ Buffer.from([ 1, 0, 0xff, 0x7f ]), Buffer.alloc(0) ]) {
                expect(readVoiceHeader(encodeVoicePacket({ ...header, data }))).toEqual({ kind: 'header', header });
            }
        });

        it('tells a Colibri 1.x client\'s packet by its header version 0', () => {
            for (const packet of [
                v1Packet(VoiceCodec.PCM, [ 1, 2, 3, 4, 5, 6, 7, 8 ]),
                v1Packet(VoiceCodec.PCM, []),
                v1Packet(VoiceCodec.OPUS, [ 0xf8 ]),
            ]) {
                expect(readVoiceHeader(packet)).toEqual({ kind: 'v1' });
            }
        });

        it('rejects a header version it does not know, before the length', () => {
            const version3 = encodeVoicePacket({ appId: 1, userId: 1, sequence: 1, frameSize: 0, codec: VoiceCodec.PCM, data: Buffer.alloc(0) });
            version3.writeUInt8(0x30, VOICE_VERSION_AND_CODEC_OFFSET);

            expect(readVoiceHeader(version3)).toEqual({ kind: 'malformed', reason: 'its header version is 3, not 2' });
            expect(readVoiceHeader(version3.subarray(0, 7))).toEqual({ kind: 'malformed', reason: 'its header version is 3, not 2' });
            expect(readVoiceHeader(Buffer.from('000000000000f1', 'hex'))).toEqual({ kind: 'malformed', reason: 'its header version is 15, not 2' });
        });

        it('rejects every length up to the 11-byte header, checking the version only from 7 bytes on', () => {
            const packet = encodeVoicePacket({ appId: 1, userId: 1, sequence: 1, frameSize: 0, codec: VoiceCodec.PCM, data: Buffer.alloc(0) });

            for (let length = 0; length < VOICE_HEADER_LENGTH; length++) {
                expect(readVoiceHeader(packet.subarray(0, length))).toEqual({
                    kind: 'malformed', reason: `${length} bytes is shorter than the 11-byte header`,
                });
            }
            // 6 bytes of a 1.x header end before its codec byte, so they are only too short.
            expect(readVoiceHeader(v1Packet(VoiceCodec.PCM, []).subarray(0, 6))).toEqual({
                kind: 'malformed', reason: '6 bytes is shorter than the 11-byte header',
            });
        });
    });
});
