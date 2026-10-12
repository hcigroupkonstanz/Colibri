using System;
using System.Collections.Generic;
using System.Linq;
using HCIKonstanz.Colibri.Networking.Protocol;
using NUnit.Framework;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// How VoiceReceiver gets the PCM to play out of a received packet. Where Opus does not run, it
    /// logged two errors per Opus packet (macOS and iOS), or threw on every one (the macOS Editor
    /// with Android as the build target), and with its Use Opus Codec off it played Opus packets
    /// as PCM, which is noise.
    /// </summary>
    public class VoiceDecoderTests
    {
        private static readonly byte[] OpusData = { 0xF8, 0xFF, 0xFE };
        private static readonly byte[] DecodedPcm = { 1, 0, 2, 0, 3, 0 };

        private readonly List<string> _reported = new List<string>();
        private int _created;

        [SetUp]
        public void Clear()
        {
            _reported.Clear();
            _created = 0;
        }

        private VoiceDecoder Decoder(VoiceFrameDecoderFactory factory) => new VoiceDecoder(factory, reason => _reported.Add(reason));

        private VoiceFrameDecoderFactory Factory(VoiceFrameDecoder decoder) => (out VoiceFrameDecoder created, out string error) =>
        {
            _created++;
            created = decoder;
            error = null;
            return true;
        };

        private VoiceFrameDecoderFactory FailingFactory(string reason) => (out VoiceFrameDecoder created, out string error) =>
        {
            _created++;
            created = null;
            error = reason;
            return false;
        };

        private static VoicePacket Opus(short sequence) => new VoicePacket { Id = 1, Sequence = sequence, FrameSize = 960, Codec = Codec.OPUS, Data = OpusData };

        private static VoicePacket Pcm(short sequence) => new VoicePacket { Id = 1, Sequence = sequence, FrameSize = 3, Codec = Codec.PCM, Data = new byte[] { (byte)sequence, 0, 0, 0, 0, 0 } };

        /// <summary>One second from one sender at 50 packets a second, Opus and PCM in turn.</summary>
        private static IEnumerable<VoicePacket> OpusAndPcm()
        {
            for (short sequence = 0; sequence < 50; sequence++)
                yield return sequence % 2 == 0 ? Opus(sequence) : Pcm(sequence);
        }

        private static void AssertDropsOpusAndPlaysPcm(VoiceDecoder decoder, VoicePacket packet)
        {
            byte[] pcm = null;
            Assert.DoesNotThrow(() => pcm = decoder.Decode(packet));
            if (packet.Codec == Codec.OPUS)
                Assert.That(pcm, Is.Null, $"Opus packet {packet.Sequence} was not dropped");
            else
                Assert.That(pcm, Is.SameAs(packet.Data), $"PCM packet {packet.Sequence} does not play");
        }

        [Test]
        public void PcmPlaysAsItIsAndNeedsNoOpus()
        {
            var decoder = Decoder(FailingFactory("no Opus here"));

            foreach (var sequence in Enumerable.Range(0, 50).Select(i => (short)i))
            {
                var packet = Pcm(sequence);
                Assert.That(decoder.Decode(packet), Is.SameAs(packet.Data));
            }

            Assert.That(_created, Is.Zero, "A decoder was created for PCM only");
            Assert.That(_reported, Is.Empty);
        }

        /// <summary>
        /// The codec is per packet. With a decoder, an Opus packet is decoded, also on a receiver
        /// with Use Opus Codec off: VoiceDecoder has no such switch, and VoiceReceiver no longer
        /// reads it.
        /// </summary>
        [Test]
        public void AnOpusPacketIsDecodedAndNeverPlayedAsPcm()
        {
            var decoded = new List<(byte[] Opus, int FrameSamples)>();
            var decoder = Decoder(Factory((byte[] opus, int frameSamples, out string error) =>
            {
                decoded.Add((opus, frameSamples));
                error = null;
                return DecodedPcm;
            }));

            Assert.That(decoder.Decode(Opus(0)), Is.SameAs(DecodedPcm));
            Assert.That(decoder.Decode(Opus(1)), Is.SameAs(DecodedPcm));

            Assert.That(decoded, Is.EqualTo(new[] { (OpusData, 960), (OpusData, 960) }));
            Assert.That(_created, Is.EqualTo(1), "The decoder was not created exactly once");
            Assert.That(_reported, Is.Empty);
        }

        [Test]
        public void WithoutADecoderOpusIsDroppedWithOneReportAndPcmStillPlays()
        {
            var decoder = Decoder(FailingFactory("Colibri has no Opus library for this platform"));

            foreach (var packet in OpusAndPcm())
                AssertDropsOpusAndPlaysPcm(decoder, packet);

            Assert.That(_created, Is.EqualTo(1), "Creating the decoder was not tried exactly once");
            Assert.That(_reported, Is.EqualTo(new[] { "Colibri has no Opus library for this platform" }));
        }

        /// <summary>As in the macOS Editor with Android as the build target, where the library does not load.</summary>
        [Test]
        public void AFactoryThatThrowsIsADecoderThatCouldNotBeCreated()
        {
            var decoder = Decoder((out VoiceFrameDecoder created, out string error) =>
            {
                _created++;
                throw new DllNotFoundException("Unable to load DLL 'libopus'");
            });

            foreach (var packet in OpusAndPcm())
                AssertDropsOpusAndPlaysPcm(decoder, packet);

            Assert.That(_created, Is.EqualTo(1));
            Assert.That(_reported, Is.EqualTo(new[] { "DllNotFoundException: Unable to load DLL 'libopus'" }));
        }

        /// <summary>
        /// A packet the decoder fails on is dropped, and the next one is decoded again: one bad
        /// packet does not turn Opus off. Only the first failure is reported.
        /// </summary>
        [Test]
        public void APacketTheDecoderFailsOnIsDroppedWithOneReport()
        {
            var decoder = Decoder(Factory((byte[] opus, int frameSamples, out string error) =>
            {
                error = null;
                return DecodedPcm;
            }));
            var failing = Decoder(Factory((byte[] opus, int frameSamples, out string error) =>
            {
                error = "INVALID_PACKET";
                return null;
            }));
            var throwing = Decoder(Factory((byte[] opus, int frameSamples, out string error) =>
                throw new EntryPointNotFoundException("opus_decode")));

            foreach (var packet in OpusAndPcm())
            {
                Assert.That(decoder.Decode(packet), Is.SameAs(packet.Codec == Codec.OPUS ? DecodedPcm : packet.Data));
                AssertDropsOpusAndPlaysPcm(failing, packet);
                AssertDropsOpusAndPlaysPcm(throwing, packet);
            }

            Assert.That(_reported, Is.EqualTo(new[]
            {
                "Opus failed on a packet: INVALID_PACKET",
                "Opus failed on a packet: EntryPointNotFoundException: opus_decode",
            }));
        }

        [Test]
        public void APacketOfAnUnknownCodecIsDropped()
        {
            var decoder = Decoder(Factory((byte[] opus, int frameSamples, out string error) =>
            {
                error = null;
                return DecodedPcm;
            }));

            var packet = new VoicePacket { Id = 1, FrameSize = 3, Codec = (Codec)2, Data = new byte[6] };

            Assert.That(decoder.Decode(packet), Is.Null);
            Assert.That(_created, Is.Zero);
            Assert.That(_reported, Is.Empty);
        }
    }
}
