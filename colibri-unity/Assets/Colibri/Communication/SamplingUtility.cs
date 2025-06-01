using UnityEngine;

public class SamplingUtility
{
    public static float[] ConvertToStereo(float[] samples)
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

    public static float[] ConvertToFloat(byte[] byteArray)
    {
        int len = byteArray.Length / 4;
        float[] floatArray = new float[len];
        for (int i = 0; i < byteArray.Length; i += 4)
        {
            floatArray[i / 4] = System.BitConverter.ToSingle(byteArray, i);
        }
        return floatArray;
    }

    public static float[] ConvertShortBytesToFloat(byte[] shortBytes, float[] floatBuffer = null)
    {
        int sampleCount = shortBytes.Length / 2;

        if (floatBuffer == null || floatBuffer.Length != sampleCount)
            floatBuffer = new float[sampleCount];

        for (int i = 0; i < sampleCount; i++)
        {
            // Combine two bytes into a signed 16-bit sample (little endian)
            short sample = (short)(shortBytes[i * 2] | (shortBytes[i * 2 + 1] << 8));
            floatBuffer[i] = sample / 32768f;
        }

        return floatBuffer;
    }

    public static byte[] ConvertToBytes(float[] floatArray)
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

    public static byte[] ConvertFloatToShortBytes(float[] floatData, byte[] byteBuffer = null)
    {
        int sampleCount = floatData.Length;

        if (byteBuffer == null || byteBuffer.Length != sampleCount * 2)
            byteBuffer = new byte[sampleCount * 2];

        for (int i = 0; i < sampleCount; i++)
        {
            short pcm = (short)(floatData[i] * 32767f);

            // Little endian: low byte first
            byteBuffer[i * 2] = (byte)(pcm & 0xFF);
            byteBuffer[i * 2 + 1] = (byte)((pcm >> 8) & 0xFF);
        }

        return byteBuffer;
    }

    public static byte[] ConvertShortBytesToFloatBytes(byte[] shortBytes, byte[] floatByteBuffer = null)
    {
        int sampleCount = shortBytes.Length / 2;

        if (floatByteBuffer == null || floatByteBuffer.Length != sampleCount * 4)
            floatByteBuffer = new byte[sampleCount * 4];

        for (int i = 0; i < sampleCount; i++)
        {
            // Read 16-bit PCM (little endian)
            short sample = (short)(shortBytes[i * 2] | (shortBytes[i * 2 + 1] << 8));

            // Normalize to float
            float floatSample = sample / 32768f;

            // Convert float to bytes
            byte[] floatBytes = System.BitConverter.GetBytes(floatSample);
            System.Buffer.BlockCopy(floatBytes, 0, floatByteBuffer, i * 4, 4);
        }

        return floatByteBuffer;
    }
}