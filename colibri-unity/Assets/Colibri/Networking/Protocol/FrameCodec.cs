using System;
using System.Buffers.Binary;
using System.Text;

namespace HCIKonstanz.Colibri.Networking.Protocol
{
    /// <summary>
    /// Encoder for the v3 TCP wire protocol:
    /// <code>
    /// [u32 LE totalLength][u8 type][body]      totalLength = 1 (type) + body.length
    ///   0x00 heartbeat   [u64 LE pingTimestamp]
    ///   0x01 handshake   utf8 "version::app::name"
    ///   0x02 message     [u16 LE channelLen][channel][u16 LE commandLen][command][payload bytes]
    /// </code>
    /// The authority for this format is
    /// <c>colibri-server/src/server/modules/networking/protocol.ts</c> and
    /// <c>colibri-server/docs/protocol.md</c>; every constant below comes from there.
    ///
    /// Deliberately free of any <c>UnityEngine</c> dependency so it can be exercised by plain
    /// NUnit EditMode tests.
    /// </summary>
    public static class FrameCodec
    {
        public const int LengthFieldSize = 4;
        public const int TypeFieldSize = 1;
        public const int HeaderSize = LengthFieldSize + TypeFieldSize;
        public const int HeartbeatBodySize = 8;

        /// <summary>Channel and command are length-prefixed with a u16, so anything longer is unrepresentable.</summary>
        public const int MaxFieldLength = 0xFFFF;

        /// <summary>
        /// The largest frame either side will accept. Shared by the encoder and the default
        /// <see cref="FrameReader"/> limit so this client can never emit a frame its own parser
        /// - or the server's - would reject.
        /// </summary>
        public const int MaxFrameLength = 1024 * 1024 * 5;

        /// <summary>The <c>::</c> field separator of the handshake body, forbidden inside a field.</summary>
        public const string FieldSeparator = "::";

        // GetBytes never emits a BOM, so the shared Encoding.UTF8 instance is safe here.
        private static readonly Encoding Utf8 = Encoding.UTF8;

        /// <summary>
        /// Encodes a heartbeat frame. Used exclusively to echo a server heartbeat back verbatim -
        /// the timestamp is the server's own <c>process.hrtime.bigint()</c> and is never interpreted.
        /// </summary>
        public static byte[] EncodeHeartbeat(ulong pingTimestamp)
        {
            var frame = new byte[HeaderSize + HeartbeatBodySize];
            BinaryPrimitives.WriteUInt32LittleEndian(frame.AsSpan(0), (uint)(TypeFieldSize + HeartbeatBodySize));
            frame[LengthFieldSize] = (byte)FrameType.Heartbeat;
            BinaryPrimitives.WriteUInt64LittleEndian(frame.AsSpan(HeaderSize), pingTimestamp);
            return frame;
        }

        /// <summary>
        /// Encodes the handshake frame a client must send immediately after connecting.
        /// </summary>
        /// <exception cref="FrameException">
        /// If any field contains the <c>::</c> separator (the server's reader rejects such a body
        /// outright and drops the connection), if any field starts or ends with <c>:</c> (which
        /// would merge with a separator and move the colon into the neighbouring field), or if the
        /// frame exceeds <see cref="MaxFrameLength"/>.
        /// </exception>
        public static byte[] EncodeHandshake(string version, string app, string name)
        {
            RejectSeparator(nameof(version), version);
            RejectSeparator(nameof(app), app);
            RejectSeparator(nameof(name), name);

            var body = Utf8.GetBytes($"{version}{FieldSeparator}{app}{FieldSeparator}{name}");
            if (TypeFieldSize + body.Length > MaxFrameLength)
                throw new FrameException($"Frame exceeds the maximum length of {MaxFrameLength} bytes ({TypeFieldSize + body.Length})");

            var frame = new byte[HeaderSize + body.Length];
            BinaryPrimitives.WriteUInt32LittleEndian(frame.AsSpan(0), (uint)(TypeFieldSize + body.Length));
            frame[LengthFieldSize] = (byte)FrameType.Handshake;
            body.CopyTo(frame, HeaderSize);
            return frame;
        }

        /// <summary>
        /// Encodes an application message into a single pre-sized allocation. Payload bytes are
        /// copied verbatim and never round-tripped through a string.
        /// </summary>
        /// <exception cref="FrameException">
        /// If channel or command exceeds <see cref="MaxFieldLength"/> utf8 bytes, or the whole
        /// frame exceeds <paramref name="maxFrameLength"/>. Thrown rather than letting the span
        /// writes fail mid-frame: a message this client cannot represent must be dropped as one
        /// bad message instead of propagating out of the write path.
        /// </exception>
        public static byte[] EncodeMessage(string channel, string command, ReadOnlySpan<byte> payload,
            int maxFrameLength = MaxFrameLength)
        {
            var channelLength = Utf8.GetByteCount(channel ?? string.Empty);
            var commandLength = Utf8.GetByteCount(command ?? string.Empty);

            if (channelLength > MaxFieldLength)
                throw new FrameException($"Channel exceeds {MaxFieldLength} bytes ({channelLength})");
            if (commandLength > MaxFieldLength)
                throw new FrameException($"Command exceeds {MaxFieldLength} bytes ({commandLength})");

            var bodyLength = 2 + channelLength + 2 + commandLength + payload.Length;
            if (TypeFieldSize + bodyLength > maxFrameLength)
                throw new FrameException($"Frame exceeds the maximum length of {maxFrameLength} bytes ({TypeFieldSize + bodyLength})");

            var frame = new byte[HeaderSize + bodyLength];

            var offset = 0;
            BinaryPrimitives.WriteUInt32LittleEndian(frame.AsSpan(offset), (uint)(TypeFieldSize + bodyLength));
            offset += LengthFieldSize;
            frame[offset] = (byte)FrameType.Message;
            offset += TypeFieldSize;

            BinaryPrimitives.WriteUInt16LittleEndian(frame.AsSpan(offset), (ushort)channelLength);
            offset += 2;
            if (channelLength > 0)
                Utf8.GetBytes(channel, 0, channel.Length, frame, offset);
            offset += channelLength;

            BinaryPrimitives.WriteUInt16LittleEndian(frame.AsSpan(offset), (ushort)commandLength);
            offset += 2;
            if (commandLength > 0)
                Utf8.GetBytes(command, 0, command.Length, frame, offset);
            offset += commandLength;

            payload.CopyTo(frame.AsSpan(offset));

            return frame;
        }

        private static void RejectSeparator(string field, string value)
        {
            if (string.IsNullOrEmpty(value))
                return;

            if (value.Contains(FieldSeparator))
                throw new FrameException($"Handshake {field} may not contain '{FieldSeparator}': \"{value}\"");

            // A lone ':' at either end is just as bad, only quieter. Next to a separator it makes
            // ':::', which both readers split as '::' + ':' - so app "app:" with name "name" is
            // read as app "app", name ":name", and the client joins a different app without any
            // error at all.
            if (value[0] == ':' || value[value.Length - 1] == ':')
                throw new FrameException($"Handshake {field} may not start or end with ':': \"{value}\"");
        }
    }
}
