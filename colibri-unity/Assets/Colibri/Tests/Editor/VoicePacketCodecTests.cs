using System;
using System.Text;
using HCIKonstanz.Colibri.Networking;
using NUnit.Framework;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// The voice packet header and the app id, ported from the server's
    /// <c>test/unit/voice-packet.test.ts</c>. <see cref="ProtocolVectorTests"/> pins the same
    /// format to the server's encoder.
    /// </summary>
    public class VoicePacketCodecTests
    {
        // The published 32-bit FNV-1a test values.
        [TestCase("", 0x811C9DC5u)]
        [TestCase("a", 0xE40C292Cu)]
        [TestCase("foobar", 0xBF9CF968u)]
        public void TheAppIdIsFnv1a(string appName, uint expected)
            => Assert.That(VoicePacketCodec.AppId(appName), Is.EqualTo(expected));

        [Test]
        public void TheAppIdHashesTheUtf8BytesOfTheAppName()
        {
            // 'ü' is c3 bc in UTF-8; as one Latin-1 byte (fc) it would hash to 0x790b80bb.
            Assert.That(VoicePacketCodec.AppId("ü"), Is.EqualTo(0x119DD44Au));
            Assert.That(VoicePacketCodec.AppId("Bjorn-ü中"), Is.EqualTo(0xC44C843Du));
        }

        [Test]
        public void ANullAppNameHashesLikeAnEmptyOne()
            => Assert.That(VoicePacketCodec.AppId(null), Is.EqualTo(VoicePacketCodec.AppId("")));

        [Test]
        public void TheHeaderIsLaidOutAsDocumented()
        {
            var packet = VoicePacketCodec.Encode(0x11223344, 1, -1, 960, Codec.OPUS, new byte[] { 0xAA, 0xBB });

            // id 01 00, sequence ff ff, frameSize c0 03, version 2 and Opus 21, appId 44 33 22 11.
            Assert.That(ToHex(packet), Is.EqualTo("0100ffffc0032144332211aabb"));
            Assert.That(VoicePacketCodec.HeaderSize, Is.EqualTo(11));
            Assert.That(VoicePacketCodec.HeaderVersion, Is.EqualTo(2));
        }

        [TestCase(Codec.PCM)]
        [TestCase(Codec.OPUS)]
        public void APacketDecodesBackToWhatWasEncoded(Codec codec)
        {
            var data = new byte[] { 0x00, 0xFF, 0x7F, 0x80 };
            var encoded = VoicePacketCodec.Encode(0xC44C843D, -2, 513, 480, codec, data);

            Assert.That(VoicePacketCodec.TryDecode(encoded, out var appId, out var packet), Is.True);
            Assert.That(appId, Is.EqualTo(0xC44C843Du));
            Assert.That((packet.Id, packet.Sequence, packet.FrameSize, packet.Codec), Is.EqualTo(((short)-2, (short)513, (short)480, codec)));
            Assert.That(packet.Data, Is.EqualTo(data));
        }

        [Test]
        public void AHeaderOnItsOwnDecodesWithNoData()
        {
            var encoded = VoicePacketCodec.Encode(VoicePacketCodec.AppId(""), 32000, 0, 0, Codec.PCM, ReadOnlySpan<byte>.Empty);

            Assert.That(ToHex(encoded), Is.EqualTo("007d0000000020c59d1c81"));
            Assert.That(VoicePacketCodec.TryDecode(encoded, out _, out var packet), Is.True);
            Assert.That(packet.Data, Is.Empty);
        }

        [Test]
        public void EveryDatagramShorterThanTheHeaderIsRejected()
        {
            var encoded = VoicePacketCodec.Encode(1, 1, 0, 960, Codec.PCM, ReadOnlySpan<byte>.Empty);

            for (var length = 0; length < VoicePacketCodec.HeaderSize; length++)
                Assert.That(VoicePacketCodec.TryDecode(encoded.AsSpan(0, length).ToArray(), out _, out _), Is.False, $"{length} bytes");
            Assert.That(VoicePacketCodec.TryDecode(null, out _, out _), Is.False);
        }

        /// <summary>
        /// The 7-byte header of Colibri 1.x, |id|sequence|frameSize|codec|data|, has no app. Its
        /// codec (0 or 1) is where the version is now, so it reads as version 0.
        /// </summary>
        [TestCase(Codec.PCM)]
        [TestCase(Codec.OPUS)]
        public void APacketFromColibri1IsRejected(Codec codec)
        {
            var v1 = new byte[] { 0x01, 0x00, 0x00, 0x00, 0xC0, 0x03, (byte)codec, 1, 2, 3, 4, 5, 6, 7, 8 };

            Assert.That(VoicePacketCodec.TryDecode(v1, out _, out _), Is.False);
        }

        [Test]
        public void APacketWithAnotherHeaderVersionIsRejected()
        {
            var encoded = VoicePacketCodec.Encode(1, 1, 0, 960, Codec.PCM, new byte[] { 0, 0 });
            encoded[6] = 0x30;

            Assert.That(VoicePacketCodec.TryDecode(encoded, out _, out _), Is.False);
        }

        private static string ToHex(byte[] bytes)
        {
            var sb = new StringBuilder(bytes.Length * 2);
            foreach (var b in bytes)
                sb.Append(b.ToString("x2"));
            return sb.ToString();
        }
    }
}
