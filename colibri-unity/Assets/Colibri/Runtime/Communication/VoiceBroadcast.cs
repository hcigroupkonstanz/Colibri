using UnityEngine;
using HCIKonstanz.Colibri.Communication.Codecs;
using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Networking.Protocol;
#if UNITY_ANDROID
using UnityEngine.Android;
#endif
using HCIKonstanz.Colibri.Setup;

#pragma warning disable CS0618 // [Obsolete] on the audio types is meant for user code

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
        private static readonly string _debugHeader = "[VoiceBroadcast] ";

        // Microphone recording
        private int _serverSamplingRate = 48000;
        private AudioClip _recordingAudioClip;
        private int _lastRecordingSamplePosition = 0;
        private bool _isInitialized = false;
        private bool _startAfterInitialized = false;
        private short _startId = -1;
        private int _microphoneSamplingRate;
        private bool _broadcast = false;

        // Null for the default microphone. Chosen once, in InitBroadcast.
        private string _microphoneDevice;

        // Networking
        private VoiceServerConnection _voiceServerConnection;
        private VoiceFramer _framer;
        private int _frameSize = 960;
        private short _localUserId;

        // Opus codec
        private OpusEncoder _opusEncoder;

#if UNITY_ANDROID
        // Permission callbacks may not run on the main thread: they only set the volatile flags, and Update acts on them.
        private bool _waitingForPermission;
        private float _permissionCheckedAt;
        private bool _permissionAskedAgain;
        private volatile bool _permissionGranted;
        private volatile bool _permissionDismissed;
#endif

        private void Start()
        {
#if UNITY_ANDROID
            if (!Permission.HasUserAuthorizedPermission(Permission.Microphone))
            {
                _waitingForPermission = true;
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
            microphonePermissionCallbacks.PermissionGranted += _ => _permissionGranted = true;
            microphonePermissionCallbacks.PermissionDenied += OnMicrophonePermissionDenied;
#if UNITY_2023_1_OR_NEWER
            // PermissionRequestDismissed exists from Unity 2023.1.
            microphonePermissionCallbacks.PermissionRequestDismissed += _ => _permissionDismissed = true;
#endif
            Permission.RequestUserPermission(Permission.Microphone, microphonePermissionCallbacks);
        }

        // Dismissed: the user closed the dialog, or Android cancelled the request for another one.
        // Asked once more; after that, Update's poll picks up a later grant.
        private void OnMicrophonePermissionDismissed()
        {
            if (!_permissionAskedAgain)
            {
                _permissionAskedAgain = true;
                RequestMicrophonePermission();
                return;
            }
            Debug.LogWarning(_debugHeader + "The microphone permission request was closed without an answer. Voice starts once the "
                + "permission is granted, e.g. in the device's settings for this app.");
        }
#endif

        private void Update()
        {
#if UNITY_ANDROID
            if (_permissionDismissed)
            {
                _permissionDismissed = false;
                OnMicrophonePermissionDismissed();
            }

            // A grant by the request sets the flag; one made outside it (device settings, another request) is polled for.
            // Once a second, since the check goes through Java.
            if (_permissionGranted)
            {
                _permissionGranted = false;
                InitBroadcast();
            }
            else if (_waitingForPermission && Time.unscaledTime - _permissionCheckedAt >= 1f)
            {
                _permissionCheckedAt = Time.unscaledTime;
                if (Permission.HasUserAuthorizedPermission(Permission.Microphone))
                    InitBroadcast();
            }
#endif
            if (_isInitialized && _broadcast)
            {
                SendRecordedSamples();
            }
        }

        private void OnApplicationQuit()
        {
            _opusEncoder?.Destroy();
        }


        private void OnMicrophonePermissionDenied(string permissionName)
        {
            Debug.LogError(_debugHeader + "Voice Broadcast initialization failed: Microphone permission NOT granted. Voice starts "
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

            Debug.LogWarning(_debugHeader + "Microphone ID " + MicrophoneID + " is not a microphone of this device, which has "
                + devices.Length + ". Using the default one.");
            return null;
        }

        private void LogRecordingDevices(string[] recordingDevices)
        {
            if (Debugging)
            {
                for (int i = 0; i < recordingDevices.Length; i++)
                {
                    Debug.Log(_debugHeader + "Recording device found: " + recordingDevices[i] + " ID: " + i);
                }
                Debug.Log(_debugHeader + "Using recording device: " + (_microphoneDevice ?? "the default one"));
            }
        }

        private void ApplyFrameSize()
        {
            // Frames are cut after resampling, so they count samples at the server's rate, not the microphone's.
            _frameSize = VoiceFramer.FrameSampleCount(_serverSamplingRate, FrameSizeMilliseconds);
            if (_frameSize < 1 || _frameSize > VoiceFramer.MaxFrameSamples)
            {
                Debug.LogError(_debugHeader + "Frame Size Milliseconds " + FrameSizeMilliseconds + " makes frames of " + _frameSize + " samples at " + _serverSamplingRate + " Hz, which a voice packet cannot carry. Using 20 ms.");
                _frameSize = VoiceFramer.FrameSampleCount(_serverSamplingRate, 20);
            }
            if (Debugging) Debug.Log(_debugHeader + "Frame size: " + FrameSizeMilliseconds + " ms, " + _frameSize + " samples");
        }

        private void InitBroadcast()
        {
#if UNITY_ANDROID
            _waitingForPermission = false;
#endif
            // Reached from the grant flag and from the poll in Update, whichever comes first.
            if (_isInitialized)
                return;

            // Same fallback as VoiceServerConnection; at 0 frames would hold no samples.
            int configuredSamplingRate = ColibriConfig.Load().VoiceServerSamplingRate;
            _serverSamplingRate = configuredSamplingRate > 0 ? configuredSamplingRate : 48000;
            // Get all available recording devices and select recording device
            string[] recordingDevices = Microphone.devices;
            if (recordingDevices.Length == 0)
            {
                Debug.LogError(_debugHeader + "Voice Broadcast initialization failed: No recording device found");
                return;
            }
            _microphoneDevice = ChooseMicrophone(recordingDevices);
            LogRecordingDevices(recordingDevices);

            // Get supported sampling rates of the selected recording device
            int minSupportedSamplingRate;
            int maxSupportedSamplingRate;
            Microphone.GetDeviceCaps(_microphoneDevice, out minSupportedSamplingRate, out maxSupportedSamplingRate);
            if (Debugging) Debug.Log(_debugHeader + "Sampling rates supported: " + minSupportedSamplingRate + " - " + maxSupportedSamplingRate);

            // Decide on sampling rate
            _microphoneSamplingRate = VoiceFramer.RecordingRate(minSupportedSamplingRate, maxSupportedSamplingRate, _serverSamplingRate);
            if (Debugging) Debug.Log(_debugHeader + "Use sampling rate: " + _microphoneSamplingRate);

            // Calculate package size based on requested frame size (milliseconds)
            ApplyFrameSize();

            // Init server connection
            _voiceServerConnection = VoiceServerConnection.Instance;

            // Init opus
            _opusEncoder = UseOpusCodec ? CreateOpusEncoder() : null;

            _isInitialized = true;
            Debug.Log(_debugHeader + "Ready for Voice Broadcast");

            if (_startAfterInitialized)
            {
                StartBroadcast(_startId);
            }
        }

        public void StartBroadcast(short id)
        {
            if (_isInitialized)
            {
                _localUserId = id;

                // Start recording using selected recording device
                Debug.Log(_debugHeader + "Start voice broadcasting");
                _recordingAudioClip = Microphone.Start(_microphoneDevice, true, MicrophoneBufferLengthSeconds, _microphoneSamplingRate);
                if (Debugging) Debug.Log(_debugHeader + "Channel count: " + _recordingAudioClip.channels);
                _lastRecordingSamplePosition = Microphone.GetPosition(_microphoneDevice);

                // New per broadcast, so no samples left over from the last one go out.
                _framer = new VoiceFramer(_microphoneSamplingRate, _serverSamplingRate, _frameSize,
                    _opusEncoder != null ? EncodeOpus : (VoiceFrameEncoder)null, SendFrame, ReportEncodeFailure);
                _broadcast = true;
            }
            else
            {
                _startId = id;
                _startAfterInitialized = true;
            }
        }

        public void StopBroadcast()
        {
            if (_broadcast)
            {
                _broadcast = false;
                Microphone.End(_microphoneDevice);
            }
        }

        // Null, after logging why, when Opus cannot encode this configuration or does not run here.
        // Voice then goes out as PCM.
        private OpusEncoder CreateOpusEncoder()
        {
            if (!VoiceFramer.IsOpusFrame(_serverSamplingRate, _frameSize))
            {
                Debug.LogWarning(_debugHeader + "Use Opus Codec is on, but Opus encodes only 8, 12, 16, 24 or 48 kHz in frames of 2.5, 5, 10, 20, 40 or 60 ms, not frames of " + _frameSize + " samples at " + _serverSamplingRate + " Hz. Sending voice as PCM.");
                return null;
            }

            if (!OpusEncoder.TryCreate(_serverSamplingRate, 1, OpusApplication.VOIP, out OpusEncoder encoder, out string error))
            {
                Debug.LogWarning(_debugHeader + "Use Opus Codec is on, but " + error + ". Sending voice as PCM.");
                return null;
            }

            return encoder;
        }

        private void SendRecordedSamples()
        {
            int differenceSinceLastAdd = 0;

            // Get sample count since last adding
            int currentSamplePosition = Microphone.GetPosition(_microphoneDevice);
            if (currentSamplePosition > _lastRecordingSamplePosition)
            {
                differenceSinceLastAdd = currentSamplePosition - _lastRecordingSamplePosition;
            }
            else if (currentSamplePosition < _lastRecordingSamplePosition)
            {
                differenceSinceLastAdd = _recordingAudioClip.samples - _lastRecordingSamplePosition + currentSamplePosition;
            }
            else
            {
                return;
            }

            // Get samples since last adding
            float[] data = new float[differenceSinceLastAdd];
            _recordingAudioClip.GetData(data, _lastRecordingSamplePosition);
            _lastRecordingSamplePosition = currentSamplePosition;

            // Sends each frame the samples fill; the remainder waits for the next call.
            _framer.Add(data);
        }

        private byte[] EncodeOpus(byte[] pcm, int frameSamples, out string error)
        {
            byte[] encoded = _opusEncoder.TryEncode(pcm, frameSamples, out OpusError opusError);
            error = encoded == null ? opusError.ToString() : null;
            return encoded;
        }

        private void SendFrame(short frameSamples, Codec codec, byte[] data)
        {
            _voiceServerConnection.SendByteData(_localUserId, 0, frameSamples, codec, data);
        }

        private void ReportEncodeFailure(string error)
        {
            Debug.LogWarning(_debugHeader + "Opus could not encode a frame (" + error + "). Frames it fails on go out as PCM. Reported once per broadcast.");
        }
    }
}
