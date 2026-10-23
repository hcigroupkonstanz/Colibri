// Voice packet format (UDP), as colibri-unity's VoicePacketCodec writes it.
//
// |userId i16|sequence i16|frameSize i16|version and codec u8|appId u32|data|   little-endian
//  0          2            4             6                     7          11
//
//   version and codec  the header version (VOICE_HEADER_VERSION) in the high 4 bits, the codec
//                      (VoiceCodec) in the low 4 bits
//   appId              voiceAppId() of the client's app name. The relay forwards a packet only
//                      to voice clients with the same appId.
//
// The first 7 bytes match Colibri 1.x. A 1.x packet has no appId, and its codec byte (0 or 1)
// reads as version 0, which the server drops.

export enum VoiceCodec {
    PCM = 0,
    OPUS = 1,
}

export const VOICE_HEADER_VERSION = 2;
export const VOICE_HEADER_LENGTH = 11;
export const VOICE_VERSION_AND_CODEC_OFFSET = 6;
export const VOICE_APP_ID_OFFSET = 7;

// 32-bit FNV-1a. colibri-unity's VoicePacketCodec.AppId must compute the same hash, or the relay
// drops its packets.
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

// The relay forwards received bytes unchanged, so only tests call this. test/emit-protocol-vectors.ts
// uses it to write the vectors colibri-unity's encoder is checked against.
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

export type VoiceHeader = Omit<VoicePacket, 'data'>;

// What readVoiceHeader makes of a datagram: a header to relay by, a Colibri 1.x client's packet,
// or a malformed packet and the reason the server reports.
export type VoiceHeaderReading =
    | { kind: 'header'; header: VoiceHeader }
    | { kind: 'v1' }
    | { kind: 'malformed'; reason: string };

/** Reads the header of the voice packet `message`, or says why it has none the relay can use. */
export const readVoiceHeader = function (message: Buffer): VoiceHeaderReading {
    // A Colibri 1.x client's header has no appId, so there is no app to relay its
    // packets to. Its codec byte (0 or 1) is where the header version is now, which
    // makes its version 0.
    if (message.length > VOICE_VERSION_AND_CODEC_OFFSET) {
        const version = message.readUInt8(VOICE_VERSION_AND_CODEC_OFFSET) >> 4;
        if (version === 0) {
            return { kind: 'v1' };
        }
        if (version !== VOICE_HEADER_VERSION) {
            return { kind: 'malformed', reason: `its header version is ${version}, not ${VOICE_HEADER_VERSION}` };
        }
    }

    // Every header read below is at a fixed offset and throws ERR_OUT_OF_RANGE past the end of the
    // buffer, so the whole header has to be there.
    if (message.length < VOICE_HEADER_LENGTH) {
        return { kind: 'malformed', reason: `${message.length} bytes is shorter than the ${VOICE_HEADER_LENGTH}-byte header` };
    }

    // |userId(2)|sequence(2)|frameSize(2)|version and codec(1)|appId(4)|data|
    const userId = message.readInt16LE(0); // .net (Unity) decodes default in little-endian order
    const sequence = message.readInt16LE(2);
    const frameSize = message.readInt16LE(4);
    const codec: VoiceCodec = message.readUInt8(VOICE_VERSION_AND_CODEC_OFFSET) & 0x0f;
    const appId = message.readUInt32LE(VOICE_APP_ID_OFFSET);
    return { kind: 'header', header: { userId, sequence, frameSize, codec, appId } };
};
