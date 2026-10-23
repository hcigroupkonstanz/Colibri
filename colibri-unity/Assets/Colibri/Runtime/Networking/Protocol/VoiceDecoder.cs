using System;
using HCIKonstanz.Colibri.Communication.Codecs;

namespace HCIKonstanz.Colibri.Networking.Protocol
{
    /// <summary>
    /// Decodes one Opus packet into mono 16-bit little-endian PCM of at most
    /// <paramref name="frameSamples"/> samples, or returns null with the reason in <paramref name="error"/>.
    /// </summary>
    internal delegate byte[] VoiceFrameDecoder(byte[] opus, int frameSamples, out string error);

    /// <summary>Creates the Opus decoder, or returns false with the reason in <paramref name="error"/>.</summary>
    internal delegate bool VoiceFrameDecoderFactory(out VoiceFrameDecoder decoder, out string error);

    /// <summary>
    /// Gets the PCM to play out of received voice packets. The codec is per packet: PCM plays as
    /// is and Opus is decoded, whatever the receiver's Use Opus Codec says (only the one on
    /// VoiceBroadcast decides what a client sends). An Opus packet that cannot be decoded is
    /// dropped, and only the first failure is reported. The Opus decoder is created with the first Opus packet, so a receiver
    /// that only gets PCM never needs Opus. Decode never throws, whatever the decoder or its
    /// factory does.
    /// </summary>
    // No UnityEngine dependency, so plain NUnit EditMode tests can run it.
    internal sealed class VoiceDecoder
    {
        private readonly VoiceFrameDecoderFactory _createOpusDecoder;
        private readonly Action<string> _reportOpusFailure;

        // Null until the first Opus packet, and for good if it could not be created.
        private VoiceFrameDecoder _opusDecoder;
        private bool _hasCreatedOpusDecoder;
        private bool _opusFailureReported;

        internal VoiceDecoder(VoiceFrameDecoderFactory createOpusDecoder, Action<string> reportOpusFailure = null)
        {
            _createOpusDecoder = createOpusDecoder ?? throw new ArgumentNullException(nameof(createOpusDecoder));
            _reportOpusFailure = reportOpusFailure;
        }

        /// <summary>
        /// The mono 16-bit little-endian PCM of <paramref name="packet"/>, or null when it cannot be
        /// played: undecodable Opus, or a codec this version does not know (as PCM it would be noise).
        /// </summary>
        internal byte[] Decode(VoicePacket packet)
        {
            switch (packet.Codec)
            {
                case Codec.PCM:
                    return packet.Data;
                case Codec.OPUS:
                    return DecodeOpus(packet);
                default:
                    return null;
            }
        }

        private byte[] DecodeOpus(VoicePacket packet)
        {
            if (!_hasCreatedOpusDecoder)
            {
                _hasCreatedOpusDecoder = true;
                CreateOpusDecoder();
            }
            if (_opusDecoder == null)
                return null;

            byte[] pcm;
            string error;
            try
            {
                pcm = _opusDecoder(packet.Data, packet.FrameSize, out error);
            }
            // A decoder that throws (e.g. missing native library) fails the packet like one that returns null.
            catch (Exception e)
            {
                pcm = null;
                error = e.GetType().Name + ": " + e.Message;
            }

            if (pcm == null)
                Report("Opus failed on a packet: " + (error ?? "no reason given"));
            return pcm;
        }

        private void CreateOpusDecoder()
        {
            string error;
            try
            {
                if (!_createOpusDecoder(out _opusDecoder, out error))
                    _opusDecoder = null;
            }
            catch (Exception e)
            {
                _opusDecoder = null;
                error = e.GetType().Name + ": " + e.Message;
            }

            if (_opusDecoder == null)
                Report(error ?? "no reason given");
        }

        private void Report(string reason)
        {
            if (_opusFailureReported)
                return;
            _opusFailureReported = true;
            _reportOpusFailure?.Invoke(reason);
        }
    }
}
