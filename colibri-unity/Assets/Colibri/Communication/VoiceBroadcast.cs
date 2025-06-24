using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using HCIKonstanz.Colibri.Networking;
using UnityEngine.Android;
using HCIKonstanz.Colibri.Setup;
using System;

namespace HCIKonstanz.Colibri.Communication
{
    public class VoiceBroadcast : MonoBehaviour
    {
        [Header("Microphone Settings")]
        public int MicrophoneID = 0;
        public int MicrophoneBufferLengthSeconds = 10;

        [Header("Broadcasting Settings")]
        public int FrameSizeMilliseconds = 20;
        public bool UseOpusCodec = false;

        [Header("Debug")]
        public bool Debugging = false;


        // Debug
        private static readonly string DEBUG_HEADER = "[VoiceBroadcast] ";

        // Microphone recording
        private int serverSamplingRate = 48000;
        private AudioClip recordingAudioClip;
        private List<float> recordingBuffer;
        private int lastRecordingSamplePosition = 0;
        private bool isInitialized = false;
        private bool startAfterInitialized = false;
        private short startId = -1;
        private int microphoneSamplingRate;
        private bool broadcast = false;
        private Resampler resampler;

        // Networking
        private VoiceServerConnection voiceServerConnection;
        private int frameSize = 960;
        private short localUserId;

        // Opus codec
        private OpusEncoder opusEncoder;
        // private IntPtr opusEncoder;
        // private IntPtr opusDecoder;

        private void Start()
        {
#if UNITY_ANDROID
            if (!Permission.HasUserAuthorizedPermission(Permission.Microphone))
            {
                PermissionCallbacks microphonePermissionCallbacks = new PermissionCallbacks();
                microphonePermissionCallbacks.PermissionGranted += OnMicrophonePermissionGranted;
                microphonePermissionCallbacks.PermissionDenied += OnMicrophonePermissionDenied;
                microphonePermissionCallbacks.PermissionRequestDismissed += OnMicrophonePermissionDenied;
                Permission.RequestUserPermission(Permission.Microphone, microphonePermissionCallbacks);
                return;
            }
#endif
            InitBroadcast();
        }

        private void Update()
        {
            if (isInitialized && broadcast)
            {
                AddSamplesToRecordingBuffer();
                SendSamples();
            }
        }

        private void OnApplicationQuit()
        {
            if (UseOpusCodec) opusEncoder.Destroy();
        }

        private void OnMicrophonePermissionGranted(string permissionName)
        {
            InitBroadcast();
        }

        private void OnMicrophonePermissionDenied(string permissionName)
        {
            Debug.LogError(DEBUG_HEADER + "Voice Broadcast initialization failed: Microphone permission NOT granted");
        }

        private void InitBroadcast()
        {
            serverSamplingRate = ColibriConfig.Load().VoiceServerSamplingRate;
            // Get all available recording devices and select recording device
            string[] recordingDevices = Microphone.devices;
            if (recordingDevices.Length == 0)
            {
                Debug.LogError(DEBUG_HEADER + "Voice Broadcast initialization failed: No recording device found");
                return;
            }
            if (Debugging)
            {
                for (int i = 0; i < recordingDevices.Length; i++)
                {
                    Debug.Log(DEBUG_HEADER + "Recording device found: " + recordingDevices[i] + " ID: " + i);
                }
                Debug.Log(DEBUG_HEADER + "Using recording device: " + recordingDevices[MicrophoneID] + " ID: " + MicrophoneID);
            }

            // Get supported sampling rates of the selected recording device
            int minSupportedSamplingRate;
            int maxSupportedSamplingRate;
            Microphone.GetDeviceCaps(recordingDevices[MicrophoneID], out minSupportedSamplingRate, out maxSupportedSamplingRate);
            if (Debugging) Debug.Log(DEBUG_HEADER + "Sampling rates supported: " + minSupportedSamplingRate + " - " + maxSupportedSamplingRate);

            // Decide on sampling rate
            microphoneSamplingRate = maxSupportedSamplingRate;
            if (maxSupportedSamplingRate >= serverSamplingRate && minSupportedSamplingRate <= serverSamplingRate) microphoneSamplingRate = serverSamplingRate;
            if (Debugging) Debug.Log(DEBUG_HEADER + "Use sampling rate: " + microphoneSamplingRate);
            if (microphoneSamplingRate != serverSamplingRate) resampler = new Resampler(microphoneSamplingRate, serverSamplingRate);

            // Calculate package size based on requested frame size (milliseconds)
            frameSize = (microphoneSamplingRate / 1000) * FrameSizeMilliseconds;
            if (Debugging) Debug.Log(DEBUG_HEADER + "Frame size: " + FrameSizeMilliseconds + " ms, " + frameSize + " samples");

            // Init server connection
            voiceServerConnection = VoiceServerConnection.Instance;

            // Init opus
            if (UseOpusCodec)
            {
                opusEncoder = new OpusEncoder(serverSamplingRate, 1, OpusApplication.VOIP);
            }

            isInitialized = true;
            Debug.Log(DEBUG_HEADER + "Ready for Voice Broadcast");

            if (startAfterInitialized)
            {
                StartBroadcast(startId);
            }
        }

        public void StartBroadcast(short id)
        {
            if (isInitialized)
            {
                localUserId = id;

                // Start recording using selected recording device
                Debug.Log(DEBUG_HEADER + "Start voice broadcasting");
#if UNITY_ANDROID
                recordingAudioClip = Microphone.Start(null, true, MicrophoneBufferLengthSeconds, microphoneSamplingRate);
#else
                recordingAudioClip = Microphone.Start(Microphone.devices[MicrophoneID], true, MicrophoneBufferLengthSeconds, microphoneSamplingRate);
#endif
                if (Debugging) Debug.Log(DEBUG_HEADER + "Channel count: " + recordingAudioClip.channels);
                lastRecordingSamplePosition = Microphone.GetPosition(null);

                recordingBuffer = new List<float>();
                broadcast = true;
            }
            else
            {
                startId = id;
                startAfterInitialized = true;
            }
        }

        public void StopBroadcast()
        {
            if (broadcast)
            {
                broadcast = false;
#if UNITY_ANDROID
                Microphone.End(null);
#else
                Microphone.End(Microphone.devices[MicrophoneID]);
#endif
            }
        }

        private void AddSamplesToRecordingBuffer()
        {
            int differenceSinceLastAdd = 0;

            // Get sample count since last adding
#if UNITY_ANDROID
            int currentSamplePosition = Microphone.GetPosition(null);
#else
            int currentSamplePosition = Microphone.GetPosition(Microphone.devices[MicrophoneID]);
#endif
            if (currentSamplePosition > lastRecordingSamplePosition)
            {
                differenceSinceLastAdd = currentSamplePosition - lastRecordingSamplePosition;
            }
            else if (currentSamplePosition < lastRecordingSamplePosition)
            {
                differenceSinceLastAdd = recordingAudioClip.samples - lastRecordingSamplePosition + currentSamplePosition;
            }
            else
            {
                return;
            }

            // Get samples since last adding
            float[] data = new float[differenceSinceLastAdd];
            recordingAudioClip.GetData(data, lastRecordingSamplePosition);

            // Add samples to recording buffer
            recordingBuffer.AddRange(data);
            lastRecordingSamplePosition = currentSamplePosition;
        }

        private void SendSamples()
        {
            // Check if enough data is available to send a frame
            while (recordingBuffer.Count > frameSize)
            {
                float[] samples = recordingBuffer.GetRange(0, frameSize).ToArray();

                // The data is expected to be in the voice server sampling rate in mono
                if (microphoneSamplingRate != serverSamplingRate)
                {
                    samples = resampler.ResampleStream(samples);
                }

                // Convert to 16 bit short bytes
                byte[] sendBytes = SamplingUtility.ConvertFloatToShortBytes(samples);

                Codec codec = Codec.PCM;

                if (UseOpusCodec)
                {
                    sendBytes = opusEncoder.Encode(sendBytes, samples.Length);
                    if (sendBytes == null) continue;
                    codec = Codec.OPUS;
                }

                // Send voice data to server
                voiceServerConnection.SendByteData(localUserId, 0, (short)samples.Length, codec, sendBytes);

                // Remove samples from recording buffer
                recordingBuffer.RemoveRange(0, frameSize);
            }
        }
    }
}
