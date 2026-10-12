using System;

namespace HCIKonstanz.Colibri.Networking.Protocol
{
    /// <summary>
    /// Encodes one frame of mono 16-bit little-endian PCM, <paramref name="frameSamples"/> samples
    /// long. Returns the encoded frame, or null with the reason in <paramref name="error"/>.
    /// </summary>
    internal delegate byte[] VoiceFrameEncoder(byte[] pcm, int frameSamples, out string error);

    /// <summary>
    /// Cuts recorded audio into the frames voice packets carry. A packet's frameSize counts
    /// samples at the voice server's sampling rate, so the audio is resampled to that rate first,
    /// as one stream, and then cut into frames of exactly <see cref="FrameSamples"/> samples. What
    /// does not fill a frame waits for the next chunk. VoiceBroadcast used to cut frames at the
    /// microphone's rate and resample each on its own: 20 ms at 44.1 kHz was 880 samples, and 958
    /// after resampling, a frame size Opus refuses.
    ///
    /// Every frame is encoded once, sent, and gone, whatever the encoder does. VoiceBroadcast kept
    /// a frame Opus failed on and tried it again in the same loop, and as it failed every time,
    /// the app hung.
    ///
    /// Free of any <c>UnityEngine</c> dependency, so plain NUnit EditMode tests exercise it.
    /// </summary>
    internal sealed class VoiceFramer
    {
        /// <summary>
        /// The longest frame a voice packet carries as PCM: a UDP datagram holds 65507 bytes, the
        /// header and 2 bytes per sample. It also keeps the frame size within the header's i16.
        /// </summary>
        internal const int MaxFrameSamples = (65507 - VoicePacketCodec.HeaderSize) / 2;

        // What Opus encodes (RFC 6716): these sampling rates, and frames of 2.5, 5, 10, 20, 40 or
        // 60 ms, here in half milliseconds. It refuses every other frame.
        private static readonly int[] OpusSamplingRates = { 8000, 12000, 16000, 24000, 48000 };
        private static readonly int[] OpusFrameHalfMilliseconds = { 5, 10, 20, 40, 80, 120 };

        // Null when the audio is recorded at the server's rate already.
        private readonly StreamingResampler resampler;

        // Null for PCM.
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
        /// Sends a frame: its sample count, its codec and its data. The PCM data is reused for the
        /// next frame, so <paramref name="send"/> must not keep it.
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

        /// <summary>The samples, at the server's rate, waiting for a frame to fill. Always fewer than <see cref="FrameSamples"/>.</summary>
        internal int PendingSamples => frameFill;

        /// <summary>The samples in a frame of <paramref name="frameMilliseconds"/> at <paramref name="samplingRate"/>, rounded down.</summary>
        internal static int FrameSampleCount(int samplingRate, int frameMilliseconds)
            => (int)Math.Max(0, Math.Min(int.MaxValue, (long)samplingRate * frameMilliseconds / 1000));

        /// <summary>
        /// The sampling rate to record at: the server's if the microphone takes it, or else the
        /// nearest one it takes, which needs the least resampling. Unity reports a microphone
        /// that takes any rate as taking 0 to 0 Hz.
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
                    // Gone before it is sent, so that not even a send that throws brings it back.
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
                // One that throws, such as a call into a native library that is not there, fails
                // the frame like one that returns null.
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

            // A frame the encoder fails on goes out as PCM rather than not at all. The codec is
            // per packet: VoiceReceiver decodes only the packets marked Opus and plays the others
            // as PCM, whether or not its Use Opus Codec is on, and the server passes packets on
            // unchanged. The frame costs more bandwidth, and nobody hears a gap.
            send((short)frame.Length, Codec.PCM, pcm);
        }

        // Mono 16-bit little-endian, as SamplingUtility.ConvertFloatToShortBytes writes it, but
        // clamped: past full scale, the cast to short wraps around to a click of the other sign.
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
