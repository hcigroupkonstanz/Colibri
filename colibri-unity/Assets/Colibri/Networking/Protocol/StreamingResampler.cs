using System;

namespace HCIKonstanz.Colibri.Networking.Protocol
{
    /// <summary>
    /// Linear-interpolation resampler for audio that arrives in chunks of any length, such as what
    /// the microphone recorded since the last frame. The chunks are one stream: an output sample
    /// between the last sample of one chunk and the first of the next is interpolated between the
    /// two, so cutting the input differently does not change the output.
    ///
    /// The position of the next output sample is kept as an exact fraction, in units of
    /// 1/<see cref="TargetRate"/> input samples. After n input samples, n * TargetRate / SourceRate
    /// output samples have come out, give or take one, however long the stream runs. A float
    /// position, rounded up to whole output samples per chunk, let the output run ahead of the
    /// input: at 44.1 to 48 kHz by a sixth of a sample every 20 ms frame, until every chunk ended
    /// in a run of copies of its last sample.
    ///
    /// Free of any <c>UnityEngine</c> dependency, so plain NUnit EditMode tests exercise it.
    /// </summary>
    internal sealed class StreamingResampler
    {
        internal int SourceRate { get; }
        internal int TargetRate { get; }

        // The last input sample, the left end of the interval the next output sample falls into.
        private float previous;
        private bool hasPrevious;

        // Where the next output sample lies after previous, in 1/TargetRate input samples. Below
        // TargetRate, it lies before the next input sample.
        private int phase;

        internal StreamingResampler(int sourceRate, int targetRate)
        {
            if (sourceRate <= 0)
                throw new ArgumentOutOfRangeException(nameof(sourceRate), sourceRate, "A sampling rate is positive.");
            if (targetRate <= 0)
                throw new ArgumentOutOfRangeException(nameof(targetRate), targetRate, "A sampling rate is positive.");

            SourceRate = sourceRate;
            TargetRate = targetRate;
        }

        /// <summary>The most output samples <paramref name="inputCount"/> input samples can make.</summary>
        internal int MaxOutput(int inputCount) => (int)((long)inputCount * TargetRate / SourceRate) + 1;

        /// <summary>
        /// Resamples the first <paramref name="count"/> samples of <paramref name="input"/> into
        /// <paramref name="output"/>, which has to hold <see cref="MaxOutput"/> samples.
        /// </summary>
        /// <returns>The number of samples written to <paramref name="output"/>.</returns>
        internal int Process(float[] input, int count, float[] output)
        {
            if (input == null)
                throw new ArgumentNullException(nameof(input));
            if (output == null)
                throw new ArgumentNullException(nameof(output));
            if (count < 0 || count > input.Length)
                throw new ArgumentOutOfRangeException(nameof(count), count, "Not within the input.");
            if (output.Length < MaxOutput(count))
                throw new ArgumentException("The output cannot hold MaxOutput(count) samples.", nameof(output));

            var written = 0;
            for (var i = 0; i < count; i++)
            {
                var current = input[i];

                // The very first sample only starts the stream: the first output sample is it,
                // interpolated once the next one is there.
                if (!hasPrevious)
                {
                    previous = current;
                    hasPrevious = true;
                    continue;
                }

                for (; phase < TargetRate; phase += SourceRate)
                    output[written++] = previous + (current - previous) * ((float)phase / TargetRate);

                phase -= TargetRate;
                previous = current;
            }

            return written;
        }
    }
}
