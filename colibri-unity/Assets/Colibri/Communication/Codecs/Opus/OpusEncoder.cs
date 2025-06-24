using System;
using UnityEngine;

public class OpusEncoder
{
    public int SamplingRate { get; private set; }
    public int Channels { get; private set; }
    public OpusApplication Application { get; private set; }

    private IntPtr pointer;

    public OpusEncoder(int samplingRate, int channels, OpusApplication application)
    {
        SamplingRate = samplingRate;
        Channels = channels;
        Application = application;
        int error;
        pointer = Opus.opus_encoder_create(SamplingRate, Channels, (int)Application, out error);
        if ((OpusError)error != OpusError.OK)
        {
            Debug.LogError("Opus encoder can not be created: " + (OpusError)error);
        }
    }

    public byte[] Encode(byte[] data, int frameSize)
    {
        byte[] buffer = new byte[data.Length];
        int encodedLength = Opus.opus_encode(pointer, data, frameSize, buffer, buffer.Length);
        if (encodedLength < 0)
        {
            Debug.LogError("Opus encoding error occured: " + (OpusError)encodedLength + ". Length: " + data.Length + " Frame size: " + frameSize);
            return null;
        }
        byte[] encodedBytes = new byte[encodedLength];
        Buffer.BlockCopy(buffer, 0, encodedBytes, 0, encodedLength);
        return encodedBytes;
    }

    public void Destroy()
    {
        Opus.opus_encoder_destroy(pointer);
    }
}