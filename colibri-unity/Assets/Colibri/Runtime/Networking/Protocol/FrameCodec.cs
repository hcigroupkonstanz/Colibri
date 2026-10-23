using System;
using System.Buffers.Binary;
using System.Text;

namespace HCIKonstanz.Colibri.Networking.Protocol
{
    /// <summary>
    /// Encoder for the v3 TCP wire protocol, specified in <c>colibri-server/docs/dev/protocol.md</c>
    /// and <c>colibri-server/src/server/modules/networking/protocol.ts</c>:
    /// <code>
    /// [u32 LE totalLength][u8 type][body]      totalLength = 1 (type) + body.length
    ///   0x00 heartbeat   [u64 LE pingTimestamp]
    ///   0x01 handshake   utf8 "version::app::name"
    ///   0x02 message     [u16 LE channelLen][channel][u16 LE commandLen][command][payload bytes]
    /// </code>
    /// Has no <c>UnityEngine</c> dependency, so plain NUnit EditMode tests can use it.
    /// </summary>
    public static class FrameCodec
    {
        public const int LengthFieldSize = 4;
        public const int TypeFieldSize = 1;
        public const int HeaderSize = LengthFieldSize + TypeFieldSize;
        public const int HeartbeatBodySize = 8;

        /// <summary>Longest channel or command in utf8 bytes (u16 length prefix).</summary>
        public const int MaxFieldLength = 0xFFFF;

        /// <summary>
        /// Default largest frame of the encoder and of <see cref="FrameReader"/>. Equals the server's
        /// <c>MAX_FRAME_LENGTH</c>, so the server accepts every frame this client sends.
        /// </summary>
        public const int MaxFrameLength = 1024 * 1024 * 5;

        /// <summary>Field separator of the handshake body.</summary>
        public const string FieldSeparator = "::";

        // GetBytes never emits a BOM.
        private static readonly Encoding _utf8 = Encoding.UTF8;

        /// <summary>Encodes a heartbeat that echoes the server's timestamp back unchanged.</summary>
        public static byte[] EncodeHeartbeat(ulong pingTimestamp)
        {
            var frame = new byte[HeaderSize + HeartbeatBodySize];
            BinaryPrimitives.WriteUInt32LittleEndian(frame.AsSpan(0), (uint)(TypeFieldSize + HeartbeatBodySize));
            frame[LengthFieldSize] = (byte)FrameType.Heartbeat;
            BinaryPrimitives.WriteUInt64LittleEndian(frame.AsSpan(HeaderSize), pingTimestamp);
            return frame;
        }

        /// <summary>Encodes the handshake frame, the first frame a client sends after connecting.</summary>
        /// <exception cref="FrameException">
        /// If a field contains <c>::</c> or starts or ends with <c>:</c>, or the frame exceeds
        /// <see cref="MaxFrameLength"/>.
        /// </exception>
        public static byte[] EncodeHandshake(string version, string app, string name)
        {
            RejectSeparator(nameof(version), version);
            RejectSeparator(nameof(app), app);
            RejectSeparator(nameof(name), name);

            var body = _utf8.GetBytes($"{version}{FieldSeparator}{app}{FieldSeparator}{name}");
            if (TypeFieldSize + body.Length > MaxFrameLength)
                throw new FrameException($"Frame exceeds the maximum length of {MaxFrameLength} bytes ({TypeFieldSize + body.Length})");

            var frame = new byte[HeaderSize + body.Length];
            BinaryPrimitives.WriteUInt32LittleEndian(frame.AsSpan(0), (uint)(TypeFieldSize + body.Length));
            frame[LengthFieldSize] = (byte)FrameType.Handshake;
            body.CopyTo(frame, HeaderSize);
            return frame;
        }

        /// <summary>Encodes an application message. The payload is copied verbatim.</summary>
        /// <exception cref="FrameException">
        /// If channel or command exceeds <see cref="MaxFieldLength"/> utf8 bytes, or the frame
        /// exceeds <paramref name="maxFrameLength"/>. Checked before writing, so the caller can
        /// drop just this message.
        /// </exception>
        public static byte[] EncodeMessage(string channel, string command, ReadOnlySpan<byte> payload,
            int maxFrameLength = MaxFrameLength)
        {
            var channelLength = _utf8.GetByteCount(channel ?? string.Empty);
            var commandLength = _utf8.GetByteCount(command ?? string.Empty);

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
                _utf8.GetBytes(channel, 0, channel.Length, frame, offset);
            offset += channelLength;

            BinaryPrimitives.WriteUInt16LittleEndian(frame.AsSpan(offset), (ushort)commandLength);
            offset += 2;
            if (commandLength > 0)
                _utf8.GetBytes(command, 0, command.Length, frame, offset);
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

            // protocol.md: no ':' at either end. Next to a separator it makes ':::', which readers split
            // as '::' + ':', silently moving the colon into the neighbouring field.
            if (value[0] == ':' || value[value.Length - 1] == ':')
                throw new FrameException($"Handshake {field} may not start or end with ':': \"{value}\"");
        }
    }
}
