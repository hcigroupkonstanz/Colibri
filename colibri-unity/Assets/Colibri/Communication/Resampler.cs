using System;
using HCIKonstanz.Colibri.Networking.Protocol;

public class Resampler
{
    public int sourceRate { get; private set; }
    public int targetRate { get; private set; }

    // Null for a rate of zero or less, which resamples to nothing. AudioSettings.outputSampleRate,
    // VoiceReceiver's target rate, can be that without an audio device, and the old implementation
    // did not throw for it either.
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
    /// Resamples the next chunk of a stream. The chunks may have any length: the stream carries
    /// on from one chunk to the next, and how many samples come out of a chunk varies by one so
    /// that the output keeps exact pace with the input.
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
