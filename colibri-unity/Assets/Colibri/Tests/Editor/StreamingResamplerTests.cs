using System;
using System.Collections.Generic;
using HCIKonstanz.Colibri.Networking.Protocol;
using NUnit.Framework;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// The resampler between the microphone's sampling rate and the voice server's, and between the
    /// server's and the audio output's. Audio arrives in chunks of whatever length a frame
    /// recorded, so the chunks have to come out as one stream, at exactly the target rate.
    /// </summary>
    public class StreamingResamplerTests
    {
        private const double ToneHz = 1000;

        private static float Tone(double rate, long index) => (float)Math.Sin(2 * Math.PI * ToneHz * index / rate);

        /// <summary>Resamples <paramref name="inputCount"/> samples of the tone, cut into chunks of the given lengths in turn.</summary>
        private static List<float> ResampleTone(StreamingResampler resampler, long inputCount, params int[] chunkLengths)
        {
            var output = new List<float>();
            var chunk = 0;
            for (long done = 0; done < inputCount; chunk++)
            {
                var length = (int)Math.Min(chunkLengths[chunk % chunkLengths.Length], inputCount - done);
                var input = new float[length];
                for (var i = 0; i < length; i++)
                    input[i] = Tone(resampler.SourceRate, done + i);
                done += length;

                var resampled = new float[resampler.MaxOutput(length)];
                var written = resampler.Process(input, length, resampled);
                for (var i = 0; i < written; i++)
                    output.Add(resampled[i]);
            }
            return output;
        }

        /// <summary>
        /// How many output samples <paramref name="inputCount"/> input samples make: every one up
        /// to the last input sample, the output samples after which wait for the next input sample
        /// to interpolate towards.
        /// </summary>
        private static long OutputCount(long inputCount, int sourceRate, int targetRate)
            => ((inputCount - 1) * targetRate + sourceRate - 1) / sourceRate;

        /// <summary>
        /// Asserts that <paramref name="output"/> is the tone at <paramref name="rate"/>, as closely
        /// as linear interpolation between samples at <paramref name="sourceRate"/> gets it: within
        /// (2 pi f / sourceRate)^2 / 8, 0.0026 for 1 kHz at 44.1 kHz. A seam between chunks, or a
        /// tenth of a sample of drift, is off by more.
        /// </summary>
        private static void AssertIsTone(List<float> output, int sourceRate, int rate, int from = 0)
        {
            var tolerance = Math.Pow(2 * Math.PI * ToneHz / sourceRate, 2) / 8 + 1e-5;
            var worst = 0.0;
            var worstAt = -1;
            for (var i = from; i < output.Count; i++)
            {
                var error = Math.Abs(output[i] - Tone(rate, i));
                if (error > worst)
                {
                    worst = error;
                    worstAt = i;
                }
            }
            Assert.That(worst, Is.LessThanOrEqualTo(tolerance), $"Output sample {worstAt} of {output.Count} is not the tone");
        }

        /// <summary>
        /// 880 samples, 20 ms at 44.1 kHz cut the way VoiceBroadcast used to, came out as 958
        /// where 957.8 is right. A minute of that put the output 500 samples ahead of the input,
        /// and every chunk ended in copies of its last sample.
        /// </summary>
        [Test]
        public void A44100HzStreamComesOutAt48000HzWithoutDrift()
        {
            var resampler = new StreamingResampler(44100, 48000);
            const long seconds = 60;

            var output = ResampleTone(resampler, 44100 * seconds, 880);

            Assert.That(output.Count, Is.EqualTo(OutputCount(44100 * seconds, 44100, 48000)));
            Assert.That(output.Count, Is.EqualTo(48000 * seconds).Within(1));
            AssertIsTone(output, 44100, 48000, output.Count - 48000);
        }

        [Test]
        public void HowTheStreamIsCutDoesNotChangeTheOutput()
        {
            const long inputCount = 44100;
            var whole = ResampleTone(new StreamingResampler(44100, 48000), inputCount, (int)inputCount);
            var oneByOne = ResampleTone(new StreamingResampler(44100, 48000), inputCount, 1);
            var uneven = ResampleTone(new StreamingResampler(44100, 48000), inputCount, 613, 1, 0, 2048, 7);

            Assert.That(oneByOne, Is.EqualTo(whole));
            Assert.That(uneven, Is.EqualTo(whole));
            AssertIsTone(whole, 44100, 48000);
        }

        [TestCase(48000, 16000)]
        [TestCase(48000, 44100)]
        [TestCase(16000, 48000)]
        [TestCase(8000, 44100)]
        [TestCase(22050, 48000)]
        public void EveryRatioKeepsPaceAndShape(int sourceRate, int targetRate)
        {
            var resampler = new StreamingResampler(sourceRate, targetRate);

            var output = ResampleTone(resampler, sourceRate * 10L, 333, 1024);

            Assert.That(output.Count, Is.EqualTo(OutputCount(sourceRate * 10L, sourceRate, targetRate)));
            AssertIsTone(output, sourceRate, targetRate);
        }

        [Test]
        public void EqualRatesPassTheStreamThroughOneSampleLate()
        {
            var resampler = new StreamingResampler(48000, 48000);
            var input = new float[] { 0.1f, -0.2f, 0.3f, 0.4f };
            var output = new float[resampler.MaxOutput(input.Length)];

            Assert.That(resampler.Process(input, input.Length, output), Is.EqualTo(3));
            Assert.That(output[0], Is.EqualTo(0.1f));
            Assert.That(output[1], Is.EqualTo(-0.2f));
            Assert.That(output[2], Is.EqualTo(0.3f));
        }

        [Test]
        public void NoChunkWritesMoreThanMaxOutput()
        {
            foreach (var (source, target) in new[] { (44100, 48000), (48000, 44100), (8000, 48000), (48000, 8000), (48000, 48000) })
            {
                var resampler = new StreamingResampler(source, target);
                var random = new Random(source ^ target);
                for (var chunk = 0; chunk < 2000; chunk++)
                {
                    var length = random.Next(0, 50);
                    var output = new float[resampler.MaxOutput(length)];
                    // Process throws if a chunk writes past the end of output.
                    Assert.That(() => resampler.Process(new float[length], length, output), Throws.Nothing, $"{source} to {target} Hz");
                }
            }
        }

        [Test]
        public void ARateOfZeroOrLessIsRefused()
        {
            Assert.That(() => new StreamingResampler(0, 48000), Throws.InstanceOf<ArgumentOutOfRangeException>());
            Assert.That(() => new StreamingResampler(48000, -1), Throws.InstanceOf<ArgumentOutOfRangeException>());
        }
    }
}
