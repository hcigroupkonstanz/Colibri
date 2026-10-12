using System;
using System.Collections.Generic;
using System.Linq;
using HCIKonstanz.Colibri.Networking.Protocol;
using NUnit.Framework;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// How VoiceBroadcast cuts what the microphone recorded into voice packets. It used to cut
    /// 20 ms frames at the microphone's rate and resample each: at 44.1 kHz that made 958-sample
    /// frames, which Opus refuses, and a frame Opus refused stayed in the buffer to be tried again
    /// in the same loop, which hung the app.
    /// </summary>
    public class VoiceFramerTests
    {
        private struct SentFrame
        {
            public short FrameSamples;
            public Codec Codec;
            public byte[] Data;
        }

        private readonly List<SentFrame> _sent = new List<SentFrame>();
        private readonly List<string> _reported = new List<string>();

        [SetUp]
        public void Clear()
        {
            _sent.Clear();
            _reported.Clear();
        }

        private VoiceFramer Framer(int recordingRate, VoiceFrameEncoder encoder = null)
            => new VoiceFramer(recordingRate, 48000, 960, encoder,
                (frameSamples, codec, data) => _sent.Add(new SentFrame { FrameSamples = frameSamples, Codec = codec, Data = data.ToArray() }),
                reason => _reported.Add(reason));

        private static float Tone(double rate, long index) => (float)(0.5 * Math.Sin(2 * Math.PI * 440 * index / rate));

        /// <summary>Adds <paramref name="count"/> samples of the tone, cut into chunks of the given lengths in turn.</summary>
        private static float[] AddTone(VoiceFramer framer, int rate, int count, params int[] chunkLengths)
        {
            var all = new float[count];
            for (var i = 0; i < count; i++)
                all[i] = Tone(rate, i);

            var chunk = 0;
            for (var done = 0; done < count; chunk++)
            {
                var length = Math.Min(chunkLengths[chunk % chunkLengths.Length], count - done);
                var samples = new float[length];
                Array.Copy(all, done, samples, 0, length);
                framer.Add(samples);
                done += length;
            }
            return all;
        }

        private static float[] Pcm16ToFloats(byte[] pcm)
        {
            var samples = new float[pcm.Length / 2];
            for (var i = 0; i < samples.Length; i++)
                samples[i] = (short)(pcm[2 * i] | (pcm[2 * i + 1] << 8)) / 32767f;
            return samples;
        }

        private static byte[] Pcm16(float[] samples, int offset, int count)
        {
            var pcm = new byte[count * 2];
            for (var i = 0; i < count; i++)
            {
                var value = (short)(samples[offset + i] * 32767f);
                pcm[2 * i] = (byte)value;
                pcm[2 * i + 1] = (byte)(value >> 8);
            }
            return pcm;
        }

        [Test]
        public void A44100HzMicrophoneSendsOnly960SampleFramesAndLosesNoAudio()
        {
            var framer = Framer(44100);

            // Ten seconds, cut as unevenly as frames of an app record it.
            const int recorded = 441000;
            AddTone(framer, 44100, recorded, 735, 613, 1, 2048, 0, 1470);

            Assert.That(_sent.Select(frame => frame.FrameSamples).Distinct(), Is.EqualTo(new short[] { 960 }));
            Assert.That(_sent.Select(frame => frame.Codec).Distinct(), Is.EqualTo(new[] { Codec.PCM }));
            Assert.That(_sent.Select(frame => frame.Data.Length).Distinct(), Is.EqualTo(new[] { 1920 }));

            // Every recorded sample is in a frame or waits for one, at 48000 / 44100 samples each.
            // The resampler holds back the last recorded sample until the next one arrives.
            var resampled = _sent.Count * 960 + framer.PendingSamples;
            Assert.That(resampled, Is.EqualTo(recorded * 48000.0 / 44100).Within(48000.0 / 44100 + 1));
            Assert.That(framer.PendingSamples, Is.LessThan(960));

            // And it is the same audio, at the new rate, with no seam at a chunk or frame boundary.
            var received = _sent.SelectMany(frame => Pcm16ToFloats(frame.Data)).ToArray();
            var worst = Enumerable.Range(0, received.Length).Max(i => Math.Abs(received[i] - Tone(48000, i)));
            Assert.That(worst, Is.LessThan(0.001));
        }

        [Test]
        public void A48000HzMicrophonePassesThroughUnchanged()
        {
            var framer = Framer(48000);

            var recorded = AddTone(framer, 48000, 5000, 700, 1, 1300);

            Assert.That(_sent.Count, Is.EqualTo(5));
            Assert.That(framer.PendingSamples, Is.EqualTo(200));
            for (var frame = 0; frame < _sent.Count; frame++)
            {
                Assert.That(_sent[frame].FrameSamples, Is.EqualTo(960));
                Assert.That(_sent[frame].Codec, Is.EqualTo(Codec.PCM));
                Assert.That(_sent[frame].Data, Is.EqualTo(Pcm16(recorded, frame * 960, 960)), $"Frame {frame}");
            }
        }

        [TestCase(44100)]
        [TestCase(48000)]
        public void AnEncoderThatAlwaysFailsNeverHoldsUpAFrame(int recordingRate)
        {
            var calls = 0;
            VoiceFrameEncoder failing = (byte[] pcm, int frameSamples, out string error) =>
            {
                // The old loop asked for the same frame again, forever. Should that come back, it
                // gets the frame through here after a while, and the asserts below fail instead of
                // the test hanging.
                if (++calls > 1000)
                {
                    error = null;
                    return new byte[] { 0xF8 };
                }
                error = "BAD_ARG";
                return null;
            };
            var framer = Framer(recordingRate, failing);

            AddTone(framer, recordingRate, recordingRate, recordingRate / 50);

            // One second is 50 frames, each encoded once and sent as PCM.
            Assert.That(_sent.Count, Is.InRange(49, 50));
            Assert.That(calls, Is.EqualTo(_sent.Count));
            Assert.That(_sent.All(frame => frame.Codec == Codec.PCM && frame.FrameSamples == 960 && frame.Data.Length == 1920), Is.True);
            Assert.That(framer.PendingSamples, Is.LessThan(960));
            Assert.That(_reported, Is.EqualTo(new[] { "BAD_ARG" }), "The failure was not reported exactly once");
        }

        [Test]
        public void AnEncoderThatThrowsFailsTheFrameLikeOneThatReturnsNull()
        {
            VoiceFrameEncoder throwing = (byte[] pcm, int frameSamples, out string error) =>
                throw new DllNotFoundException("libopus");
            var framer = Framer(48000, throwing);

            AddTone(framer, 48000, 960 * 3, 1000);

            Assert.That(_sent.Select(frame => frame.Codec), Is.EqualTo(new[] { Codec.PCM, Codec.PCM, Codec.PCM }));
            Assert.That(_reported, Has.Count.EqualTo(1));
            Assert.That(_reported[0], Does.StartWith("DllNotFoundException: "));
        }

        [Test]
        public void EncodedFramesGoOutAsOpus()
        {
            var encoded = new List<(int PcmBytes, int FrameSamples)>();
            VoiceFrameEncoder encoder = (byte[] pcm, int frameSamples, out string error) =>
            {
                encoded.Add((pcm.Length, frameSamples));
                error = null;
                return new byte[] { 0xF8, (byte)encoded.Count };
            };
            var framer = Framer(44100, encoder);

            AddTone(framer, 44100, 44100, 441);

            Assert.That(_sent, Is.Not.Empty);
            Assert.That(encoded.Distinct(), Is.EqualTo(new[] { (1920, 960) }));
            for (var frame = 0; frame < _sent.Count; frame++)
            {
                Assert.That(_sent[frame].Codec, Is.EqualTo(Codec.OPUS));
                Assert.That(_sent[frame].FrameSamples, Is.EqualTo(960));
                Assert.That(_sent[frame].Data, Is.EqualTo(new byte[] { 0xF8, (byte)(frame + 1) }));
            }
            Assert.That(_reported, Is.Empty);
        }

        [Test]
        public void SamplesPastFullScaleAreClampedNotWrapped()
        {
            var framer = new VoiceFramer(48000, 48000, 2, null,
                (frameSamples, codec, data) => _sent.Add(new SentFrame { Data = data.ToArray() }));

            framer.Add(new[] { 1.5f, -1.5f });

            Assert.That(_sent[0].Data, Is.EqualTo(new byte[] { 0xFF, 0x7F, 0x01, 0x80 }));
        }

        [Test]
        public void AFrameOfNoSamplesIsRefused()
        {
            // A frame that never fills was sent over and over without taking a sample.
            Assert.That(() => new VoiceFramer(48000, 48000, 0, null, (frameSamples, codec, data) => { }),
                Throws.InstanceOf<ArgumentOutOfRangeException>());
            Assert.That(() => new VoiceFramer(48000, 48000, VoiceFramer.MaxFrameSamples + 1, null, (frameSamples, codec, data) => { }),
                Throws.InstanceOf<ArgumentOutOfRangeException>());
        }

        [TestCase(48000, 20, 960)]
        [TestCase(44100, 20, 882)]
        [TestCase(16000, 10, 160)]
        [TestCase(48000, 60, 2880)]
        [TestCase(48000, 0, 0)]
        [TestCase(48000, -20, 0)]
        public void FrameSampleCountIsAtTheGivenRate(int samplingRate, int frameMilliseconds, int expected)
        {
            Assert.That(VoiceFramer.FrameSampleCount(samplingRate, frameMilliseconds), Is.EqualTo(expected));
        }

        [TestCase(16000, 48000, 48000, 48000)]
        [TestCase(48000, 48000, 48000, 48000)]
        [TestCase(8000, 44100, 48000, 44100)]
        [TestCase(96000, 192000, 48000, 96000)]
        [TestCase(0, 0, 48000, 48000, Description = "a microphone that takes any rate")]
        [TestCase(0, 0, 16000, 16000)]
        public void RecordingRateIsTheServersOrTheNearestTheMicrophoneTakes(int minSupported, int maxSupported, int serverRate, int expected)
        {
            Assert.That(VoiceFramer.RecordingRate(minSupported, maxSupported, serverRate), Is.EqualTo(expected));
        }

        [TestCase(48000, 960, true)]
        [TestCase(48000, 120, true, Description = "2.5 ms")]
        [TestCase(48000, 2880, true, Description = "60 ms")]
        [TestCase(8000, 160, true)]
        [TestCase(12000, 240, true)]
        [TestCase(16000, 320, true)]
        [TestCase(24000, 480, true)]
        [TestCase(48000, 958, false, Description = "what 20 ms at 44.1 kHz resampled to")]
        [TestCase(48000, 1440, false, Description = "30 ms")]
        [TestCase(44100, 882, false, Description = "a rate Opus does not encode")]
        [TestCase(32000, 640, false)]
        public void OpusTakesItsSamplingRatesAndFrameDurationsOnly(int samplingRate, int frameSamples, bool expected)
        {
            Assert.That(VoiceFramer.IsOpusFrame(samplingRate, frameSamples), Is.EqualTo(expected));
        }
    }
}
