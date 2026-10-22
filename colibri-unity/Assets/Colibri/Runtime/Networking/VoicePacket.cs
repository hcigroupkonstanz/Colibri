using System;
using System.Buffers.Binary;
using System.Text;
using HCIKonstanz.Colibri.Communication.Codecs;

namespace HCIKonstanz.Colibri.Networking
{
    public struct VoicePacket
    {
        public short Id;
        public short Sequence;
        public short FrameSize;
        public Codec Codec;
        public byte[] Data;
    }

    /// <summary>Encodes and decodes the UDP voice packets that the Colibri server relays.</summary>
    public static class VoicePacketCodec
    {
        // No UnityEngine references, so the NUnit EditMode tests can call it directly.
        // Little-endian: i16 id, i16 sequence, i16 frameSize, u8 version and codec, u32 appId, data.
        // Mirrors colibri-server's voice-packet.ts, which relays a packet only to clients with the same appId.
        public const int HeaderSize = 11;

        /// <summary>The header version this codec writes. Colibri 1.x packets read as version 0 and TryDecode rejects them.</summary>
        public const int HeaderVersion = 2;

        private const int VersionAndCodecOffset = 6;
        private const int AppIdOffset = 7;

        // Must match voiceAppId in colibri-server (32-bit FNV-1a).
        private const uint FnvOffsetBasis = 0x811C9DC5;
        private const uint FnvPrime = 0x01000193;

        // GetBytes writes no BOM, so the hash covers only the name's bytes.
        private static readonly Encoding Utf8 = Encoding.UTF8;

        /// <summary>The app id of <paramref name="appName"/>: the 32-bit FNV-1a hash of its UTF-8 bytes.</summary>
        public static uint AppId(string appName)
        {
            var hash = FnvOffsetBasis;
            foreach (var b in Utf8.GetBytes(appName ?? string.Empty))
                hash = unchecked((hash ^ b) * FnvPrime);
            return hash;
        }

        /// <summary>Encodes a voice packet into a new byte array, ready to send over UDP.</summary>
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
        /// Decodes a received datagram, or returns false if it is null, shorter than the header, or has another header version.
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
