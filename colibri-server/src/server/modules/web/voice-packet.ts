// Voice packet format (UDP), as colibri-unity's VoicePacketCodec writes it.
//
// |userId i16|sequence i16|frameSize i16|version and codec u8|appId u32|data|   little-endian
//  0          2            4             6                     7          11
//
//   version and codec  the header version (VOICE_HEADER_VERSION) in the high 4 bits, the codec
//                      (VoiceCodec) in the low 4 bits
//   appId              voiceAppId() of the client's app name; the relay passes a packet on only
//                      to the voice clients with the same appId
//
// The fields up to the codec byte are where Colibri 1.x has them. A 1.x client's header ends
// there (7 bytes, no appId), and its codec byte is 0 or 1, so its header version reads as 0.

export enum VoiceCodec {
    PCM = 0,
    OPUS = 1,
}

export const VOICE_HEADER_VERSION = 2;
export const VOICE_HEADER_LENGTH = 11;
export const VOICE_VERSION_AND_CODEC_OFFSET = 6;
export const VOICE_APP_ID_OFFSET = 7;

// 32-bit FNV-1a: small, and the same in C# and TypeScript, with published test values.
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** The appId of `app`: the 32-bit FNV-1a hash of its UTF-8 bytes, as an unsigned number. */
export const voiceAppId = function (app: string): number {
    let hash = FNV_OFFSET_BASIS;
    for (const byte of Buffer.from(app, 'utf8')) {
        hash = Math.imul(hash ^ byte, FNV_PRIME) >>> 0;
    }
    return hash;
};

export interface VoicePacket {
    appId: number;
    userId: number;
    sequence: number;
    frameSize: number;
    codec: VoiceCodec;
    data: Uint8Array;
}

// The server only relays packets as they came, so this is for tests and tools, and for the
// protocol vectors colibri-unity's encoder is checked against.
export const encodeVoicePacket = function (packet: VoicePacket): Buffer {
    const buffer = Buffer.allocUnsafe(VOICE_HEADER_LENGTH + packet.data.length);
    buffer.writeInt16LE(packet.userId, 0);
    buffer.writeInt16LE(packet.sequence, 2);
    buffer.writeInt16LE(packet.frameSize, 4);
    buffer.writeUInt8((VOICE_HEADER_VERSION << 4) | packet.codec, VOICE_VERSION_AND_CODEC_OFFSET);
    buffer.writeUInt32LE(packet.appId, VOICE_APP_ID_OFFSET);
    buffer.set(packet.data, VOICE_HEADER_LENGTH);
    return buffer;
};
