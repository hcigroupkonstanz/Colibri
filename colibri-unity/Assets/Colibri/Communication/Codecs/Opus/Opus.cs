using System;
using System.Runtime.InteropServices;

public static class Opus
{
#if UNITY_STANDALONE_WIN || UNITY_EDITOR_WIN
    const string DllName = "opus";
    // #elif UNITY_STANDALONE_OSX || UNITY_EDITOR_OSX
    //     const string DllName = "libopus.dylib";
#elif UNITY_ANDROID
    const string DllName = "libopus";
    // #elif UNITY_STANDALONE_LINUX
    //     const string DllName = "libopus.so";
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
}

