using System;
using HCIKonstanz.Colibri.Communication.Codecs;
using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Networking.Protocol;
using HCIKonstanz.Colibri.Setup;
using UnityEngine;

#pragma warning disable CS0618 // [Obsolete] on the audio types is meant for user code

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
        // No effect either: each packet carries its frame size.
        public int FrameSizeMilliseconds = 20;
        public float Volume = 1f;

        // Debug
        public bool Debugging = false;
        private static readonly string _debugHeader = "[VoiceReceiver] ";
        private float _timer = 0.0f;

        // Playback audio
        private int _serverSamplingRate = 48000;
        private AudioSource _playbackAudioSource;
        // Mono at the output rate, from the main thread to the audio thread
        private VoicePlaybackBuffer _playbackBuffer;
        private VoiceServerConnection _voiceServerConnection;
        private VoicePlayback _playback;
        // private bool isInitialized = false;
        private Resampler _resampler;
        // At the output rate, read on the audio thread. Past the threshold, fast-forward keeps only
        // the last packet's samples.
        private volatile int _fastForwardSamplesThreshold = 4800;
        private volatile int _lastPacketSamples = 960;
        // Audio thread only
        private bool _hasReportedPlaybackError;
        // Debug
        private long _reportedFastForwarded;

        // Decodes each packet by its codec, creating _opusDecoder with the first Opus packet
        private VoiceDecoder _voiceDecoder;
        // Null until the first Opus packet, and where Opus cannot decode
        private OpusDecoder _opusDecoder;

        private void Awake()
        {
            _voiceDecoder = new VoiceDecoder(CreateOpusDecoder, ReportOpusFailure);
            // A second of audio, the most VoiceServerConnection queues per sender.
            _playbackBuffer = new VoicePlaybackBuffer(Math.Max(AudioSettings.outputSampleRate, 48000));
            _playback = new VoicePlayback(_playbackBuffer, AddVoicePacketListener, RemoveVoicePacketListener);
            _voiceServerConnection = VoiceServerConnection.Instance;
            _playbackAudioSource = GetComponent<AudioSource>();
            _playbackAudioSource.bypassEffects = false;
            _playbackAudioSource.bypassListenerEffects = false;
            _playbackAudioSource.bypassReverbZones = true;
            _playbackAudioSource.playOnAwake = false;
            _playbackAudioSource.loop = true;
        }

        private void Start()
        {
            // Debug
            if (Debugging)
            {
                Debug.Log(_debugHeader + "Output sampling rate: " + AudioSettings.outputSampleRate);
                Debug.Log(_debugHeader + "Output channel mode: " + AudioSettings.speakerMode);
                Debug.Log(_debugHeader + "Spatialize: " + _playbackAudioSource.spatialize);
            }
            _serverSamplingRate = ColibriConfig.Load().VoiceServerSamplingRate;
            _resampler = new Resampler(_serverSamplingRate, AudioSettings.outputSampleRate);
            // In samples at the output rate, as the buffer holds them.
            _fastForwardSamplesThreshold = (int)Math.Min(int.MaxValue, Math.Max(0L, (long)AudioSettings.outputSampleRate * FastForwardLatencyMilliseconds / 1000));
            // isInitialized = true;
        }

        private void Update()
        {
            // Debug: Check if data in playback buffer is constant
            if (Debugging && _playback.IsPlaying)
            {
                // Logged here, not on the audio thread.
                long fastForwarded = _playbackBuffer.FastForwarded;
                if (fastForwarded != _reportedFastForwarded)
                {
                    Debug.Log(_debugHeader + "Fast forward latency reached. Dropped " + (fastForwarded - _reportedFastForwarded) + " samples.");
                    _reportedFastForwarded = fastForwarded;
                }

                _timer += Time.deltaTime;
                if (_timer > 5f)
                {
                    Debug.Log(_debugHeader + "Id: " + _playback.Id + " | Samples in playback buffer: " + _playbackBuffer.Count);
                    _timer = 0f;
                }
            }
        }

        private void OnDestroy()
        {
            // Removes the connection's listener, which would keep delivering to a destroyed receiver.
            _playback?.Stop();

            // Here rather than in OnApplicationQuit, so a receiver destroyed earlier frees it too.
            _opusDecoder?.Destroy();
        }

        // Use the MonoBehaviour.OnAudioFilterRead callback to playback voice data as fast as possible
        // Audio thread: the playback path takes no lock and allocates nothing.
        private void OnAudioFilterRead(float[] data, int channels)
        {
            VoicePlayback current = _playback;
            if (current != null && current.IsPlaying)
            {
                try
                {
                    // Fast forward to latest samples to reduce latency
                    int fastForwardAbove = FastForwardPlayback ? _fastForwardSamplesThreshold : int.MaxValue;
                    current.Read(data, channels, fastForwardAbove, _lastPacketSamples);
                }
                catch (Exception e)
                {
                    // Unity logs an escaped exception on every callback, about 50 a second.
                    Array.Clear(data, 0, data.Length);
                    if (!_hasReportedPlaybackError)
                    {
                        _hasReportedPlaybackError = true;
                        Debug.LogError(_debugHeader + "Playing voice failed, playing silence instead. Reported once per receiver.\n" + e);
                    }
                }
            }
        }

        /// <summary>Plays the voice with <paramref name="id"/>, replacing any other.</summary>
        public void StartPlayback(short id)
        {
            bool started = _playback.Start(id);
            // Also when it plays already (started is false): deactivating the GameObject stops the
            // AudioSource, and playOnAwake is off.
            if (!_playbackAudioSource.isPlaying)
                _playbackAudioSource.Play();
            if (started)
                Debug.Log(_debugHeader + "Start voice playback with ID: " + id);
        }

        /// <summary>Stops playing the voice.</summary>
        public void StopPlayback()
        {
            if (!_playback.Stop()) return;
            Debug.Log(_debugHeader + "Stop voice playback of ID: " + _playback.Id);
            _playbackAudioSource.Stop();
        }

        private void AddVoicePacketListener(short id)
        {
            _voiceServerConnection.AddVoicePacketListener(id, OnSamplesDataReceived);
        }

        private void RemoveVoicePacketListener(short id)
        {
            // In OnDestroy on quit, the connection may be gone already
            if (_voiceServerConnection != null)
                _voiceServerConnection.RemoveVoicePacketListener(id, OnSamplesDataReceived);
        }

        private void OnSamplesDataReceived(VoicePacket voicePacket)
        {
            // Before Start, which reads the server sampling rate and creates the resampler:
            // VoiceManager calls StartPlayback right after Instantiate, and a packet can be
            // delivered in the same frame.
            if (_resampler == null) return;

            // Decodes by the packet's codec, not UseOpusCodec. Null if it cannot be played.
            byte[] shortBytes = _voiceDecoder.Decode(voicePacket);
            if (shortBytes == null) return;

            // Convert bytes to float samples
            float[] samples = SamplingUtility.ConvertShortBytesToFloat(shortBytes);

            // Change volume if necessary
            if (Volume != 1f) samples = SamplingUtility.ChangeVolume(samples, Volume);

            // Convert to output sample rate if necessary
            if (AudioSettings.outputSampleRate != _serverSamplingRate) samples = _resampler.ResampleStream(samples);

            // Add samples to playback buffer
            // Mono: the audio thread copies each sample to every channel.
            _lastPacketSamples = samples.Length;
            _playbackBuffer.Write(samples, samples.Length);
        }

        private bool CreateOpusDecoder(out VoiceFrameDecoder decoder, out string error)
        {
            decoder = null;
            if (!OpusDecoder.TryCreate(_serverSamplingRate, 1, out _opusDecoder, out error))
                return false;
            decoder = DecodeOpus;
            return true;
        }

        private byte[] DecodeOpus(byte[] opus, int frameSamples, out string error)
        {
            byte[] pcm = _opusDecoder.TryDecode(opus, frameSamples, out OpusError opusError);
            error = pcm == null ? opusError.ToString() : null;
            return pcm;
        }

        private void ReportOpusFailure(string reason)
        {
            Debug.LogWarning(_debugHeader + "Opus packets of voice id " + _playback.Id + " that cannot be decoded are dropped (" + reason + "). PCM packets still play. Reported once per receiver.");
        }
    }
}
