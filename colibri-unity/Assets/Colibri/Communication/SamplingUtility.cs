using UnityEngine;

public class SamplingUtility
{
    public static float[] ToStereo(float[] samples)
    {
        float[] stereoSamples = new float[samples.Length * 2];
        int stereoIndex = 0;
        for (int i = 0; i < samples.Length; i++)
        {
            stereoSamples[stereoIndex] = samples[i];
            stereoSamples[stereoIndex + 1] = samples[i];
            stereoIndex += 2;
        }
        return stereoSamples;
    }

    public static float[] ToSamples(byte[] byteArray)
    {
        int len = byteArray.Length / 4;
        float[] floatArray = new float[len];
        for (int i = 0; i < byteArray.Length; i += 4)
        {
            floatArray[i / 4] = System.BitConverter.ToSingle(byteArray, i);
        }
        return floatArray;
    }

    public static byte[] ToBytes(float[] floatArray)
    {
        int len = floatArray.Length * 4;
        byte[] byteArray = new byte[len];
        int pos = 0;
        foreach (float f in floatArray)
        {
            byte[] data = System.BitConverter.GetBytes(f);
            System.Array.Copy(data, 0, byteArray, pos, 4);
            pos += 4;
        }
        return byteArray;
    }
}