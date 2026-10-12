using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Networking.Protocol;
using NUnit.Framework;
using System;
using System.Text;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// Cross-implementation vectors: byte-for-byte expectations produced by the server's own
    /// encoders (<c>colibri-server/src/server/modules/networking/protocol.ts</c> and, for voice,
    /// <c>colibri-server/src/server/modules/web/voice-packet.ts</c>) and asserted against
    /// <see cref="FrameCodec"/> and <see cref="VoicePacketCodec"/>.
    ///
    /// The round-trip tests elsewhere in this suite only prove the C# encoder and decoder
    /// agree with each other - they would pass just as happily with both sides big-endian, or
    /// both off by one. These vectors are what actually catches drift between the two
    /// implementations.
    ///
    /// These bytes are checked against the server's encoders automatically:
    /// <c>npm run test:vectors</c> in colibri-server re-encodes every vector below and fails if
    /// this file no longer expects the same bytes, or if it expects bytes nothing produces.
    /// <c>npm run test:vectors -- --emit</c> prints the current table.
    /// </summary>
    public class ProtocolVectorTests
    {
        [TestCase(0UL, "09000000000000000000000000")]
        [TestCase(1UL, "09000000000100000000000000")]
        [TestCase(123456789012345UL, "090000000079df0d8648700000")]
        [TestCase(ulong.MaxValue, "0900000000ffffffffffffffff")]
        public void HeartbeatMatchesTheServerEncoder(ulong pingTimestamp, string expected)
            => AssertBytes(expected, FrameCodec.EncodeHeartbeat(pingTimestamp));

        [Test]
        public void HandshakeMatchesTheServerEncoder()
            => AssertBytes("1300000001323a3a6d794170703a3a6d79436c69656e74",
                FrameCodec.EncodeHandshake("2", "myApp", "myClient"));

        [Test]
        public void HandshakeWithNonAsciiFieldsMatchesTheServerEncoder()
            => AssertBytes("1400000001323a3a6170703a3a426a6f726e2dc3bce4b8ad",
                FrameCodec.EncodeHandshake("2", "app", "Bjorn-ü中"));

        [Test]
        public void MessageMatchesTheServerEncoder()
            => AssertBytes("220000000209006170703a3a6368616e0d006d6f64656c3a3a7570646174657b2278223a317d",
                FrameCodec.EncodeMessage("app::chan", "model::update", Encoding.UTF8.GetBytes("{\"x\":1}")));

        [Test]
        public void MessageWithAnEmptyPayloadMatchesTheServerEncoder()
            => AssertBytes("09000000020100630300636d64",
                FrameCodec.EncodeMessage("c", "cmd", ReadOnlySpan<byte>.Empty));

        [Test]
        public void MessageWithNonAsciiFieldsMatchesTheServerEncoder()
            => AssertBytes("240000000207006bc3a46ec3a46c110062726f6164636173743a3a737472696e672268656c6c6f22",
                FrameCodec.EncodeMessage("känäl", "broadcast::string", Encoding.UTF8.GetBytes("\"hello\"")));

        [Test]
        public void MessageWithABinaryPayloadMatchesTheServerEncoder()
            => AssertBytes("0d00000002010062030072617700ff7f80",
                FrameCodec.EncodeMessage("b", "raw", new byte[] { 0x00, 0xFF, 0x7F, 0x80 }));

        // The app id in each voice packet is AppId of the app name, so these pin the hash as well
        // as the header.
        [Test]
        public void VoicePacketMatchesTheServerEncoder()
            => AssertBytes("01000000c00320463c19780001ff7f",
                VoicePacketCodec.Encode(VoicePacketCodec.AppId("myApp"), 1, 0, 960, Codec.PCM, new byte[] { 0x00, 0x01, 0xFF, 0x7F }));

        [Test]
        public void VoicePacketWithANonAsciiAppNameMatchesTheServerEncoder()
            => AssertBytes("feff0102e001213d844cc4fcfffe",
                VoicePacketCodec.Encode(VoicePacketCodec.AppId("Bjorn-ü中"), -2, 513, 480, Codec.OPUS, new byte[] { 0xFC, 0xFF, 0xFE }));

        [Test]
        public void VoicePacketWithAnEmptyAppNameAndNoDataMatchesTheServerEncoder()
            => AssertBytes("007dffff000020c59d1c81",
                VoicePacketCodec.Encode(VoicePacketCodec.AppId(""), 32000, -1, 0, Codec.PCM, ReadOnlySpan<byte>.Empty));

        /// <summary>Every vector above must also decode back to what the server would have sent.</summary>
        [Test]
        public void ServerVectorsDecodeBackToTheirOriginalFrames()
        {
            var reader = new FrameReader();

            Assert.That(reader.Append(FromHex("090000000079df0d8648700000")),
                Is.EqualTo(new[] { DecodedFrame.Heartbeat(123456789012345UL) }));

            Assert.That(reader.Append(FromHex("1300000001323a3a6d794170703a3a6d79436c69656e74")),
                Is.EqualTo(new[] { DecodedFrame.Handshake("2", "myApp", "myClient") }));

            Assert.That(reader.Append(FromHex("220000000209006170703a3a6368616e0d006d6f64656c3a3a7570646174657b2278223a317d")),
                Is.EqualTo(new[] { DecodedFrame.Message("app::chan", "model::update", Encoding.UTF8.GetBytes("{\"x\":1}")) }));

            Assert.That(VoicePacketCodec.TryDecode(FromHex("feff0102e001213d844cc4fcfffe"), out var appId, out var packet), Is.True);
            Assert.That(appId, Is.EqualTo(VoicePacketCodec.AppId("Bjorn-ü中")));
            Assert.That((packet.Id, packet.Sequence, packet.FrameSize, packet.Codec), Is.EqualTo(((short)-2, (short)513, (short)480, Codec.OPUS)));
            Assert.That(packet.Data, Is.EqualTo(new byte[] { 0xFC, 0xFF, 0xFE }));
        }


        private static void AssertBytes(string expectedHex, byte[] actual)
            => Assert.That(ToHex(actual), Is.EqualTo(expectedHex));

        private static string ToHex(byte[] bytes)
        {
            var sb = new StringBuilder(bytes.Length * 2);
            foreach (var b in bytes)
                sb.Append(b.ToString("x2"));
            return sb.ToString();
        }

        private static byte[] FromHex(string hex)
        {
            var bytes = new byte[hex.Length / 2];
            for (var i = 0; i < bytes.Length; i++)
                bytes[i] = Convert.ToByte(hex.Substring(i * 2, 2), 16);
            return bytes;
        }
    }
}
