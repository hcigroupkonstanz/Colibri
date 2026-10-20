using System;
using HCIKonstanz.Colibri.Networking.Protocol;

public class Resampler
{
    public int sourceRate { get; private set; }
    public int targetRate { get; private set; }

    // Null if either rate is zero or less; ResampleStream then returns an empty array. VoiceReceiver
    // passes AudioSettings.outputSampleRate as the target, which can be zero without an audio device.
    private readonly StreamingResampler resampler;
    private float[] output = Array.Empty<float>();

    public Resampler(int sourceRate, int targetRate)
    {
        this.sourceRate = sourceRate;
        this.targetRate = targetRate;
        if (sourceRate > 0 && targetRate > 0)
            resampler = new StreamingResampler(sourceRate, targetRate);
    }

    /// <summary>
    /// Resamples the next chunk of a stream, whose chunks may have any length; the output carries
    /// on across them and keeps pace with the input to within one sample.
    /// </summary>
    public float[] ResampleStream(float[] inputChunk)
    {
        if (resampler == null || inputChunk == null || inputChunk.Length == 0)
            return Array.Empty<float>();

        var max = resampler.MaxOutput(inputChunk.Length);
        if (output.Length < max)
            output = new float[max];

        var written = resampler.Process(inputChunk, inputChunk.Length, output);
        var result = new float[written];
        Array.Copy(output, result, written);
        return result;
    }
}
