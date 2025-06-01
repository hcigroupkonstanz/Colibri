using System;
using UnityEngine;

public class OpusDecoder
{
    public int SamplingRate { get; private set; }
    public int Channels { get; private set; }

    private IntPtr pointer;

    public OpusDecoder(int samplingRate, int channels)
    {
        SamplingRate = samplingRate;
        Channels = channels;
        int error;
        pointer = Opus.opus_decoder_create(SamplingRate, Channels, out error);
        if ((OpusError)error != OpusError.OK)
        {
            Debug.LogError("Opus decoder can not be created: " + (OpusError)error);
        }
    }

    public byte[] Decode(byte[] encodedBytes, int frameSize, bool fec = false)
    {
        byte[] decodedBytes = new byte[frameSize * 2];
        Opus.opus_decode(pointer, encodedBytes, encodedBytes.Length, decodedBytes, frameSize, fec ? 1 : 0);
        return decodedBytes;
    }

    public void Destroy()
    {
        Opus.opus_decoder_destroy(pointer);
    }
}