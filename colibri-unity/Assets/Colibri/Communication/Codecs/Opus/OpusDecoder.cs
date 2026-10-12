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

    private OpusDecoder(int samplingRate, int channels, IntPtr pointer)
    {
        SamplingRate = samplingRate;
        Channels = channels;
        this.pointer = pointer;
    }

    /// <summary>
    /// Creates a decoder, or returns false with the reason: this platform has no Opus library,
    /// the library does not load, or Opus refuses the configuration. Unlike the constructor, it
    /// neither logs nor throws, so the caller can drop Opus packets and say so once.
    /// </summary>
    internal static bool TryCreate(int samplingRate, int channels, out OpusDecoder decoder, out string error)
    {
        decoder = null;
        if (!Opus.HasNativeLibrary)
        {
            error = "Colibri has no Opus library for this platform, only for Windows, Linux and Android";
            return false;
        }

        IntPtr created;
        int code;
        try
        {
            created = Opus.opus_decoder_create(samplingRate, channels, out code);
        }
        // What a P/Invoke throws for a library that is missing, lacks the function, or is built
        // for another CPU architecture.
        catch (Exception e) when (e is DllNotFoundException || e is EntryPointNotFoundException || e is BadImageFormatException)
        {
            error = "the Opus library did not load: " + e.Message;
            return false;
        }

        if ((OpusError)code != OpusError.OK || created == IntPtr.Zero)
        {
            error = "Opus refused " + samplingRate + " Hz with " + channels + " channel(s): " + (OpusError)code;
            return false;
        }

        decoder = new OpusDecoder(samplingRate, channels, created);
        error = null;
        return true;
    }

    public byte[] Decode(byte[] encodedBytes, int frameSize, bool fec = false)
    {
        byte[] decodedBytes = TryDecode(encodedBytes, frameSize, out OpusError error, fec);
        if (decodedBytes == null)
        {
            Debug.LogError("Opus decoding error occured: " + error + ". Length: " + (encodedBytes?.Length ?? 0) + " Frame size: " + frameSize);
        }
        return decodedBytes;
    }

    /// <summary>
    /// Decodes one packet into 16-bit PCM, at most <paramref name="frameSize"/> samples per
    /// channel, or returns null with the error. Unlike <see cref="Decode"/>, it logs nothing:
    /// VoiceReceiver reports a failure once, not for every packet.
    /// </summary>
    internal byte[] TryDecode(byte[] encodedBytes, int frameSize, out OpusError error, bool fec = false)
    {
        // opus_decode does not check its decoder: a destroyed one, or none, can crash the app.
        if (pointer == IntPtr.Zero)
        {
            error = OpusError.INVALID_STATE;
            return null;
        }

        // The frame size comes from the packet: past Opus's longest frame, 120 ms, the room is
        // never used, and zero or less is no room at all.
        int maxSamples = Math.Min(frameSize, SamplingRate / 1000 * 120);
        if (encodedBytes == null || maxSamples <= 0)
        {
            error = OpusError.BAD_ARG;
            return null;
        }

        // For every channel: the buffer used to hold one channel's samples, and with two, Opus
        // wrote past its end.
        byte[] decodedBytes = new byte[maxSamples * Channels * 2];
        int decodedSamples = Opus.opus_decode(pointer, encodedBytes, encodedBytes.Length, decodedBytes, maxSamples, fec ? 1 : 0);
        if (decodedSamples < 0)
        {
            error = (OpusError)decodedSamples;
            return null;
        }
        error = OpusError.OK;

        // A packet shorter than the frame size used to come back padded with silence.
        int decodedLength = decodedSamples * Channels * 2;
        if (decodedLength == decodedBytes.Length)
            return decodedBytes;
        byte[] trimmed = new byte[decodedLength];
        Buffer.BlockCopy(decodedBytes, 0, trimmed, 0, decodedLength);
        return trimmed;
    }

    public void Destroy()
    {
        // Once only: a second opus_decoder_destroy frees the decoder twice.
        if (pointer == IntPtr.Zero)
            return;
        Opus.opus_decoder_destroy(pointer);
        pointer = IntPtr.Zero;
    }
}
