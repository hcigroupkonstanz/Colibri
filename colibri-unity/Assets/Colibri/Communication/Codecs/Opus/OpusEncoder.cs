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

    private OpusEncoder(int samplingRate, int channels, OpusApplication application, IntPtr pointer)
    {
        SamplingRate = samplingRate;
        Channels = channels;
        Application = application;
        this.pointer = pointer;
    }

    /// <summary>
    /// Creates an encoder, or returns false with the reason: this platform has no Opus library,
    /// the library does not load, or Opus refuses the configuration. Unlike the constructor, it
    /// neither logs nor throws, so the caller can fall back to PCM and say so once.
    /// </summary>
    internal static bool TryCreate(int samplingRate, int channels, OpusApplication application, out OpusEncoder encoder, out string error)
    {
        encoder = null;
        if (!Opus.HasNativeLibrary)
        {
            error = "Colibri has no Opus library for this platform, only for Windows, Linux and Android";
            return false;
        }

        IntPtr created;
        int code;
        try
        {
            created = Opus.opus_encoder_create(samplingRate, channels, (int)application, out code);
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

        encoder = new OpusEncoder(samplingRate, channels, application, created);
        error = null;
        return true;
    }

    public byte[] Encode(byte[] data, int frameSize)
    {
        byte[] encodedBytes = TryEncode(data, frameSize, out OpusError error);
        if (encodedBytes == null)
        {
            Debug.LogError("Opus encoding error occured: " + error + ". Length: " + data.Length + " Frame size: " + frameSize);
        }
        return encodedBytes;
    }

    /// <summary>
    /// Encodes one frame, or returns null with the error. Unlike <see cref="Encode"/>, it logs
    /// nothing: VoiceBroadcast reports a failure once, not for every frame.
    /// </summary>
    internal byte[] TryEncode(byte[] data, int frameSize, out OpusError error)
    {
        // opus_encode does not check its encoder: a destroyed one, or none, can crash the app.
        if (pointer == IntPtr.Zero)
        {
            error = OpusError.INVALID_STATE;
            return null;
        }

        byte[] buffer = new byte[data.Length];
        int encodedLength = Opus.opus_encode(pointer, data, frameSize, buffer, buffer.Length);
        if (encodedLength < 0)
        {
            error = (OpusError)encodedLength;
            return null;
        }
        error = OpusError.OK;
        byte[] encodedBytes = new byte[encodedLength];
        Buffer.BlockCopy(buffer, 0, encodedBytes, 0, encodedLength);
        return encodedBytes;
    }

    public void Destroy()
    {
        // Once only: a second opus_encoder_destroy frees the encoder twice.
        if (pointer == IntPtr.Zero)
            return;
        Opus.opus_encoder_destroy(pointer);
        pointer = IntPtr.Zero;
    }
}
