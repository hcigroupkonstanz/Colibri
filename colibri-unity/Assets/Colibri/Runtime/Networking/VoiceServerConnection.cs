using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using HCIKonstanz.Colibri.Communication.Codecs;
using HCIKonstanz.Colibri.Core;
using HCIKonstanz.Colibri.Networking.Protocol;
using HCIKonstanz.Colibri.Setup;
using UnityEngine;

namespace HCIKonstanz.Colibri.Networking
{
    public class VoiceServerConnection : SingletonBehaviour<VoiceServerConnection>
    {
        private UdpClient _udpClient;
        private IPEndPoint _sendIPEndPoint;
        private Thread _udpThread;
        private CancellationTokenSource _shutdown;

        // The app id every packet goes out with, and the one a received packet has to carry: the
        // server keeps the voice of different apps apart by it. Written on the main thread, read
        // by the receive thread too.
        private volatile uint _appId = VoicePacketCodec.AppId(string.Empty);

        // Main thread only: the App Name _appId was computed from.
        private string _appIdName = string.Empty;

        // Main thread only: whether _appIdName is an App Name at all, as ColibriConfig.IsConfigured
        // has it, and whether sending without one has been reported since there last was one.
        private bool _hasAppName;
        private bool _hasReportedMissingAppName;

        // Main thread only: whether a failed send has been reported since a send last worked.
        private bool _hasReportedSendFailure;

        // Per instance rather than static, so a new connection never delivers an old one's packets.
        internal VoicePacketQueue ReceivedPackets { get; } = new VoicePacketQueue();

        // Main thread only: the packets being delivered, taken out of the queues in one go.
        private readonly List<VoicePacket> _deliveringPackets = new List<VoicePacket>();

        private readonly Dictionary<int, List<Action<VoicePacket>>> _voicePacketListeners = new Dictionary<int, List<Action<VoicePacket>>>();
        private bool _isConnected = false;


        private void OnEnable()
        {
            DontDestroyOnLoad(this);
            if (!String.IsNullOrEmpty(ColibriConfig.Load().Host))
                Connect();
        }

        private void OnDisable()
        {
            _isConnected = false;
            _connecting?.Cancel();

            // Thread.Abort is unsupported on .NET Core / IL2CPP and would leave the socket in
            // an undefined state anyway. Cancelling and closing the client is what actually
            // unblocks the blocking Receive() the thread is parked in.
            _shutdown?.Cancel();

            _udpClient?.Close();
            _udpClient = null;

            // Every field here is null if Connect() bailed out (or was never reached), which
            // used to make OnDisable throw on _udpThread.Abort().
            _udpThread?.Join(500);
            _udpThread = null;

            _shutdown?.Dispose();
            _shutdown = null;
        }

        private void Update()
        {
            // Every frame, so a packet goes out with the App Name configured now.
            UseAppName(ColibriConfig.Load().App);

            if (_isConnected)
                DeliverReceivedPackets();
        }

        /// <summary>
        /// Sends and receives voice as part of the app named <paramref name="appName"/> from now on.
        /// </summary>
        /// <remarks>Main thread only. Internal so the EditMode tests can set the app.</remarks>
        internal void UseAppName(string appName)
        {
            appName = appName ?? string.Empty;
            if (appName == _appIdName)
                return;

            _appIdName = appName;
            // Of the app the TCP handshake sends, which is not the App Name when that contains
            // '::' or starts or ends with ':'. The server compares the hash of the app its Unity
            // client sent with the packet's app id, and dropped all voice of such an App Name.
            _appId = VoicePacketCodec.AppId(PayloadCodec.HandshakeAppName(appName));
            _hasAppName = !string.IsNullOrWhiteSpace(appName);
            if (_hasAppName)
                _hasReportedMissingAppName = false;
        }

        /// <summary>
        /// Hands a received datagram to <see cref="VoicePacketQueue.EnqueueReceived"/> if it is a voice packet of
        /// this client's app. The server relays nothing else, so this drops only what reaches the
        /// socket some other way: a datagram too short for the header, one with another header
        /// version, such as a packet from a Colibri 1.x client, and a packet of another app.
        /// </summary>
        /// <remarks>Called from the receive thread; internal for the EditMode tests.</remarks>
        internal void HandleReceived(byte[] bytes)
        {
            if (VoicePacketCodec.TryDecode(bytes, out var packetAppId, out var packet) && packetAppId == _appId && packet.Id != 0)
                ReceivedPackets.EnqueueReceived(packet);
        }

        /// <remarks>Internal so the EditMode tests can drive it without a player loop.</remarks>
        internal void DeliverReceivedPackets()
        {
            ReceivedPackets.TakeAll(_deliveringPackets);

            // Outside the lock, so a listener never holds up the receive thread.
            try
            {
                foreach (var packet in _deliveringPackets)
                    Invoke(packet);
            }
            finally
            {
                _deliveringPackets.Clear();
            }
        }

        // Cancelled in OnDisable: the lookup of the server address, while it is retried.
        private CancellationTokenSource _connecting;

        // The longest wait between two lookups of the server address.
        private const int MAX_LOOKUP_RETRY_MS = 30_000;

        /// <summary>
        /// Looks the server address up off the main thread, and again with growing waits until it
        /// resolves: a lookup that failed once, on a headset still joining Wi-Fi say, used to turn
        /// voice off for the run, and it blocked the main thread while it lasted.
        /// </summary>
        private async void Connect()
        {
            _connecting?.Cancel();
            var source = new CancellationTokenSource();
            _connecting = source;
            try
            {
                await ConnectWhenResolved(source.Token);
            }
            finally
            {
                if (_connecting == source)
                    _connecting = null;
                source.Dispose();
            }
        }

        private async System.Threading.Tasks.Task ConnectWhenResolved(CancellationToken token)
        {
            var delayMs = 1000;
            var reported = false;

            while (true)
            {
                // Read again for each try: an address fixed in the configuration meanwhile is used.
                var config = ColibriConfig.Load();
                var host = config.Host;
                var port = config.VoiceServerPort;
                IPAddress address;
                string failure;
                try
                {
                    var candidates = await AddressResolver.ResolveAsync(host, 10_000, token);
                    address = VoiceServerAddress.ResolveServerAddress(host, port, candidates, out failure);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
                catch (Exception e) when (e is SocketException || e is TimeoutException || e is ArgumentException)
                {
                    address = null;
                    failure = $"could not resolve the server address '{host}' ({e.Message})";
                }

                // Disabled meanwhile, or another Connect is running.
                if (token.IsCancellationRequested || !this)
                    return;

                if (StartOrReport(address, config, host, failure, ref reported))
                    return;

                if (!await WaitBeforeRetry(delayMs, token))
                    return;
                delayMs = Math.Min(delayMs * 2, MAX_LOOKUP_RETRY_MS);
            }
        }

        private bool StartOrReport(IPAddress address, ColibriConfig config, string host, string failure, ref bool reported)
        {
            if (address != null)
            {
                if (reported)
                    Debug.Log($"Colibri voice: the server address '{host}' resolves now. Voice chat is on.");
                StartWith(address, config);
                return true;
            }

            if (!reported)
            {
                reported = true;
                Debug.LogError($"Colibri voice: {failure}. Voice chat is off until it works; trying again. "
                    + "Check the address in Window -> Colibri Configuration.");
            }
            return false;
        }

        private async System.Threading.Tasks.Task<bool> WaitBeforeRetry(int delayMs, CancellationToken token)
        {
            try
            {
                await System.Threading.Tasks.Task.Delay(delayMs, token);
            }
            catch (OperationCanceledException)
            {
                return false;
            }
            if (!this)
                return false;
            return true;
        }

        private void StartWith(IPAddress address, ColibriConfig config)
        {
            var host = config.Host;
            _udpClient = VoiceServerAddress.OpenSocket(address);

            if (_udpClient != null)
            {
                _sendIPEndPoint = new IPEndPoint(address, config.VoiceServerPort);
                ReceivedPackets.SamplingRate = config.VoiceServerSamplingRate > 0 ? config.VoiceServerSamplingRate : VoicePacketQueue.DEFAULT_SAMPLING_RATE;
                UseAppName(config.App);

                // colibri-server listens for voice on IPv6 by default (VOICE_HOST ::), but not with
                // VOICE_HOST 0.0.0.0 or behind a proxy on IPv4 only, and then nothing comes back.
                // Said so that a silent voice chat over IPv6 has an explanation in the log.
                if (address.AddressFamily == AddressFamily.InterNetworkV6)
                {
                    Debug.Log($"Colibri voice: '{host}' has no IPv4 address, sending voice over IPv6 to [{address}]:{config.VoiceServerPort}. "
                        + "The server has to listen for voice on IPv6: VOICE_HOST=:: (the default), and a proxy in front of it on IPv6 as well.");
                }

                _shutdown = new CancellationTokenSource();

                // Handed over here rather than read by the thread when it starts. A thread that
                // has not run by the time OnDisable's 500 ms Join gives up on it finds both fields
                // already cleared, and used to die of a NullReferenceException reading them.
                var client = _udpClient;
                var token = _shutdown.Token;
                _udpThread = new Thread(() => Receive(client, token))
                {
                    Name = "Voice UDP Thread",
                    IsBackground = true
                };
                _udpThread.Start();

                _isConnected = true;
            }
        }

        /// <summary>The receive thread: hands each datagram to <see cref="HandleReceived"/> until <paramref name="token"/> is cancelled or the client closed.</summary>
        /// <remarks>Internal for the EditMode tests, which run it on a socket of their own.</remarks>
        internal void Receive(UdpClient client, CancellationToken token)
        {
            // Per thread: an old receive thread may still be winding down while a new one starts.
            // Of the socket's family: the sender's address is read into it, and an endpoint of the
            // other family is not accepted for that on every runtime.
            var from = new IPEndPoint(VoiceServerAddress.AnyAddress(client.Client.AddressFamily), 0);

            while (!token.IsCancellationRequested)
            {
                try
                {
                    byte[] bytes = client.Receive(ref from);
                    HandleReceived(bytes);
                }
                catch (ObjectDisposedException)
                {
                    // Client closed by OnDisable - this is the shutdown path.
                    return;
                }
                catch (SocketException e)
                {
                    if (token.IsCancellationRequested)
                        return;

                    // Transient on UDP (an ICMP port-unreachable from a peer surfaces here as
                    // ECONNRESET); keep receiving.
                    Debug.LogWarning($"Colibri voice: {e.SocketErrorCode}");
                }
                catch (Exception e)
                {
                    Debug.Log(e.ToString());
                }
            }
        }

        public void SendByteData(short id, short sequence, short frameSize, Codec codec, byte[] data)
        {
            var client = _udpClient;
            if (client == null || !TryEncodeToSend(id, sequence, frameSize, codec, data, out var bytes))
                return;

            SendPacket(client, _sendIPEndPoint, bytes);
        }

        /// <summary>
        /// Sends one voice packet. A send the device refuses, such as one without a route to the
        /// server after moving to another network, drops the packet with a warning, said once
        /// until a send works again.
        /// </summary>
        /// <remarks>
        /// Main thread only; internal for the EditMode tests. Thrown, the error left
        /// VoiceBroadcast.SendSamples before the frame was taken off the recording buffer, so the
        /// same frame failed on every Update and the buffer grew by the microphone's rate.
        /// </remarks>
        internal void SendPacket(UdpClient client, IPEndPoint to, byte[] packet)
        {
            try
            {
                client.Send(packet, packet.Length, to);
                _hasReportedSendFailure = false;
            }
            catch (SocketException e)
            {
                if (!_hasReportedSendFailure)
                {
                    _hasReportedSendFailure = true;
                    Debug.LogWarning($"Colibri voice: sending to {to} failed ({e.SocketErrorCode}), dropping voice until a send works again");
                }
            }
        }

        /// <summary>
        /// The voice packet to send, with this client's app id, or false without an App Name: the
        /// TCP connection does not connect without one, and voice sent with the empty name's app id
        /// would reach every other client on the server that has none. Says so once, until there is
        /// an App Name again.
        /// </summary>
        /// <remarks>Main thread only; internal for the EditMode tests.</remarks>
        internal bool TryEncodeToSend(short id, short sequence, short frameSize, Codec codec, byte[] data, out byte[] packet)
        {
            if (!_hasAppName)
            {
                packet = null;
                if (!_hasReportedMissingAppName)
                {
                    _hasReportedMissingAppName = true;
                    Debug.LogError($"Colibri voice: no voice is sent without an App Name. {ColibriConfig.NOT_CONFIGURED_MESSAGE}");
                }
                return false;
            }

            packet = VoicePacketCodec.Encode(_appId, id, sequence, frameSize, codec, data);
            return true;
        }

        public void AddVoicePacketListener(short id, Action<VoicePacket> listener)
        {
            if (!_voicePacketListeners.ContainsKey(id))
                _voicePacketListeners.Add(id, new List<Action<VoicePacket>>());
            _voicePacketListeners[id].Add(listener);
        }

        public void RemoveVoicePacketListener(short id, Action<VoicePacket> listener)
        {
            if (_voicePacketListeners.ContainsKey(id))
        {
            var list = _voicePacketListeners[id];
            list.Remove(listener);
            if (list.Count == 0)
                _voicePacketListeners.Remove(id);
        }
        }

        private void Invoke(VoicePacket voicePacket)
        {
            if (_voicePacketListeners.ContainsKey(voicePacket.Id))
            {
                foreach (var voicePacketListener in _voicePacketListeners[voicePacket.Id].ToArray())
                {
                    try
                    {
                        voicePacketListener.Invoke(voicePacket);
                    }
                    catch (Exception e)
                    {
                        // Thrown out of DeliverReceivedPackets, it dropped every packet still to
                        // be delivered in this frame, other senders' included.
                        Debug.LogError($"Colibri voice: a listener for voice id {voicePacket.Id} threw an exception. "
                            + $"The other listeners and packets were still delivered.\n{e}");
                    }
                }
            }
        }
    }
}
