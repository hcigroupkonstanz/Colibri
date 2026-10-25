using System;
#if UNITY_STANDALONE_WIN || UNITY_EDITOR_WIN || UNITY_STANDALONE_LINUX || UNITY_EDITOR_LINUX || UNITY_ANDROID
using System.Runtime.InteropServices;
#else
using UnityEngine;
#endif

namespace HCIKonstanz.Colibri.Communication.Codecs
{
    /// <summary>P/Invoke bindings for libopus on Windows, Linux and Android; on other platforms every call logs an error and fails.</summary>
    [Obsolete("Becomes internal in Colibri 3.0, as only Colibri's voice components use it.")]
    public static class Opus
    {
#if UNITY_STANDALONE_WIN || UNITY_EDITOR_WIN || UNITY_STANDALONE_LINUX || UNITY_EDITOR_LINUX || UNITY_ANDROID
        #if UNITY_STANDALONE_WIN || UNITY_EDITOR_WIN
        private const string DllName = "opus";
        #elif UNITY_STANDALONE_LINUX || UNITY_EDITOR_LINUX
        private const string DllName = "libopus";
        #elif UNITY_ANDROID
        private const string DllName = "libopus";
        #endif

        // Also true in the macOS Editor with Android as the build target, where the library does not load.
        internal static readonly bool HasNativeLibrary = true;

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

        internal static readonly bool HasNativeLibrary = false;

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
}
