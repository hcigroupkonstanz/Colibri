using System;
using UnityEngine;

namespace HCIKonstanz.Colibri.Communication.Codecs
{
    internal sealed class OpusDecoder
    {
        public int SamplingRate { get; private set; }
        public int Channels { get; private set; }

        private IntPtr _pointer;

        public OpusDecoder(int samplingRate, int channels)
        {
            SamplingRate = samplingRate;
            Channels = channels;
            int error;
            _pointer = Opus.opus_decoder_create(SamplingRate, Channels, out error);
            if ((OpusError)error != OpusError.OK)
            {
                Debug.LogError("Opus decoder can not be created: " + (OpusError)error);
            }
        }

        private OpusDecoder(int samplingRate, int channels, IntPtr pointer)
        {
            SamplingRate = samplingRate;
            Channels = channels;
            _pointer = pointer;
        }

        // Unlike the constructor, logs nothing: the caller reports the failure.
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
            // Missing library, missing entry point, or a library built for another CPU.
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

        // Unlike Decode, logs nothing: the caller reports failures, once per receiver.
        internal byte[] TryDecode(byte[] encodedBytes, int frameSize, out OpusError error, bool fec = false)
        {
            // opus_decode does not check its decoder: a destroyed one, or none, can crash the app.
            if (_pointer == IntPtr.Zero)
            {
                error = OpusError.INVALID_STATE;
                return null;
            }

            // frameSize comes off the wire, so cap it at Opus's longest frame, 120 ms.
            int maxSamples = Math.Min(frameSize, SamplingRate / 1000 * 120);
            if (encodedBytes == null || maxSamples <= 0)
            {
                error = OpusError.BAD_ARG;
                return null;
            }

            // opus_decode's frame size is per channel: the buffer holds Channels times as many 16-bit samples.
            byte[] decodedBytes = new byte[maxSamples * Channels * 2];
            int decodedSamples = Opus.opus_decode(_pointer, encodedBytes, encodedBytes.Length, decodedBytes, maxSamples, fec ? 1 : 0);
            if (decodedSamples < 0)
            {
                error = (OpusError)decodedSamples;
                return null;
            }
            error = OpusError.OK;

            // A short packet decodes to fewer samples than the buffer holds, so trim to what came back.
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
            if (_pointer == IntPtr.Zero)
                return;
            Opus.opus_decoder_destroy(_pointer);
            _pointer = IntPtr.Zero;
        }
    }
}
