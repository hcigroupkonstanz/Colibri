using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Networking.Protocol;
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
        private int lastRecordingSamplePosition = 0;
        private bool isInitialized = false;
        private bool startAfterInitialized = false;
        private short startId = -1;
        private int microphoneSamplingRate;
        private bool broadcast = false;

        // Networking
        private VoiceServerConnection voiceServerConnection;
        private VoiceFramer framer;
        private int frameSize = 960;
        private short localUserId;

        // Opus codec, null when voice goes out as PCM
        private OpusEncoder opusEncoder;

        private void Start()
        {
#if UNITY_ANDROID
            if (!Permission.HasUserAuthorizedPermission(Permission.Microphone))
            {
                PermissionCallbacks microphonePermissionCallbacks = new PermissionCallbacks();
                microphonePermissionCallbacks.PermissionGranted += OnMicrophonePermissionGranted;
                microphonePermissionCallbacks.PermissionDenied += OnMicrophonePermissionDenied;
#if UNITY_2023_1_OR_NEWER
                // This event only exists from Unity 2023.1 on. Unguarded, it was a compile error
                // in every Android build on 2022.3, the oldest version the package supports.
                microphonePermissionCallbacks.PermissionRequestDismissed += OnMicrophonePermissionDenied;
#endif
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
                SendRecordedSamples();
            }
        }

        private void OnApplicationQuit()
        {
            opusEncoder?.Destroy();
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
            // As VoiceServerConnection has it: frames are counted at this rate, and at 0 they would
            // hold no samples.
            int configuredSamplingRate = ColibriConfig.Load().VoiceServerSamplingRate;
            serverSamplingRate = configuredSamplingRate > 0 ? configuredSamplingRate : 48000;
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

            // Decide on sampling rate. A microphone that takes any rate reports 0 to 0, and its
            // maximum, which this used to record at then, is no rate at all.
            microphoneSamplingRate = VoiceFramer.RecordingRate(minSupportedSamplingRate, maxSupportedSamplingRate, serverSamplingRate);
            if (Debugging) Debug.Log(DEBUG_HEADER + "Use sampling rate: " + microphoneSamplingRate);

            // Frames are cut at the server's sampling rate, which a packet's frame size counts in,
            // after the audio is resampled to it: 20 ms is 960 samples at 48 kHz, whatever rate
            // the microphone records at.
            frameSize = VoiceFramer.FrameSampleCount(serverSamplingRate, FrameSizeMilliseconds);
            if (frameSize < 1 || frameSize > VoiceFramer.MaxFrameSamples)
            {
                // A frame of no samples was sent over and over, and the send loop never ended.
                Debug.LogError(DEBUG_HEADER + "Frame Size Milliseconds " + FrameSizeMilliseconds + " makes frames of " + frameSize + " samples at " + serverSamplingRate + " Hz, which a voice packet cannot carry. Using 20 ms.");
                frameSize = VoiceFramer.FrameSampleCount(serverSamplingRate, 20);
            }
            if (Debugging) Debug.Log(DEBUG_HEADER + "Frame size: " + FrameSizeMilliseconds + " ms, " + frameSize + " samples");

            // Init server connection
            voiceServerConnection = VoiceServerConnection.Instance;

            // Init opus
            opusEncoder = UseOpusCodec ? CreateOpusEncoder() : null;

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

                // A new one for every broadcast, so that none of the last broadcast's audio goes
                // out with this one.
                framer = new VoiceFramer(microphoneSamplingRate, serverSamplingRate, frameSize,
                    opusEncoder != null ? EncodeOpus : (VoiceFrameEncoder)null, SendFrame, ReportEncodeFailure);
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

        /// <summary>
        /// The Opus encoder, or null, having said why, when Opus cannot encode this configuration or
        /// does not run here. Voice then goes out as PCM.
        /// </summary>
        private OpusEncoder CreateOpusEncoder()
        {
            if (!VoiceFramer.IsOpusFrame(serverSamplingRate, frameSize))
            {
                Debug.LogWarning(DEBUG_HEADER + "Use Opus Codec is on, but Opus encodes only 8, 12, 16, 24 or 48 kHz in frames of 2.5, 5, 10, 20, 40 or 60 ms, not frames of " + frameSize + " samples at " + serverSamplingRate + " Hz. Sending voice as PCM.");
                return null;
            }

            if (!OpusEncoder.TryCreate(serverSamplingRate, 1, OpusApplication.VOIP, out OpusEncoder encoder, out string error))
            {
                Debug.LogWarning(DEBUG_HEADER + "Use Opus Codec is on, but " + error + ". Sending voice as PCM.");
                return null;
            }

            return encoder;
        }

        private void SendRecordedSamples()
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
            lastRecordingSamplePosition = currentSamplePosition;

            // Sends every frame they fill; the rest waits for the next samples
            framer.Add(data);
        }

        private byte[] EncodeOpus(byte[] pcm, int frameSamples, out string error)
        {
            byte[] encoded = opusEncoder.TryEncode(pcm, frameSamples, out OpusError opusError);
            error = encoded == null ? opusError.ToString() : null;
            return encoded;
        }

        private void SendFrame(short frameSamples, Codec codec, byte[] data)
        {
            voiceServerConnection.SendByteData(localUserId, 0, frameSamples, codec, data);
        }

        private void ReportEncodeFailure(string error)
        {
            Debug.LogWarning(DEBUG_HEADER + "Opus could not encode a frame (" + error + "). Frames it fails on go out as PCM. Reported once per broadcast.");
        }
    }
}
