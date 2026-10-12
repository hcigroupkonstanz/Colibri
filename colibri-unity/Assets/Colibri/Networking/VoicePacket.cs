using System;
using System.Buffers.Binary;
using System.Text;

public struct VoicePacket
{
    public short Id;
    public short Sequence;
    public short FrameSize;
    public Codec Codec;
    public byte[] Data;
}

namespace HCIKonstanz.Colibri.Networking
{
    /// <summary>
    /// Encoder and decoder for voice packets (UDP), all integers little-endian:
    /// <code>
    /// [i16 id][i16 sequence][i16 frameSize][u8 version and codec][u32 appId][data]      11-byte header
    ///   version and codec   HeaderVersion in the high 4 bits, the Codec in the low 4 bits
    ///   appId               AppId(the app the TCP handshake sends for the App Name)
    /// </code>
    /// The server passes a packet on only to the voice clients with the same app id. The
    /// authority for this format is <c>colibri-server/src/server/modules/web/voice-packet.ts</c>
    /// and <c>colibri-server/docs/protocol.md</c>.
    ///
    /// Free of any <c>UnityEngine</c> dependency, so plain NUnit EditMode tests exercise it.
    /// </summary>
    public static class VoicePacketCodec
    {
        public const int HeaderSize = 11;

        /// <summary>
        /// Colibri 1.x had no version: its 7-byte header ends with the codec (0 or 1) where the
        /// version and codec are now, so its packets read as version 0.
        /// </summary>
        public const int HeaderVersion = 2;

        private const int VersionAndCodecOffset = 6;
        private const int AppIdOffset = 7;

        // 32-bit FNV-1a, as the server computes it.
        private const uint FnvOffsetBasis = 0x811C9DC5;
        private const uint FnvPrime = 0x01000193;

        // GetBytes never emits a BOM, so the shared Encoding.UTF8 instance is safe here.
        private static readonly Encoding Utf8 = Encoding.UTF8;

        /// <summary>The app id of <paramref name="appName"/>: the 32-bit FNV-1a hash of its UTF-8 bytes.</summary>
        public static uint AppId(string appName)
        {
            var hash = FnvOffsetBasis;
            foreach (var b in Utf8.GetBytes(appName ?? string.Empty))
                hash = unchecked((hash ^ b) * FnvPrime);
            return hash;
        }

        /// <summary>Encodes a voice packet into a single pre-sized allocation.</summary>
        public static byte[] Encode(uint appId, short id, short sequence, short frameSize, Codec codec, ReadOnlySpan<byte> data)
        {
            var packet = new byte[HeaderSize + data.Length];
            BinaryPrimitives.WriteInt16LittleEndian(packet.AsSpan(0), id);
            BinaryPrimitives.WriteInt16LittleEndian(packet.AsSpan(2), sequence);
            BinaryPrimitives.WriteInt16LittleEndian(packet.AsSpan(4), frameSize);
            packet[VersionAndCodecOffset] = (byte)((HeaderVersion << 4) | ((int)codec & 0x0F));
            BinaryPrimitives.WriteUInt32LittleEndian(packet.AsSpan(AppIdOffset), appId);
            data.CopyTo(packet.AsSpan(HeaderSize));
            return packet;
        }

        /// <summary>
        /// Decodes a received datagram. False for one shorter than the header or with another
        /// header version, such as a packet from a Colibri 1.x client.
        /// </summary>
        public static bool TryDecode(byte[] bytes, out uint appId, out VoicePacket packet)
        {
            appId = 0;
            packet = default;
            if (bytes == null || bytes.Length < HeaderSize || bytes[VersionAndCodecOffset] >> 4 != HeaderVersion)
                return false;

            appId = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(AppIdOffset));
            packet = new VoicePacket
            {
                Id = BinaryPrimitives.ReadInt16LittleEndian(bytes.AsSpan(0)),
                Sequence = BinaryPrimitives.ReadInt16LittleEndian(bytes.AsSpan(2)),
                FrameSize = BinaryPrimitives.ReadInt16LittleEndian(bytes.AsSpan(4)),
                Codec = (Codec)(bytes[VersionAndCodecOffset] & 0x0F),
                Data = bytes.AsSpan(HeaderSize).ToArray(),
            };
            return true;
        }
    }
}
