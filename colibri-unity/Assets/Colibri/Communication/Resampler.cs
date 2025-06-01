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
        resampleRatio = (float)targetRate / sourceRate;
    }

    public float[] ResampleStream(float[] inputChunk)
    {
        int inputLength = inputChunk.Length;
        int outputLength = Mathf.CeilToInt(inputLength * resampleRatio);

        float[] output = new float[outputLength];

        for (int i = 0; i < outputLength; i++)
        {
            int i0 = (int)Mathf.Floor(sourcePos);
            int i1 = Mathf.Min(i0 + 1, inputLength - 1);

            float s0 = (i0 < 0) ? lastSample : inputChunk[Mathf.Clamp(i0, 0, inputLength - 1)];
            float s1 = inputChunk[i1];
            float t = sourcePos - i0;

            float interpolated = Mathf.Lerp(s0, s1, t);
            output[i] = interpolated;

            sourcePos += 1f / resampleRatio;
        }

        sourcePos -= inputLength;
        lastSample = inputChunk[inputLength - 1];

        return output;
    }
}
