using System;
using HCIKonstanz.Colibri.Communication.Codecs;

namespace HCIKonstanz.Colibri.Networking.Protocol
{
    /// <summary>
    /// Encodes one frame of mono 16-bit little-endian PCM, <paramref name="frameSamples"/> samples
    /// long. Returns the encoded frame, or null with the reason in <paramref name="error"/>.
    /// </summary>
    internal delegate byte[] VoiceFrameEncoder(byte[] pcm, int frameSamples, out string error);

    /// <summary>
    /// Cuts recorded audio into frames of exactly <see cref="FrameSamples"/> samples at the voice
    /// server's sampling rate, which is what a packet's frameSize counts. The audio is resampled
    /// as one stream before it is cut; what does not fill a frame waits for the next chunk. Every
    /// frame is encoded and sent once, whatever the encoder does. No <c>UnityEngine</c>
    /// dependency, so plain NUnit EditMode tests cover it.
    /// </summary>
    internal sealed class VoiceFramer
    {
        /// <summary>
        /// The longest frame a voice packet carries as PCM: a UDP datagram holds 65507 bytes, the
        /// header and 2 bytes per sample. Also keeps the frame size within the header's i16.
        /// </summary>
        internal const int MaxFrameSamples = (65507 - VoicePacketCodec.HeaderSize) / 2;

        // What Opus encodes (RFC 6716): these rates, and frames of 2.5, 5, 10, 20, 40 or 60 ms
        // (in half milliseconds here). Anything else is refused.
        private static readonly int[] OpusSamplingRates = { 8000, 12000, 16000, 24000, 48000 };
        private static readonly int[] OpusFrameHalfMilliseconds = { 5, 10, 20, 40, 80, 120 };

        // Null when the recording rate is the server's rate.
        private readonly StreamingResampler resampler;

        private readonly VoiceFrameEncoder encoder;

        private readonly Action<short, Codec, byte[]> send;
        private readonly Action<string> reportEncodeFailure;

        private readonly float[] frame;
        private readonly byte[] pcm;
        private float[] resampled = Array.Empty<float>();
        private int frameFill;
        private bool encodeFailureReported;

        /// <param name="recordingRate">The sampling rate of the audio passed to <see cref="Add"/>.</param>
        /// <param name="serverRate">The voice server's sampling rate.</param>
        /// <param name="frameSamples">The samples per frame, at <paramref name="serverRate"/>.</param>
        /// <param name="encoder">Encodes each frame; null sends PCM.</param>
        /// <param name="send">
        /// Sends a frame: its sample count, codec and data. The PCM data is reused for the next
        /// frame, so <paramref name="send"/> must not keep it.
        /// </param>
        /// <param name="reportEncodeFailure">Gets the reason the first time the encoder fails.</param>
        internal VoiceFramer(int recordingRate, int serverRate, int frameSamples, VoiceFrameEncoder encoder,
            Action<short, Codec, byte[]> send, Action<string> reportEncodeFailure = null)
        {
            if (frameSamples < 1 || frameSamples > MaxFrameSamples)
                throw new ArgumentOutOfRangeException(nameof(frameSamples), frameSamples, "A voice packet carries 1 to " + MaxFrameSamples + " samples.");
            if (serverRate <= 0)
                throw new ArgumentOutOfRangeException(nameof(serverRate), serverRate, "A sampling rate is positive.");

            if (recordingRate != serverRate)
                resampler = new StreamingResampler(recordingRate, serverRate);
            this.encoder = encoder;
            this.send = send ?? throw new ArgumentNullException(nameof(send));
            this.reportEncodeFailure = reportEncodeFailure;
            frame = new float[frameSamples];
            pcm = new byte[frameSamples * 2];
        }

        internal int FrameSamples => frame.Length;

        /// <summary>The samples, at the server's rate, waiting for a frame to fill. Fewer than <see cref="FrameSamples"/>.</summary>
        internal int PendingSamples => frameFill;

        /// <summary>The samples in a frame of <paramref name="frameMilliseconds"/> at <paramref name="samplingRate"/>, rounded down.</summary>
        internal static int FrameSampleCount(int samplingRate, int frameMilliseconds)
            => (int)Math.Max(0, Math.Min(int.MaxValue, (long)samplingRate * frameMilliseconds / 1000));

        /// <summary>
        /// The sampling rate to record at: the server's if the microphone takes it, else the
        /// nearest one it takes. Unity reports a microphone that takes any rate as 0 to 0 Hz.
        /// </summary>
        internal static int RecordingRate(int minSupported, int maxSupported, int serverRate)
        {
            if (minSupported <= 0 && maxSupported <= 0)
                return serverRate;
            return Math.Max(minSupported, Math.Min(maxSupported, serverRate));
        }

        /// <summary>Whether Opus encodes frames of <paramref name="frameSamples"/> samples at <paramref name="samplingRate"/>.</summary>
        internal static bool IsOpusFrame(int samplingRate, int frameSamples)
        {
            if (Array.IndexOf(OpusSamplingRates, samplingRate) < 0)
                return false;

            foreach (var halfMilliseconds in OpusFrameHalfMilliseconds)
            {
                if ((long)frameSamples * 2000 == (long)samplingRate * halfMilliseconds)
                    return true;
            }
            return false;
        }

        /// <summary>Adds the next recorded samples, and sends every frame they fill.</summary>
        internal void Add(float[] samples)
        {
            if (samples == null)
                throw new ArgumentNullException(nameof(samples));

            if (resampler == null)
            {
                Append(samples, samples.Length);
                return;
            }

            var max = resampler.MaxOutput(samples.Length);
            if (resampled.Length < max)
                resampled = new float[max];
            Append(resampled, resampler.Process(samples, samples.Length, resampled));
        }

        private void Append(float[] samples, int count)
        {
            for (var offset = 0; offset < count;)
            {
                var take = Math.Min(count - offset, frame.Length - frameFill);
                Array.Copy(samples, offset, frame, frameFill, take);
                offset += take;
                frameFill += take;

                if (frameFill == frame.Length)
                {
                    // Reset before sending, so a send that throws does not leave the frame to be sent again.
                    frameFill = 0;
                    SendFrame();
                }
            }
        }

        private void SendFrame()
        {
            ToPcm16(frame, pcm);

            if (encoder != null)
            {
                byte[] encoded;
                string error;
                try
                {
                    encoded = encoder(pcm, frame.Length, out error);
                }
                // A throwing encoder (e.g. a missing native library) fails the frame like a null return.
                catch (Exception e)
                {
                    encoded = null;
                    error = e.GetType().Name + ": " + e.Message;
                }

                if (encoded != null)
                {
                    send((short)frame.Length, Codec.OPUS, encoded);
                    return;
                }

                if (!encodeFailureReported)
                {
                    encodeFailureReported = true;
                    reportEncodeFailure?.Invoke(error ?? "no reason given");
                }
            }

            // A frame the encoder fails on goes out as PCM instead of being dropped. The codec is
            // per packet: VoiceReceiver decodes by it, whatever its Use Opus Codec says.
            send((short)frame.Length, Codec.PCM, pcm);
        }

        // As SamplingUtility.ConvertFloatToShortBytes, but clamped: past full scale the cast to
        // short wraps to the other sign.
        private static void ToPcm16(float[] samples, byte[] bytes)
        {
            for (var i = 0; i < samples.Length; i++)
            {
                var value = (short)(Math.Max(-1f, Math.Min(1f, samples[i])) * 32767f);
                bytes[2 * i] = (byte)value;
                bytes[2 * i + 1] = (byte)(value >> 8);
            }
        }
    }
}
