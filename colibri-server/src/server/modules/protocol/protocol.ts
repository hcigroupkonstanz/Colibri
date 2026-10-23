// TCP framing:
//
// [u32 LE totalLength][u8 type][body]
//   totalLength counts every byte after the length field itself (type + body).
//   type 0x00  heartbeat   body: [u64 LE ping timestamp]
//   type 0x01  handshake   body: utf8 "version::app::name"
//   type 0x02  message     body: [u16 LE channelLen][channel]
//                               [u16 LE commandLen][command][payload bytes]

export enum FrameType {
    Heartbeat = 0x00,
    Handshake = 0x01,
    Message = 0x02,
}

const LENGTH_FIELD_SIZE = 4;
const TYPE_FIELD_SIZE = 1;
const HEADER_SIZE = LENGTH_FIELD_SIZE + TYPE_FIELD_SIZE;
const HEARTBEAT_BODY_SIZE = 8;

// Channel and command are length-prefixed with a u16, so anything longer is unrepresentable.
export const MAX_FIELD_LENGTH = 0xffff;

// Shared by the encoder and the default FrameReader limit, so the server never emits a frame
// its own parser would reject.
export const MAX_FRAME_LENGTH = 1024 * 1024 * 5;

// The version every client announces in its handshake: the TCP handshake body's `version` and the
// Socket.IO `version` query. There is no negotiation; a client announcing another version is
// refused with protocol::rejected.
//
// Not the release version: 2.0.0, 2.0.1 and 2.1.0 all speak '2'. Bump it only when a change makes
// existing clients misread the wire, since that refuses every deployed client.
export const PROTOCOL_VERSION = '2';

// Media type of the REST store's requests and answers. It carries the protocol version so a
// reverse proxy in front of servers of different versions can route by Accept header, as it
// routes Socket.IO by the handshake's version query.
export const REST_MEDIA_TYPE = `application/vnd.colibri.v${PROTOCOL_VERSION}+json`;

// The channel of the server's own messages, and the command of a refusal. A refusal is a plain
// message frame rather than a handshake frame, so it works over Socket.IO and can carry a reason.
// Colibri 1.x web clients deliver it like any other message.
export const COLIBRI_CHANNEL = 'colibri';
export const PROTOCOL_REJECTED_COMMAND = 'protocol::rejected';

export interface ProtocolRejection {
    reason: string;
    serverVersion: string;
    clientVersion: string;
}

export const protocolRejection = function (clientVersion: string): ProtocolRejection {
    return {
        reason: `Unsupported protocol version '${clientVersion || '(none)'}'. This server speaks v${PROTOCOL_VERSION}.`,
        serverVersion: PROTOCOL_VERSION,
        clientVersion,
    };
};

// Sent to every Socket.IO client that was not refused, right on connect. A server that predates
// the version check refuses no one and announces nothing, so a client treats the absence of this
// message as an out-of-date server. It is not inferred from existing traffic: the 100 ms `latency`
// broadcast dates from colibri-server 1.2.0, so 1.2.x and 1.3.x would pass as current.
// TCP clients need none: a pre-2.0.0 server already fails on the framing.
export const PROTOCOL_ACCEPTED_COMMAND = 'protocol::accepted';

export interface ProtocolAcceptance {
    serverVersion: string;
}

export const protocolAcceptance = function (): ProtocolAcceptance {
    return { serverVersion: PROTOCOL_VERSION };
};

export class FrameError extends Error {}

// Thrown instead of a plain FrameError when the bytes that failed to parse are the Colibri 1.x framing.
//
// 1.x starts every packet with three NUL bytes, an ASCII header and another NUL: '\0\0\0h\0' for
// the handshake, '\0\0\0<decimal body length>\0' for a message. Read as a u32 LE length, the first
// four bytes are (header byte << 24), past MAX_FRAME_LENGTH, so a well-formed frame never starts
// that way. A 1.x handshake shows up as "Invalid frame length: 1744830464" ('h' << 24).
export class V1FramingError extends FrameError {}

const V1_HANDSHAKE_HEADER = 0x68; // 'h'
const ASCII_0 = 0x30;
const ASCII_9 = 0x39;

const looksLikeV1Frame = function (buffer: Buffer, offset: number): boolean {
    if (buffer[offset] !== 0 || buffer[offset + 1] !== 0 || buffer[offset + 2] !== 0) return false;

    const header = buffer[offset + 3];
    return header === V1_HANDSHAKE_HEADER || (header !== undefined && header >= ASCII_0 && header <= ASCII_9);
};

// How many bytes a connection has to send before looksLikeTlsHandshake can tell.
export const TLS_HANDSHAKE_PREFIX_LENGTH = 2;

const TLS_HANDSHAKE_RECORD = 0x16;
const TLS_MAJOR_VERSION = 0x03;

// A TLS client starts with a handshake record (0x16) of a 3.x record layer (0x03). Read as this
// protocol's u32 LE length, those two bytes are at least 790 (0x0316), and no handshake frame is
// near that long, so a plaintext client is not mistaken for TLS. A 1.x client starts with a NUL byte.
export const looksLikeTlsHandshake = function (firstBytes: Buffer): boolean {
    return firstBytes.length >= TLS_HANDSHAKE_PREFIX_LENGTH
        && firstBytes[0] === TLS_HANDSHAKE_RECORD
        && firstBytes[1] === TLS_MAJOR_VERSION;
};

// Returns a Buffer whose backing ArrayBuffer holds exactly these bytes, copying outside Node's
// Buffer pool only if it does not already.
//
// Structured clone across the worker_threads boundary copies a typed array's whole backing
// ArrayBuffer, and a small Buffer from Buffer.from() or allocUnsafe() is a view into the shared
// 64 KiB pool slab (Buffer.poolSize on Node 24), so it would cross as 64 KiB.
export const ownBytes = function (bytes: Uint8Array): Buffer {
    if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
        return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, 0, bytes.byteLength);
    }

    const copy = Buffer.allocUnsafeSlow(bytes.byteLength);
    copy.set(bytes);
    return copy;
};

export type DecodedFrame =
    | { type: FrameType.Heartbeat; pingTimestamp: bigint }
    | { type: FrameType.Handshake; version: string; app: string; name: string }
    | { type: FrameType.Message; channel: string; command: string; payload: Buffer };

export const encodeHeartbeatFrame = function (pingTimestamp: bigint): Buffer {
    const buffer = Buffer.allocUnsafe(HEADER_SIZE + HEARTBEAT_BODY_SIZE);
    buffer.writeUInt32LE(TYPE_FIELD_SIZE + HEARTBEAT_BODY_SIZE, 0);
    buffer.writeUInt8(FrameType.Heartbeat, LENGTH_FIELD_SIZE);
    buffer.writeBigUInt64LE(pingTimestamp, HEADER_SIZE);
    return buffer;
};

export const encodeHandshakeFrame = function (version: string, app: string, name: string): Buffer {
    const body = Buffer.from(`${version}::${app}::${name}`, 'utf8');
    const buffer = Buffer.allocUnsafe(HEADER_SIZE + body.length);
    buffer.writeUInt32LE(TYPE_FIELD_SIZE + body.length, 0);
    buffer.writeUInt8(FrameType.Handshake, LENGTH_FIELD_SIZE);
    body.copy(buffer, HEADER_SIZE);
    return buffer;
};

export interface EncodableMessage {
    channel: string;
    command: string;
    payload: Buffer;
}

// The payload is copied verbatim, never through a JS string.
//
// Throws FrameError, not Buffer.writeUInt16LE's ERR_OUT_OF_RANGE, for a channel or command over
// MAX_FIELD_LENGTH or a frame over maxFrameLength, so the caller can drop that one message.
export const encodeMessageFrame = function (msg: EncodableMessage, maxFrameLength = MAX_FRAME_LENGTH): Buffer {
    const channel = Buffer.from(msg.channel, 'utf8');
    const command = Buffer.from(msg.command, 'utf8');

    if (channel.length > MAX_FIELD_LENGTH) {
        throw new FrameError(`Channel exceeds ${MAX_FIELD_LENGTH} bytes (${channel.length})`);
    }
    if (command.length > MAX_FIELD_LENGTH) {
        throw new FrameError(`Command exceeds ${MAX_FIELD_LENGTH} bytes (${command.length})`);
    }

    const bodyLength = 2 + channel.length + 2 + command.length + msg.payload.length;
    if (TYPE_FIELD_SIZE + bodyLength > maxFrameLength) {
        throw new FrameError(`Frame exceeds the maximum length of ${maxFrameLength} bytes (${TYPE_FIELD_SIZE + bodyLength})`);
    }

    const buffer = Buffer.allocUnsafe(HEADER_SIZE + bodyLength);

    let offset = 0;
    buffer.writeUInt32LE(TYPE_FIELD_SIZE + bodyLength, offset);
    offset += LENGTH_FIELD_SIZE;
    buffer.writeUInt8(FrameType.Message, offset);
    offset += TYPE_FIELD_SIZE;

    buffer.writeUInt16LE(channel.length, offset);
    offset += 2;
    channel.copy(buffer, offset);
    offset += channel.length;

    buffer.writeUInt16LE(command.length, offset);
    offset += 2;
    command.copy(buffer, offset);
    offset += command.length;

    msg.payload.copy(buffer, offset);

    return buffer;
};

// Growable read buffer with read/write cursors instead of a Buffer.concat per `data` event.
// Consumed frames are dropped by resetting both cursors to 0, without a copy. Only a frame split
// across TCP segments compacts, and that copy is bounded by one frame, not by the stream length.
export class FrameReader {
    private buffer: Buffer;
    private readPos = 0;
    private writePos = 0;

    public constructor(
        private readonly maxFrameLength: number = MAX_FRAME_LENGTH,
        initialCapacity = 4096
    ) {
        this.buffer = Buffer.allocUnsafe(initialCapacity);
    }

    public get pendingBytes(): number {
        return this.writePos - this.readPos;
    }

    public reset(): void {
        this.readPos = 0;
        this.writePos = 0;
    }

    // Appends received bytes and returns every complete frame now available.
    // Throws FrameError on a malformed or oversized frame, which is fatal for the connection;
    // V1FramingError means the peer speaks the Colibri 1.x framing.
    //
    // Not a generator: the read cursor advances as frames are decoded, so a caller that stopped
    // iterating early would leave it stale.
    public append(data: Buffer): DecodedFrame[] {
        this.ensureCapacity(data.length);
        data.copy(this.buffer, this.writePos);
        this.writePos += data.length;

        let frames: DecodedFrame[] | undefined;

        for (;;) {
            const available = this.writePos - this.readPos;
            if (available < HEADER_SIZE) break;

            const totalLength = this.buffer.readUInt32LE(this.readPos);
            if (totalLength <= 0 || totalLength > this.maxFrameLength) {
                const message = `Invalid frame length: ${totalLength}`;
                throw looksLikeV1Frame(this.buffer, this.readPos) ? new V1FramingError(message) : new FrameError(message);
            }

            const frameLength = LENGTH_FIELD_SIZE + totalLength;
            if (available < frameLength) break;

            const frameEnd = this.readPos + frameLength;

            const type = this.buffer.readUInt8(this.readPos + LENGTH_FIELD_SIZE);
            const frame = this.decodeFrame(type, this.readPos + HEADER_SIZE, frameEnd);
            this.readPos = frameEnd;

            frames ??= [];
            frames.push(frame);
        }

        this.compact();
        return frames ?? [];
    }

    private decodeFrame(type: number, bodyStart: number, bodyEnd: number): DecodedFrame {
        switch (type) {
            case FrameType.Heartbeat: {
                if (bodyEnd - bodyStart !== HEARTBEAT_BODY_SIZE) {
                    throw new FrameError(`Malformed heartbeat frame (${bodyEnd - bodyStart} body bytes)`);
                }
                return { type: FrameType.Heartbeat, pingTimestamp: this.buffer.readBigUInt64LE(bodyStart) };
            }

            case FrameType.Handshake: {
                const text = this.buffer.toString('utf8', bodyStart, bodyEnd);
                // Exactly three fields: '::' separates them and may not occur inside one. A field may
                // not start or end with ':' either, since "2::app:::name" splits into app "app" and
                // name ":name" whatever the sender meant. Ambiguous bodies are refused as malformed.
                const parts = text.split('::');
                const [version, app, name] = parts;
                if (parts.length !== 3 || version === undefined || app === undefined || name === undefined
                    || parts.some(field => field.startsWith(':') || field.endsWith(':'))) {
                    throw new FrameError(`Malformed handshake frame: "${text}"`);
                }
                return { type: FrameType.Handshake, version, app, name };
            }

            case FrameType.Message: {
                let offset = bodyStart;
                if (offset + 2 > bodyEnd) throw new FrameError('Malformed message frame: missing channel length');
                const channelLength = this.buffer.readUInt16LE(offset);
                offset += 2;
                if (offset + channelLength > bodyEnd) throw new FrameError('Malformed message frame: channel overruns body');
                const channel = this.buffer.toString('utf8', offset, offset + channelLength);
                offset += channelLength;

                if (offset + 2 > bodyEnd) throw new FrameError('Malformed message frame: missing command length');
                const commandLength = this.buffer.readUInt16LE(offset);
                offset += 2;
                if (offset + commandLength > bodyEnd) throw new FrameError('Malformed message frame: command overruns body');
                const command = this.buffer.toString('utf8', offset, offset + commandLength);
                offset += commandLength;

                // Copied, not a subarray: append() reuses and compacts the backing buffer. Allocated
                // outside the Buffer pool because the payload is posted to the main thread.
                const payload = Buffer.allocUnsafeSlow(bodyEnd - offset);
                this.buffer.copy(payload, 0, offset, bodyEnd);
                return { type: FrameType.Message, channel, command, payload };
            }

            default:
                throw new FrameError(`Unknown frame type: ${type}`);
        }
    }

    private ensureCapacity(incoming: number): void {
        if (this.writePos + incoming <= this.buffer.length) return;

        this.compact();
        if (this.writePos + incoming <= this.buffer.length) return;

        let newSize = this.buffer.length * 2;
        while (newSize < this.writePos + incoming) newSize *= 2;

        const grown = Buffer.allocUnsafe(newSize);
        this.buffer.copy(grown, 0, 0, this.writePos);
        this.buffer = grown;
    }

    private compact(): void {
        if (this.readPos === 0) return;

        if (this.readPos === this.writePos) {
            this.readPos = 0;
            this.writePos = 0;
            return;
        }

        this.buffer.copy(this.buffer, 0, this.readPos, this.writePos);
        this.writePos -= this.readPos;
        this.readPos = 0;
    }
}
