// v3 TCP wire protocol (breaking change from the v1 flatbuffer framing).
//
// [u32 LE totalLength][u8 type][body]
//   totalLength counts every byte after the length field itself (type + body).
//   type 0x00  heartbeat   body: [u64 LE ping timestamp]
//   type 0x01  handshake   body: utf8 "version::app::name"
//   type 0x02  message     body: [u16 LE channelLen][channel]
//                               [u16 LE commandLen][command][payload bytes]
//
// Fixed offsets mean ingress parsing is readUInt32LE/readUInt8 with no string
// scanning, and length validation is a real bounds check instead of Number.isFinite
// on a hand-parsed ASCII string.

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

// The largest frame either side will accept. Shared by the encoder and the default
// FrameReader limit so the server can never emit a frame its own parser would reject.
export const MAX_FRAME_LENGTH = 1024 * 1024 * 5;

// The wire protocol this server speaks, and the version string every client is required
// to announce in its handshake. Single source of truth for both transports: the TCP
// handshake body's `version` field and the Socket.IO `version` handshake query.
//
// This is deliberately not a negotiation. There is one supported version at a time, and a
// client announcing anything else is refused rather than downgraded - the framing changed
// incompatibly between v1 and the current protocol, and there is no subset both can speak.
// The point of the check is that the refusal is *legible*: without it a mismatched client
// reconnects forever against a server that logs nothing unusual.
//
// THIS IS NOT THE RELEASE VERSION, and must not be bumped alongside one. It identifies the wire
// format only: 2.0.0, 2.0.1 and 2.1.0 all speak '2' and interoperate freely, in any combination
// of client and server. Bump it only when a change would make an existing client misread the
// bytes on the wire - doing so refuses every deployed client at once, which is the entire cost
// and the entire point.
export const PROTOCOL_VERSION = '2';

// The channel and command a refusal is delivered on. A plain message frame rather than a
// server->client handshake frame, so the same notification works over Socket.IO, and so it
// can carry a reason. Safe against older clients: Unity's Sync command switch has no
// default case and ignores unknown commands, and the web client surfaces it as an ordinary
// message.
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

// Sent to every Socket.IO client whose version was accepted, immediately on connect.
//
// This exists so a client can tell an out-of-date *server* apart from a current one, which the
// version check alone cannot do: the check runs on the server, so a server too old to have it
// neither refuses anyone nor says what it speaks. Announcing the version unprompted turns that
// into something a client can wait for, and its absence into a usable signal.
//
// It has to be its own message rather than an inference from existing traffic. The obvious
// candidate - the 100ms `latency` broadcast - was added in colibri-server 1.2.0, so keying on it
// silently accepts every 1.2.x and 1.3.x server as current. Nothing else a web client can observe
// distinguishes them: the Socket.IO envelope, the `client::connected` payload and the relay
// behaviour are all identical.
//
// TCP clients get nothing here, and need nothing: the framing itself changed incompatibly in
// 2.0.0, so a pre-2.0.0 server is already unmistakable to them - for the same reason that a
// refusal cannot reach a client whose framing differs.
export const PROTOCOL_ACCEPTED_COMMAND = 'protocol::accepted';

export interface ProtocolAcceptance {
    serverVersion: string;
}

export const protocolAcceptance = function (): ProtocolAcceptance {
    return { serverVersion: PROTOCOL_VERSION };
};

export class FrameError extends Error {}

// Thrown instead of a plain FrameError when the bytes that failed to parse are the Colibri 1.x
// framing, so the caller can say *why* rather than log an anonymous bad length.
//
// 1.x (colibri-server <= 1.3.x, colibri-unity 1.x) started every packet with three NUL bytes, an
// ASCII header and another NUL: '\0\0\0h\0' for the handshake (then 'version::app::name\0') and
// '\0\0\0<decimal body length>\0' for a message. Read as this protocol's u32 LE length, those four
// bytes come to (header byte << 24) - at least 16 MiB, past MAX_FRAME_LENGTH - so a current frame
// can never start that way and the check cannot misfire on a well-formed stream. A 1.x client's
// first packet is its handshake, which surfaces as "Invalid frame length: 1744830464" ('h' << 24).
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

// Whether a connection's first bytes start a TLS handshake: every TLS client starts with a handshake
// record (0x16) of a TLS version 3.x record layer (0x03). Read as this protocol's u32 LE length field,
// those two bytes make it 790 (0x0316), or more by a multiple of 64 KiB: no handshake frame a client
// sends is anywhere near that long, so a client that speaks this protocol unencrypted is not mistaken
// for TLS. Nor is a Colibri 1.x client, which starts with a NUL byte.
export const looksLikeTlsHandshake = function (firstBytes: Buffer): boolean {
    return firstBytes.length >= TLS_HANDSHAKE_PREFIX_LENGTH
        && firstBytes[0] === TLS_HANDSHAKE_RECORD
        && firstBytes[1] === TLS_MAJOR_VERSION;
};

// Returns a Buffer whose backing ArrayBuffer holds exactly these bytes and nothing else: the
// input itself when it already does, otherwise a copy outside Node's Buffer pool.
//
// Every payload crosses the worker_threads boundary by structured clone, and structured clone
// copies a typed array's *whole* backing ArrayBuffer, not just the bytes the view covers. A small
// Buffer from Buffer.from(), Buffer.allocUnsafe() and friends is a view into a shared 64 KiB pool
// slab (Buffer.poolSize on Node 24), so a 30-byte model::update used to be cloned - and kept alive
// on the receiving thread - as 64 KiB. That alone capped the TCP transport at about half of what
// it otherwise handles.
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

// Single pre-sized allocation: no separate flatbuffers.Builder, no TextEncoder, no
// merged Uint8Array. Payload bytes are copied verbatim - never round-tripped through
// a JS string - so a byte-verbatim relay never pays a utf8 transcode.
//
// Throws FrameError rather than letting Buffer.writeUInt16LE throw ERR_OUT_OF_RANGE:
// ingress is fully bounds-checked, and egress needs to be too, since a frame the server
// can't represent (or that exceeds maxFrameLength) must be dropped as one bad message
// instead of propagating out of the write path.
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

// Growable read buffer with read/write cursors, replacing a Buffer.concat per `data`
// event. In the common case (no fragmentation) consumed frames are dropped by
// resetting both cursors to 0 - no copy at all. Only a frame split across TCP
// segments triggers a compaction, and that copy is bounded by the pending leftover
// (at most one frame's worth), not by total stream length - this is what avoids the
// O(n^2) cost of Buffer.concat on a long-lived fragmented connection.
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

    // Appends newly received bytes and returns every complete frame now available.
    // Throws FrameError on a malformed or oversized frame - callers should treat that
    // as fatal for the connection, same as the old maxBufferSize kill-switch. The
    // V1FramingError subclass means the peer is speaking the Colibri 1.x framing.
    //
    // Deliberately not a generator: the read cursor only advances as frames are decoded,
    // so a caller that stopped iterating early (or never started) would have left the
    // reader with a stale cursor and silently re-delivered or dropped bytes. Draining
    // eagerly makes the cursor state a function of append() alone.
    public append(data: Buffer): DecodedFrame[] {
        this.ensureCapacity(data.length);
        data.copy(this.buffer, this.writePos);
        this.writePos += data.length;

        // A partial frame is the common case on a fragmented stream, so don't allocate a
        // result array until there is something to put in it.
        let frames: DecodedFrame[] | undefined;

        for (;;) {
            const available = this.writePos - this.readPos;
            if (available < HEADER_SIZE) break;

            const totalLength = this.buffer.readUInt32LE(this.readPos);
            if (totalLength <= 0 || totalLength > this.maxFrameLength) {
                const message = `Invalid frame length: ${totalLength}`;
                throw looksLikeV1Frame(this.buffer, this.readPos) ? new V1FramingError(message) : new FrameError(message);
            }

            // totalLength counts everything after the length field itself (type + body).
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
                // Exactly three fields. '::' is the field separator and docs/protocol.md
                // forbids it inside a field, so a name containing one is a malformed
                // frame - previously it was silently truncated at the first extra '::'.
                //
                // A field may not start or end with ':' either. Next to a separator that makes
                // ':::', which split() reads as '::' + ':' - so "2::app:::name" (app "app:",
                // name "name") came out as app "app", name ":name", and the client joined a
                // different app than the one it announced, without an error anywhere. Such a
                // body is ambiguous, so it is refused exactly like a field containing '::'.
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

                // Copied out (not a subarray) since the backing buffer is reused/compacted
                // on subsequent append() calls - and into an allocation of its own, never the
                // Buffer pool, because this is what gets posted to the main thread (see ownBytes).
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
