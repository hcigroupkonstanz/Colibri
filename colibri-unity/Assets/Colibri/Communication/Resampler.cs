using System.Collections.Generic;
using UnityEngine;

public class Resampler
{
    public int sourceRate { get; private set; }
    public int targetRate { get; private set; }
    private float resampleRatio;
    private float lastSample = 0f;
    private float sourcePos = 0f;

    public Resampler(int sourceRate, int targetRate)
    {
        this.sourceRate = sourceRate;
        this.targetRate = targetRate;
        this.resampleRatio = (float)sourceRate / targetRate;
    }

    public float[] ResampleStream(float[] inputChunk)
    {
        int inputLength = inputChunk.Length;

        // Estimate output length conservatively (could be slightly too big)
        int maxOutputLength = Mathf.CeilToInt((inputLength - sourcePos) / resampleRatio);
        float[] output = new float[maxOutputLength];

        int outputIndex = 0;

        while (sourcePos < inputLength && outputIndex < maxOutputLength)
        {
            int i0 = (int)Mathf.Floor(sourcePos);
            int i1 = Mathf.Min(i0 + 1, inputLength - 1);

            float s0 = (i0 < 0) ? lastSample : inputChunk[i0];
            float s1 = inputChunk[i1];
            float t = sourcePos - i0;

            float interpolated = Mathf.Lerp(s0, s1, t);
            output[outputIndex++] = interpolated;

            sourcePos += resampleRatio;
        }

        // Save state for next chunk
        sourcePos -= inputLength;
        lastSample = inputChunk[inputLength - 1];

        // If we overestimated size, trim array
        if (outputIndex < output.Length)
        {
            float[] trimmed = new float[outputIndex];
            System.Array.Copy(output, trimmed, outputIndex);
            return trimmed;
        }

        return output;
    }
}
