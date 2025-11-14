using System;
using System.Runtime.InteropServices;
using UnityEngine;

public static class Opus
{
#if UNITY_STANDALONE_WIN || UNITY_EDITOR_WIN || UNITY_STANDALONE_LINUX || UNITY_EDITOR_LINUX || UNITY_ANDROID
    #if UNITY_STANDALONE_WIN || UNITY_EDITOR_WIN
    const string DllName = "opus";
    #elif UNITY_STANDALONE_LINUX || UNITY_EDITOR_LINUX
    const string DllName = "libopus";
    #elif UNITY_ANDROID
    const string DllName = "libopus";
    #endif

    [DllImport(DllName)]
    public static extern IntPtr opus_encoder_create(int Fs, int channels, int application, out int error);

    [DllImport(DllName)]
    public static extern void opus_encoder_destroy(IntPtr encoder);

    [DllImport(DllName)]
    public static extern int opus_encode(IntPtr st, byte[] pcm, int frame_size, byte[] data, int max_data_bytes);

    [DllImport(DllName)]
    public static extern IntPtr opus_decoder_create(int Fs, int channels, out int error);

    [DllImport(DllName)]
    public static extern void opus_decoder_destroy(IntPtr decoder);

    [DllImport(DllName)]
    public static extern int opus_decode(IntPtr st, byte[] data, int len, byte[] pcm, int frame_size, int decode_fec);

#else
    // Stub implementations for unsupported platforms

    public static IntPtr opus_encoder_create(int Fs, int channels, int application, out int error)
    {
        Debug.LogError("Opus is not supported on this platform.");
        error = -1;
        return IntPtr.Zero;
    }

    public static void opus_encoder_destroy(IntPtr encoder)
    {
        Debug.LogError("Opus is not supported on this platform.");
    }

    public static int opus_encode(IntPtr st, byte[] pcm, int frame_size, byte[] data, int max_data_bytes)
    {
        Debug.LogError("Opus is not supported on this platform.");
        return -1;
    }

    public static IntPtr opus_decoder_create(int Fs, int channels, out int error)
    {
        Debug.LogError("Opus is not supported on this platform.");
        error = -1;
        return IntPtr.Zero;
    }

    public static void opus_decoder_destroy(IntPtr decoder)
    {
        Debug.LogError("Opus is not supported on this platform.");
    }

    public static int opus_decode(IntPtr st, byte[] data, int len, byte[] pcm, int frame_size, int decode_fec)
    {
        Debug.LogError("Opus is not supported on this platform.");
        return -1;
    }
#endif
}
