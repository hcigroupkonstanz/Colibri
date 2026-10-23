using System;

namespace HCIKonstanz.Colibri.Networking.Protocol
{
    /// <summary>
    /// Linear-interpolation resampler for audio that arrives in chunks of any length. The chunks
    /// are one stream: an output sample between two chunks is interpolated across the boundary,
    /// so cutting the input differently does not change the output.
    /// </summary>
    // No UnityEngine dependency, so EditMode tests can run it.
    internal sealed class StreamingResampler
    {
        internal int SourceRate { get; }
        internal int TargetRate { get; }

        // Left end of the interval the next output sample falls into.
        private float _previous;
        private bool _hasPrevious;

        // Position of the next output sample after _previous, in 1/TargetRate input samples. An
        // integer, so the output count does not drift on a long stream.
        private int _phase;

        internal StreamingResampler(int sourceRate, int targetRate)
        {
            if (sourceRate <= 0)
                throw new ArgumentOutOfRangeException(nameof(sourceRate), sourceRate, "A sampling rate is positive.");
            if (targetRate <= 0)
                throw new ArgumentOutOfRangeException(nameof(targetRate), targetRate, "A sampling rate is positive.");

            SourceRate = sourceRate;
            TargetRate = targetRate;
        }

        /// <summary>An upper bound on the output samples <paramref name="inputCount"/> input samples can make.</summary>
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

                // The first input sample is the first output sample, written once the next input arrives.
                if (!_hasPrevious)
                {
                    _previous = current;
                    _hasPrevious = true;
                    continue;
                }

                for (; _phase < TargetRate; _phase += SourceRate)
                    output[written++] = _previous + (current - _previous) * ((float)_phase / TargetRate);

                _phase -= TargetRate;
                _previous = current;
            }

            return written;
        }
    }
}
