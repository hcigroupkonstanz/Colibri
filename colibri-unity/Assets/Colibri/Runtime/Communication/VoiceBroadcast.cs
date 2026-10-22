using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using HCIKonstanz.Colibri.Communication.Codecs;
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

        // Null for the default microphone. Chosen once, in InitBroadcast.
        private string microphoneDevice;

        // Networking
        private VoiceServerConnection voiceServerConnection;
        private VoiceFramer framer;
        private int frameSize = 960;
        private short localUserId;

        // Opus codec
        private OpusEncoder opusEncoder;

#if UNITY_ANDROID
        // Permission callbacks may not run on the main thread: they only set the volatile flags, and Update acts on them.
        private bool waitingForPermission;
        private float permissionCheckedAt;
        private bool permissionAskedAgain;
        private volatile bool permissionGranted;
        private volatile bool permissionDismissed;
#endif

        private void Start()
        {
#if UNITY_ANDROID
            if (!Permission.HasUserAuthorizedPermission(Permission.Microphone))
            {
                waitingForPermission = true;
                RequestMicrophonePermission();
                return;
            }
#endif
            InitBroadcast();
        }

#if UNITY_ANDROID
        private void RequestMicrophonePermission()
        {
            PermissionCallbacks microphonePermissionCallbacks = new PermissionCallbacks();
            microphonePermissionCallbacks.PermissionGranted += _ => permissionGranted = true;
            microphonePermissionCallbacks.PermissionDenied += OnMicrophonePermissionDenied;
#if UNITY_2023_1_OR_NEWER
            // PermissionRequestDismissed exists from Unity 2023.1.
            microphonePermissionCallbacks.PermissionRequestDismissed += _ => permissionDismissed = true;
#endif
            Permission.RequestUserPermission(Permission.Microphone, microphonePermissionCallbacks);
        }

        // Dismissed: the user closed the dialog, or Android cancelled the request for another one.
        // Asked once more; after that, Update's poll picks up a later grant.
        private void OnMicrophonePermissionDismissed()
        {
            if (!permissionAskedAgain)
            {
                permissionAskedAgain = true;
                RequestMicrophonePermission();
                return;
            }
            Debug.LogWarning(DEBUG_HEADER + "The microphone permission request was closed without an answer. Voice starts once the "
                + "permission is granted, e.g. in the device's settings for this app.");
        }
#endif

        private void Update()
        {
#if UNITY_ANDROID
            if (permissionDismissed)
            {
                permissionDismissed = false;
                OnMicrophonePermissionDismissed();
            }

            // A grant by the request sets the flag; one made outside it (device settings, another request) is polled for.
            // Once a second, since the check goes through Java.
            if (permissionGranted)
            {
                permissionGranted = false;
                InitBroadcast();
            }
            else if (waitingForPermission && Time.unscaledTime - permissionCheckedAt >= 1f)
            {
                permissionCheckedAt = Time.unscaledTime;
                if (Permission.HasUserAuthorizedPermission(Permission.Microphone))
                    InitBroadcast();
            }
#endif
            if (isInitialized && broadcast)
            {
                SendRecordedSamples();
            }
        }

        private void OnApplicationQuit()
        {
            opusEncoder?.Destroy();
        }


        private void OnMicrophonePermissionDenied(string permissionName)
        {
            Debug.LogError(DEBUG_HEADER + "Voice Broadcast initialization failed: Microphone permission NOT granted. Voice starts "
                + "once it is granted, e.g. in the device's settings for this app.");
        }

        // Android (Meta Quest included) always records from the default microphone.
        // MicrophoneID is an index into this device's list, so it can be out of range.
        private string ChooseMicrophone(string[] devices)
        {
            if (Application.platform == RuntimePlatform.Android)
                return null;
            if (MicrophoneID >= 0 && MicrophoneID < devices.Length)
                return devices[MicrophoneID];

            Debug.LogWarning(DEBUG_HEADER + "Microphone ID " + MicrophoneID + " is not a microphone of this device, which has "
                + devices.Length + ". Using the default one.");
            return null;
        }

        private void InitBroadcast()
        {
#if UNITY_ANDROID
            waitingForPermission = false;
#endif
            // Reached from the grant flag and from the poll in Update, whichever comes first.
            if (isInitialized)
                return;

            // Same fallback as VoiceServerConnection; at 0 frames would hold no samples.
            int configuredSamplingRate = ColibriConfig.Load().VoiceServerSamplingRate;
            serverSamplingRate = configuredSamplingRate > 0 ? configuredSamplingRate : 48000;
            // Get all available recording devices and select recording device
            string[] recordingDevices = Microphone.devices;
            if (recordingDevices.Length == 0)
            {
                Debug.LogError(DEBUG_HEADER + "Voice Broadcast initialization failed: No recording device found");
                return;
            }
            microphoneDevice = ChooseMicrophone(recordingDevices);
            if (Debugging)
            {
                for (int i = 0; i < recordingDevices.Length; i++)
                {
                    Debug.Log(DEBUG_HEADER + "Recording device found: " + recordingDevices[i] + " ID: " + i);
                }
                Debug.Log(DEBUG_HEADER + "Using recording device: " + (microphoneDevice ?? "the default one"));
            }

            // Get supported sampling rates of the selected recording device
            int minSupportedSamplingRate;
            int maxSupportedSamplingRate;
            Microphone.GetDeviceCaps(microphoneDevice, out minSupportedSamplingRate, out maxSupportedSamplingRate);
            if (Debugging) Debug.Log(DEBUG_HEADER + "Sampling rates supported: " + minSupportedSamplingRate + " - " + maxSupportedSamplingRate);

            // Decide on sampling rate
            microphoneSamplingRate = VoiceFramer.RecordingRate(minSupportedSamplingRate, maxSupportedSamplingRate, serverSamplingRate);
            if (Debugging) Debug.Log(DEBUG_HEADER + "Use sampling rate: " + microphoneSamplingRate);

            // Calculate package size based on requested frame size (milliseconds)
            // Frames are cut after resampling, so they count samples at the server's rate, not the microphone's.
            frameSize = VoiceFramer.FrameSampleCount(serverSamplingRate, FrameSizeMilliseconds);
            if (frameSize < 1 || frameSize > VoiceFramer.MaxFrameSamples)
            {
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
                recordingAudioClip = Microphone.Start(microphoneDevice, true, MicrophoneBufferLengthSeconds, microphoneSamplingRate);
                if (Debugging) Debug.Log(DEBUG_HEADER + "Channel count: " + recordingAudioClip.channels);
                lastRecordingSamplePosition = Microphone.GetPosition(microphoneDevice);

                // New per broadcast, so no samples left over from the last one go out.
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
                Microphone.End(microphoneDevice);
            }
        }

        // Null, after logging why, when Opus cannot encode this configuration or does not run here.
        // Voice then goes out as PCM.
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
            int currentSamplePosition = Microphone.GetPosition(microphoneDevice);
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

            // Sends each frame the samples fill; the remainder waits for the next call.
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
