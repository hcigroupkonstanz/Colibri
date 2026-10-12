using System;

namespace HCIKonstanz.Colibri.Networking.Protocol
{
    /// <summary>
    /// Decodes one Opus packet into mono 16-bit little-endian PCM, at most
    /// <paramref name="frameSamples"/> samples. Returns the PCM, or null with the reason in
    /// <paramref name="error"/>.
    /// </summary>
    internal delegate byte[] VoiceFrameDecoder(byte[] opus, int frameSamples, out string error);

    /// <summary>
    /// Creates the Opus decoder, or returns false with the reason in <paramref name="error"/>.
    /// </summary>
    internal delegate bool VoiceFrameDecoderFactory(out VoiceFrameDecoder decoder, out string error);

    /// <summary>
    /// Gets the PCM to play out of received voice packets. The codec is per packet: PCM plays as
    /// it is, and Opus is decoded, whatever the receiver's own Use Opus Codec says, which decides
    /// only what a client sends. VoiceReceiver used to decode only with it on, and played Opus
    /// packets as PCM otherwise, which is noise.
    ///
    /// An Opus packet that cannot be decoded is dropped: all of them where Opus does not run, as on
    /// macOS and iOS or in the macOS Editor with Android as the build target, and otherwise the
    /// ones Opus fails on. The first failure is reported, and no other. VoiceReceiver logged two
    /// errors per Opus packet on macOS, and in that Editor threw on every one.
    ///
    /// The decoder is created with the first Opus packet, so a receiver that gets only PCM never
    /// needs Opus. Nothing here throws, whatever the decoder or its factory does.
    ///
    /// Free of any <c>UnityEngine</c> dependency, so plain NUnit EditMode tests exercise it.
    /// </summary>
    internal sealed class VoiceDecoder
    {
        private readonly VoiceFrameDecoderFactory createOpusDecoder;
        private readonly Action<string> reportOpusFailure;

        // Null until the first Opus packet, and for good if it could not be created.
        private VoiceFrameDecoder opusDecoder;
        private bool hasCreatedOpusDecoder;
        private bool opusFailureReported;

        /// <param name="createOpusDecoder">Creates the Opus decoder, once, for the first Opus packet.</param>
        /// <param name="reportOpusFailure">
        /// Gets the reason the first time an Opus packet cannot be decoded: the decoder could not be
        /// created, or failed on a packet.
        /// </param>
        internal VoiceDecoder(VoiceFrameDecoderFactory createOpusDecoder, Action<string> reportOpusFailure = null)
        {
            this.createOpusDecoder = createOpusDecoder ?? throw new ArgumentNullException(nameof(createOpusDecoder));
            this.reportOpusFailure = reportOpusFailure;
        }

        /// <summary>
        /// The mono 16-bit little-endian PCM of <paramref name="packet"/>, or null when it cannot be
        /// played: an Opus packet that cannot be decoded, or one of a codec this version does not
        /// know, which as PCM would be noise too.
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
            if (!hasCreatedOpusDecoder)
            {
                hasCreatedOpusDecoder = true;
                CreateOpusDecoder();
            }
            if (opusDecoder == null)
                return null;

            byte[] pcm;
            string error;
            try
            {
                pcm = opusDecoder(packet.Data, packet.FrameSize, out error);
            }
            // One that throws, such as a call into a native library that is not there, fails the
            // packet like one that returns null.
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
                if (!createOpusDecoder(out opusDecoder, out error))
                    opusDecoder = null;
            }
            catch (Exception e)
            {
                opusDecoder = null;
                error = e.GetType().Name + ": " + e.Message;
            }

            if (opusDecoder == null)
                Report(error ?? "no reason given");
        }

        private void Report(string reason)
        {
            if (opusFailureReported)
                return;
            opusFailureReported = true;
            reportOpusFailure?.Invoke(reason);
        }
    }
}
