using System.Collections;
using System.Collections.Generic;
using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Setup;
using UnityEngine;

namespace HCIKonstanz.Colibri.Communication
{
    [RequireComponent(typeof(AudioSource))]
    public class VoiceReceiver : MonoBehaviour
    {
        public bool FastForwardPlayback = true;
        public int FastForwardLatencyMilliseconds = 100;
        public bool UseOpusCodec = false;
        public int FrameSizeMilliseconds = 20;

        // Debug
        public bool Debugging = false;
        private static readonly string DEBUG_HEADER = "[VoiceReceiver] ";
        private float timer = 0.0f;

        // Playback audio
        private int serverSamplingRate = 48000;
        private int packageSizeSamples = 960;
        private AudioSource playbackAudioSource;
        private List<float> playbackBuffer;
        private VoiceServerConnection voiceServerConnection;
        private short remoteUserId;
        private bool playback = false;
        private Resampler resampler;
        private int fastForwardSamplesThreshold;
        private OpusDecoder opusDecoder;

        private void Awake()
        {
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
            packageSizeSamples = (serverSamplingRate / 1000) * FrameSizeMilliseconds;
            resampler = new Resampler(serverSamplingRate, AudioSettings.outputSampleRate);
            fastForwardSamplesThreshold = serverSamplingRate / 1000 * FastForwardLatencyMilliseconds;

            if (UseOpusCodec)
            {
                opusDecoder = new OpusDecoder(serverSamplingRate, 1);
            }
        }

        private void Update()
        {
            // Debug: Check if data in playback buffer is constant
            if (Debugging && playback)
            {
                timer += Time.deltaTime;
                if (timer > 5f)
                {
                    Debug.Log(DEBUG_HEADER + "Id: " + remoteUserId + " | Samples in playback buffer: " + playbackBuffer.Count);
                    timer = 0f;
                }
            }
        }

        private void OnApplicationQuit()
        {
            if (UseOpusCodec) opusDecoder.Destroy();
        }

        // Use the MonoBehaviour.OnAudioFilterRead callback to playback voice data as fast as possible
        private void OnAudioFilterRead(float[] data, int channels)
        {
            if (playback)
            {
                // Fast forward to latest samples to reduce latency
                if (FastForwardPlayback) FastForwardPlaybackBuffer();
                // Check if the playback buffer has enough data to fill up the data array or otherwise use only the available data
                int dataBufferSize = Mathf.Min(data.Length, playbackBuffer.Count);
                // Get the data from the playback buffer, override the data array with it and remove it from the buffer
                float[] dataBuffer = playbackBuffer.GetRange(0, dataBufferSize).ToArray();
                dataBuffer.CopyTo(data, 0);
                playbackBuffer.RemoveRange(0, dataBufferSize);
                // Clear not already overwritten data
                for (int i = dataBufferSize; i < data.Length; i++)
                {
                    data[i] = 0;
                }
            }
        }

        public void StartPlayback(short id)
        {
            remoteUserId = id;
            voiceServerConnection.AddBytesListener(remoteUserId, OnSamplesDataReceived);
            playbackAudioSource.Play();
            playback = true;
            playbackBuffer = new List<float>();
            Debug.Log(DEBUG_HEADER + "Start voice playback with ID: " + remoteUserId);
        }

        public void StopPlayback()
        {
            Debug.Log(DEBUG_HEADER + "Stop voice playback of ID: " + remoteUserId);
            playback = false;
            playbackAudioSource.Stop();
            voiceServerConnection.RemoveBytesListener(remoteUserId, OnSamplesDataReceived);
        }

        private void OnSamplesDataReceived(byte[] samplesData)
        {
            byte[] shortBytes = samplesData;

            if (UseOpusCodec)
            {
                shortBytes = opusDecoder.Decode(samplesData, packageSizeSamples);
            }

            // Convert bytes to float samples
            float[] samples = SamplingUtility.ConvertShortBytesToFloat(shortBytes);
            // Debug.Log(DEBUG_HEADER + samples.Length + " samples received");
            // Convert to output sample rate if necessary
            if (AudioSettings.outputSampleRate != serverSamplingRate) samples = resampler.ResampleStream(samples);
            // Convert mono samples to stereo
            samples = SamplingUtility.ConvertToStereo(samples);
            // Add samples to playback buffer
            playbackBuffer.AddRange(samples); // Sometimes ArgumentOutOfRangeException
        }

        private void FastForwardPlaybackBuffer()
        {
            if (playbackBuffer.Count < fastForwardSamplesThreshold) return;
            playbackBuffer.RemoveRange(0, playbackBuffer.Count - packageSizeSamples);
            if (Debugging) Debug.Log(DEBUG_HEADER + "Fast forward latency reached. Empty playback buffer.");
        }
    }
}
