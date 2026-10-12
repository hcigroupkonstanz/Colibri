using System;
using System.Collections;
using System.Collections.Generic;
using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Networking.Protocol;
using HCIKonstanz.Colibri.Setup;
using UnityEngine;

namespace HCIKonstanz.Colibri.Communication
{
    [RequireComponent(typeof(AudioSource))]
    public class VoiceReceiver : MonoBehaviour
    {
        public bool FastForwardPlayback = true;
        public int FastForwardLatencyMilliseconds = 100;
        // Kept so that scripts that set it still compile.
        [Tooltip("No effect. Each packet is decoded by its own codec; Use Opus Codec on VoiceBroadcast decides what a client sends.")]
        public bool UseOpusCodec = false;
        public int FrameSizeMilliseconds = 20;
        public float Volume = 1f;

        // Debug
        public bool Debugging = false;
        private static readonly string DEBUG_HEADER = "[VoiceReceiver] ";
        private float timer = 0.0f;

        // Playback audio
        private int serverSamplingRate = 48000;
        private AudioSource playbackAudioSource;
        // Mono at the output rate, from the main thread to the audio thread
        private VoicePlaybackBuffer playbackBuffer;
        private VoiceServerConnection voiceServerConnection;
        // Whose voice plays, if anyone's
        private VoicePlayback playback;
        // private bool isInitialized = false;
        private Resampler resampler;
        // Samples at the output rate, read on the audio thread: past the threshold, fast-forward
        // drops all but the last packet's samples.
        private volatile int fastForwardSamplesThreshold = 4800;
        private volatile int lastPacketSamples = 960;
        // Audio thread only
        private bool hasReportedPlaybackError;
        // Debug
        private long reportedFastForwarded;

        // Decodes each packet by its codec, creating opusDecoder with the first Opus packet
        private VoiceDecoder voiceDecoder;
        // Null until the first Opus packet, and where Opus cannot decode
        private OpusDecoder opusDecoder;

        private void Awake()
        {
            voiceDecoder = new VoiceDecoder(CreateOpusDecoder, ReportOpusFailure);
            // A second, as VoiceServerConnection queues at most a second of each sender's voice.
            // Here rather than in StartPlayback, so that the audio thread never finds none.
            playbackBuffer = new VoicePlaybackBuffer(Math.Max(AudioSettings.outputSampleRate, 48000));
            playback = new VoicePlayback(playbackBuffer, AddVoicePacketListener, RemoveVoicePacketListener);
            voiceServerConnection = VoiceServerConnection.Instance;
            playbackAudioSource = GetComponent<AudioSource>();
            playbackAudioSource.bypassEffects = false;
            playbackAudioSource.bypassListenerEffects = false;
            playbackAudioSource.bypassReverbZones = true;
            playbackAudioSource.playOnAwake = false;
            playbackAudioSource.loop = true;
        }

        private void Start()
        {
            // Debug
            if (Debugging)
            {
                Debug.Log(DEBUG_HEADER + "Output sampling rate: " + AudioSettings.outputSampleRate);
                Debug.Log(DEBUG_HEADER + "Output channel mode: " + AudioSettings.speakerMode);
                Debug.Log(DEBUG_HEADER + "Spatialize: " + playbackAudioSource.spatialize);
            }
            serverSamplingRate = ColibriConfig.Load().VoiceServerSamplingRate;
            resampler = new Resampler(serverSamplingRate, AudioSettings.outputSampleRate);
            // At the output rate, which the buffer holds. It was at the server rate, compared with a
            // buffer that held two channels, and so half the latency set at 48 kHz.
            fastForwardSamplesThreshold = (int)Math.Min(int.MaxValue, Math.Max(0L, (long)AudioSettings.outputSampleRate * FastForwardLatencyMilliseconds / 1000));
            // isInitialized = true;
        }

        private void Update()
        {
            // Debug: Check if data in playback buffer is constant
            if (Debugging && playback.IsPlaying)
            {
                // Said here rather than on the audio thread
                long fastForwarded = playbackBuffer.FastForwarded;
                if (fastForwarded != reportedFastForwarded)
                {
                    Debug.Log(DEBUG_HEADER + "Fast forward latency reached. Dropped " + (fastForwarded - reportedFastForwarded) + " samples.");
                    reportedFastForwarded = fastForwarded;
                }

                timer += Time.deltaTime;
                if (timer > 5f)
                {
                    Debug.Log(DEBUG_HEADER + "Id: " + playback.Id + " | Samples in playback buffer: " + playbackBuffer.Count);
                    timer = 0f;
                }
            }
        }

        private void OnDestroy()
        {
            // Destroyed while playing, as VoiceManager destroys the receiver of a client it has not
            // heard from: the connection kept delivering to it, and its buffer, which nothing
            // played any more, grew with every packet.
            playback?.Stop();

            // Here rather than in OnApplicationQuit, so that a receiver destroyed before then frees
            // it too. Null unless an Opus packet has come in and Opus runs here.
            opusDecoder?.Destroy();
        }

        // Use the MonoBehaviour.OnAudioFilterRead callback to playback voice data as fast as possible.
        // On the audio thread: nothing here allocates or waits for the main thread.
        private void OnAudioFilterRead(float[] data, int channels)
        {
            VoicePlayback current = playback;
            if (current != null && current.IsPlaying)
            {
                try
                {
                    // Fast forward to latest samples to reduce latency. Each sample goes to every
                    // channel, and what the buffer cannot fill is silence.
                    int fastForwardAbove = FastForwardPlayback ? fastForwardSamplesThreshold : int.MaxValue;
                    current.Read(data, channels, fastForwardAbove, lastPacketSamples);
                }
                catch (Exception e)
                {
                    // Thrown, it is logged for every callback, about 50 a second.
                    Array.Clear(data, 0, data.Length);
                    if (!hasReportedPlaybackError)
                    {
                        hasReportedPlaybackError = true;
                        Debug.LogError(DEBUG_HEADER + "Playing voice failed, playing silence instead. Reported once per receiver.\n" + e);
                    }
                }
            }
        }

        public void StartPlayback(short id)
        {
            // No second listener for the id that plays already: each start added one, and started
            // twice, the receiver played every packet twice. Another id replaces the one playing.
            bool started = playback.Start(id);
            // Also for the id that plays: Unity stops the AudioSource when its GameObject is
            // deactivated, and with playOnAwake off it stays stopped when activated again.
            if (!playbackAudioSource.isPlaying)
                playbackAudioSource.Play();
            if (started)
                Debug.Log(DEBUG_HEADER + "Start voice playback with ID: " + id);
        }

        public void StopPlayback()
        {
            if (!playback.Stop()) return;
            Debug.Log(DEBUG_HEADER + "Stop voice playback of ID: " + playback.Id);
            playbackAudioSource.Stop();
        }

        private void AddVoicePacketListener(short id)
        {
            voiceServerConnection.AddVoicePacketListener(id, OnSamplesDataReceived);
        }

        private void RemoveVoicePacketListener(short id)
        {
            // In OnDestroy on quit, the connection may be gone already
            if (voiceServerConnection != null)
                voiceServerConnection.RemoveVoicePacketListener(id, OnSamplesDataReceived);
        }

        private void OnSamplesDataReceived(VoicePacket voicePacket)
        {
            // Before Start, which reads the sampling rate: StartPlayback right after Instantiate,
            // as VoiceManager calls it, can get a packet delivered in the same frame. The resampler
            // was null then, and the Opus decoder would get the default rate.
            if (resampler == null) return;

            // PCM as it is, Opus decoded, whatever UseOpusCodec says. Null for a packet that
            // cannot be played, such as Opus where it cannot be decoded.
            byte[] shortBytes = voiceDecoder.Decode(voicePacket);
            if (shortBytes == null) return;

            // Convert bytes to float samples
            float[] samples = SamplingUtility.ConvertShortBytesToFloat(shortBytes);

            // Change volume if necessary
            if (Volume != 1f) samples = SamplingUtility.ChangeVolume(samples, Volume);

            // Convert to output sample rate if necessary
            if (AudioSettings.outputSampleRate != serverSamplingRate) samples = resampler.ResampleStream(samples);

            // Add samples to playback buffer. Mono: the audio thread puts each sample on every
            // channel. What fast-forward keeps is this packet's samples.
            lastPacketSamples = samples.Length;
            playbackBuffer.Write(samples, samples.Length);
        }

        private bool CreateOpusDecoder(out VoiceFrameDecoder decoder, out string error)
        {
            decoder = null;
            if (!OpusDecoder.TryCreate(serverSamplingRate, 1, out opusDecoder, out error))
                return false;
            decoder = DecodeOpus;
            return true;
        }

        private byte[] DecodeOpus(byte[] opus, int frameSamples, out string error)
        {
            byte[] pcm = opusDecoder.TryDecode(opus, frameSamples, out OpusError opusError);
            error = pcm == null ? opusError.ToString() : null;
            return pcm;
        }

        private void ReportOpusFailure(string reason)
        {
            Debug.LogWarning(DEBUG_HEADER + "Opus packets of voice id " + playback.Id + " that cannot be decoded are dropped (" + reason + "). PCM packets still play. Reported once per receiver.");
        }
    }
}
