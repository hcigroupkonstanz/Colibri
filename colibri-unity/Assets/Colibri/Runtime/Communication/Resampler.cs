using System;
using HCIKonstanz.Colibri.Networking.Protocol;

namespace HCIKonstanz.Colibri.Communication
{
    /// <summary>Converts a stream of float samples from one sampling rate to another, one chunk at a time.</summary>
    [Obsolete("Becomes internal in Colibri 3.0, as only Colibri's voice components use it.")]
    public class Resampler
    {
        public int SourceRate { get; private set; }
        public int TargetRate { get; private set; }

        // Null if either rate is zero or less; ResampleStream then returns an empty array. VoiceReceiver
        // passes AudioSettings.outputSampleRate as the target, which can be zero without an audio device.
        private readonly StreamingResampler _resampler;
        private float[] _output = Array.Empty<float>();

        public Resampler(int sourceRate, int targetRate)
        {
            SourceRate = sourceRate;
            TargetRate = targetRate;
            if (sourceRate > 0 && targetRate > 0)
                _resampler = new StreamingResampler(sourceRate, targetRate);
        }

        /// <summary>
        /// Resamples the next chunk of a stream, whose chunks may have any length; the output carries
        /// on across them and keeps pace with the input to within one sample.
        /// </summary>
        public float[] ResampleStream(float[] inputChunk)
        {
            if (_resampler == null || inputChunk == null || inputChunk.Length == 0)
                return Array.Empty<float>();

            var max = _resampler.MaxOutput(inputChunk.Length);
            if (_output.Length < max)
                _output = new float[max];

            var written = _resampler.Process(inputChunk, inputChunk.Length, _output);
            var result = new float[written];
            Array.Copy(_output, result, written);
            return result;
        }
    }
}
