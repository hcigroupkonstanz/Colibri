using System;
using System.Collections;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using HCIKonstanz.Colibri.Core;
using HCIKonstanz.Colibri.Setup;
using UnityEngine;

namespace HCIKonstanz.Colibri.Networking
{
    public class VoiceServerConnection : SingletonBehaviour<VoiceServerConnection>
    {
        private UdpClient udpClient;
        private IPEndPoint sendIPEndPoint;
        private Thread udpThread;
        private CancellationTokenSource shutdown;

        /// <summary>
        /// The most audio, per sender, that waits for the main thread. Packets keep arriving while
        /// Update does not run - a Quest paused with the headset off, a long scene load - and used
        /// to queue without limit, to be played back all at once, long stale, when it ran again.
        /// Past this the oldest of that sender's packets are dropped. Settable for the tests.
        /// </summary>
        internal float MaxQueuedSeconds = 1f;

        /// <summary>
        /// The shortest audio a packet counts as, in parts of a second: 2.5 ms, Opus's shortest
        /// frame. Only a packet claiming a frame size of zero or less is that short, and this keeps
        /// a stream of those bounded too.
        /// </summary>
        private const int MIN_PACKET_DIVISOR = 400;

        private const int DEFAULT_SAMPLING_RATE = 48000;

        // The voice server's, which a packet's FrameSize is counted in. Written by Connect, on the
        // main thread, before the receive thread starts.
        private volatile int samplingRate = DEFAULT_SAMPLING_RATE;

        // The app id every packet goes out with, and the one a received packet has to carry: the
        // server keeps the voice of different apps apart by it. Written on the main thread, read
        // by the receive thread too.
        private volatile uint appId = VoicePacketCodec.AppId(string.Empty);

        // Main thread only: the App Name appId was computed from.
        private string appIdName = string.Empty;

        // Main thread only: whether appIdName is an App Name at all, as ColibriConfig.IsConfigured
        // has it, and whether sending without one has been reported since there last was one.
        private bool hasAppName;
        private bool hasReportedMissingAppName;

        // Main thread only: whether a failed send has been reported since a send last worked.
        private bool hasReportedSendFailure;

        // Receive thread in, main thread out - and there can be two receive threads at once:
        // OnDisable waits only 500 ms for the old one, so after a quick disable and enable it may
        // still be handing over a packet while the new one starts. Everything in the queues is
        // under queueLock. Per instance rather than static, so a new connection never delivers an
        // old one's packets.
        private readonly object queueLock = new object();
        private readonly Dictionary<short, SenderQueue> queuedVoicePackets = new Dictionary<short, SenderQueue>();

        // Main thread only: the packets being delivered, taken out of the queues in one go.
        private readonly List<VoicePacket> deliveringPackets = new List<VoicePacket>();

        private readonly Dictionary<int, List<Action<VoicePacket>>> voicePacketListeners = new Dictionary<int, List<Action<VoicePacket>>>();
        private bool isConnected = false;

        private sealed class SenderQueue
        {
            public readonly Queue<VoicePacket> Packets = new Queue<VoicePacket>();

            // The audio in Packets, in samples at the voice server's sampling rate.
            public long Samples;
        }


        private void OnEnable()
        {
            DontDestroyOnLoad(this);
            if (!String.IsNullOrEmpty(ColibriConfig.Load().ServerAddress))
                Connect();
        }

        private void OnDisable()
        {
            isConnected = false;

            // Thread.Abort is unsupported on .NET Core / IL2CPP and would leave the socket in
            // an undefined state anyway. Cancelling and closing the client is what actually
            // unblocks the blocking Receive() the thread is parked in.
            shutdown?.Cancel();

            udpClient?.Close();
            udpClient = null;

            // Every field here is null if Connect() bailed out (or was never reached), which
            // used to make OnDisable throw on udpThread.Abort().
            udpThread?.Join(500);
            udpThread = null;

            shutdown?.Dispose();
            shutdown = null;
        }

        private void Update()
        {
            // Every frame, so a packet goes out with the App Name configured now.
            UseAppName(ColibriConfig.Load().AppName);

            if (isConnected)
                DeliverReceivedPackets();
        }

        /// <summary>
        /// Sends and receives voice as part of the app named <paramref name="appName"/> from now on.
        /// </summary>
        /// <remarks>Main thread only. Internal so the EditMode tests can set the app.</remarks>
        internal void UseAppName(string appName)
        {
            appName = appName ?? string.Empty;
            if (appName == appIdName)
                return;

            appIdName = appName;
            // Of the app the TCP handshake sends, which is not the App Name when that contains
            // '::' or starts or ends with ':'. The server compares the hash of the app its Unity
            // client sent with the packet's app id, and dropped all voice of such an App Name.
            appId = VoicePacketCodec.AppId(WebServerConnection.HandshakeAppName(appName));
            hasAppName = !string.IsNullOrWhiteSpace(appName);
            if (hasAppName)
                hasReportedMissingAppName = false;
        }

        /// <summary>
        /// Hands a received datagram to <see cref="EnqueueReceived"/> if it is a voice packet of
        /// this client's app. The server relays nothing else, so this drops only what reaches the
        /// socket some other way: a datagram too short for the header, one with another header
        /// version, such as a packet from a Colibri 1.x client, and a packet of another app.
        /// </summary>
        /// <remarks>Called from the receive thread; internal for the EditMode tests.</remarks>
        internal void HandleReceived(byte[] bytes)
        {
            if (VoicePacketCodec.TryDecode(bytes, out var packetAppId, out var packet) && packetAppId == appId && packet.Id != 0)
                EnqueueReceived(packet);
        }

        /// <summary>
        /// Hands a received packet to the main thread, where <see cref="Update"/> delivers it,
        /// keeping no more than <see cref="MaxQueuedSeconds"/> of each sender's audio.
        /// </summary>
        /// <remarks>Called from the receive thread; internal so the EditMode tests can be several of them.</remarks>
        internal void EnqueueReceived(VoicePacket packet)
        {
            var rate = samplingRate;
            var maxSamples = (long)(MaxQueuedSeconds * rate);
            var minSamples = rate / MIN_PACKET_DIVISOR;

            lock (queueLock)
            {
                if (!queuedVoicePackets.TryGetValue(packet.Id, out var queue))
                {
                    queue = new SenderQueue();
                    queuedVoicePackets.Add(packet.Id, queue);
                }

                queue.Packets.Enqueue(packet);
                queue.Samples += Math.Max(packet.FrameSize, minSamples);

                // The newest is what is worth playing. The packet just queued always stays.
                while (queue.Samples > maxSamples && queue.Packets.Count > 1)
                    queue.Samples -= Math.Max(queue.Packets.Dequeue().FrameSize, minSamples);
            }
        }

        /// <remarks>Internal so the EditMode tests can drive it without a player loop.</remarks>
        internal void DeliverReceivedPackets()
        {
            lock (queueLock)
            {
                // A struct enumerator, and queues that keep their arrays: nothing allocated per frame.
                foreach (var queue in queuedVoicePackets.Values)
                {
                    while (queue.Packets.Count > 0)
                        deliveringPackets.Add(queue.Packets.Dequeue());
                    queue.Samples = 0;
                }
            }

            // Outside the lock, so a listener never holds up the receive thread.
            try
            {
                foreach (var packet in deliveringPackets)
                    Invoke(packet);
            }
            finally
            {
                deliveringPackets.Clear();
            }
        }

        private void Connect()
        {
            var config = ColibriConfig.Load();
            var host = config.ServerAddress;
            var address = ResolveServerAddress(host, config.VoiceServerPort);
            udpClient = address != null ? OpenSocket(address) : null;

            if (udpClient != null)
            {
                sendIPEndPoint = new IPEndPoint(address, config.VoiceServerPort);
                samplingRate = config.VoiceServerSamplingRate > 0 ? config.VoiceServerSamplingRate : DEFAULT_SAMPLING_RATE;
                UseAppName(config.AppName);

                // The server's voice socket is IPv4 unless VOICE_HOST is an IPv6 address, and
                // nothing comes back from a server that does not listen on IPv6. Said so that a
                // silent voice chat over IPv6 has an explanation in the log.
                if (address.AddressFamily == AddressFamily.InterNetworkV6)
                {
                    Debug.Log($"Colibri voice: '{host}' has no IPv4 address, sending voice over IPv6 to [{address}]:{config.VoiceServerPort}. "
                        + "The server has to listen for voice on IPv6: VOICE_HOST=:: or a proxy in front of it.");
                }

                shutdown = new CancellationTokenSource();

                // Handed over here rather than read by the thread when it starts. A thread that
                // has not run by the time OnDisable's 500 ms Join gives up on it finds both fields
                // already cleared, and used to die of a NullReferenceException reading them.
                var client = udpClient;
                var token = shutdown.Token;
                udpThread = new Thread(() => Receive(client, token))
                {
                    Name = "Voice UDP Thread",
                    IsBackground = true
                };
                udpThread.Start();

                isConnected = true;
            }
            else
            {
                enabled = false;
            }
        }

        /// <summary>
        /// The address to send voice to, or null, having said why, when there is none.
        /// </summary>
        /// <remarks>
        /// GetHostAddresses rather than GetHostEntry: for an IP address it hands the address
        /// straight back, where GetHostEntry first attempts a reverse lookup, which can fail for
        /// a LAN address with no DNS name and threw out of OnEnable. An IPv6 address in brackets
        /// is taken apart first, as for the TCP connection.
        /// </remarks>
        private static IPAddress ResolveServerAddress(string host, int port)
        {
            IPAddress[] candidates;
            if (WebServerConnection.TryParseAddress(host, out var literal))
            {
                candidates = new[] { literal };
            }
            else
            {
                try
                {
                    candidates = Dns.GetHostAddresses(host);
                }
                catch (Exception e) when (e is SocketException || e is ArgumentException)
                {
                    Debug.LogError($"Colibri voice: could not resolve the server address '{host}' ({e.Message}). Voice chat is off. Check the address in Window -> Colibri Configuration.");
                    return null;
                }
            }

            var address = SelectServerAddress(candidates, candidate => WebServerConnection.HasRoute(candidate, port));
            if (address == null)
            {
                var found = candidates.Length == 0 ? "no addresses at all" : string.Join<IPAddress>(", ", candidates);
                if (Array.Exists(candidates, IsSendableIPv6))
                    Debug.LogError($"Colibri voice: the server address '{host}' has only IPv6 addresses ({found}), and this device has no route to them, as on a network with IPv4 only. Voice chat is off.");
                else
                    Debug.LogError($"Colibri voice: the server address '{host}' resolved to {found}, none of which voice can be sent to. Voice chat is off. Check the address in Window -> Colibri Configuration.");
            }

            return address;
        }

        /// <summary>
        /// Picks the address voice goes to, out of everything a name resolved to: IPv4 when the
        /// name has an IPv4 address, otherwise IPv6 that <paramref name="hasRoute"/> says the
        /// device has a route to.
        /// </summary>
        /// <remarks>
        /// IPv4 first because the server's voice socket is IPv4 unless VOICE_HOST is an IPv6
        /// address (voice-server.ts). Taking the first address regardless broke on Windows, where
        /// "localhost" commonly resolves to ::1 before 127.0.0.1: every packet went to an IPv6
        /// address that nothing listened on, and no voice ever reached the server. An IPv4-mapped
        /// IPv6 address is as good as the IPv4 address inside it. IPv6 is for a name with no IPv4
        /// address at all, such as a server whose IPv4 address is behind carrier-grade NAT. A
        /// link-local IPv6 address without a scope (an interface) cannot be sent to, and is
        /// skipped. So is an IPv6 address without a route: on Wi-Fi with IPv4 only, which gives
        /// a device a link-local IPv6 address and nothing more, every send to it failed at once.
        /// IPv4 is taken without asking, as before IPv6 was an option: a device still joining
        /// Wi-Fi has no route yet, and starts sending once it has one.
        /// </remarks>
        /// <param name="hasRoute">Whether the device has a route to an IPv6 address; see <see cref="WebServerConnection.HasRoute"/>.</param>
        /// <returns>An IPv4 or IPv6 address, or null when there is none voice can be sent to.</returns>
        internal static IPAddress SelectServerAddress(IPAddress[] candidates, Func<IPAddress, bool> hasRoute)
        {
            if (candidates == null)
                return null;

            foreach (var candidate in candidates)
            {
                if (candidate.AddressFamily == AddressFamily.InterNetwork)
                    return candidate;
            }

            foreach (var candidate in candidates)
            {
                if (candidate.AddressFamily == AddressFamily.InterNetworkV6 && candidate.IsIPv4MappedToIPv6)
                    return candidate.MapToIPv4();
            }

            foreach (var candidate in candidates)
            {
                if (IsSendableIPv6(candidate) && hasRoute(candidate))
                    return candidate;
            }

            return null;
        }

        private static bool IsSendableIPv6(IPAddress address)
            => address.AddressFamily == AddressFamily.InterNetworkV6 && !(address.IsIPv6LinkLocal && address.ScopeId == 0);

        /// <summary>
        /// The voice socket for <paramref name="address"/>: of its family, on a port of the
        /// operating system's choosing. Null, having said why, when the device cannot open one,
        /// such as an IPv6 socket on a device without IPv6.
        /// </summary>
        /// <remarks>Internal for the EditMode tests.</remarks>
        internal static UdpClient OpenSocket(IPAddress address)
        {
            var family = address.AddressFamily;
            UdpClient client = null;
            try
            {
                client = new UdpClient(family);
                // Port 0 lets the OS pick an ephemeral port. The server replies to whatever
                // source port the datagram came from (voice-server.ts), so the hardcoded 9014
                // this used to bind bought nothing and capped a machine at one Unity client.
                client.Client.Bind(new IPEndPoint(AnyAddress(family), 0));
                return client;
            }
            catch (Exception e)
            {
                client?.Close();
                var reason = e is SocketException socketError ? socketError.SocketErrorCode.ToString() : e.Message;
                Debug.LogError($"Colibri voice: could not open a socket to send voice to {address} ({reason}). Voice chat is off.");
                return null;
            }
        }

        private static IPAddress AnyAddress(AddressFamily family)
            => family == AddressFamily.InterNetworkV6 ? IPAddress.IPv6Any : IPAddress.Any;

        /// <summary>The receive thread: hands each datagram to <see cref="HandleReceived"/> until <paramref name="token"/> is cancelled or the client closed.</summary>
        /// <remarks>Internal for the EditMode tests, which run it on a socket of their own.</remarks>
        internal void Receive(UdpClient client, CancellationToken token)
        {
            // Per thread: an old receive thread may still be winding down while a new one starts.
            // Of the socket's family: the sender's address is read into it, and an endpoint of the
            // other family is not accepted for that on every runtime.
            var from = new IPEndPoint(AnyAddress(client.Client.AddressFamily), 0);

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
            var client = udpClient;
            if (client == null || !TryEncodeToSend(id, sequence, frameSize, codec, data, out var bytes))
                return;

            SendPacket(client, sendIPEndPoint, bytes);
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
                hasReportedSendFailure = false;
            }
            catch (SocketException e)
            {
                if (!hasReportedSendFailure)
                {
                    hasReportedSendFailure = true;
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
            if (!hasAppName)
            {
                packet = null;
                if (!hasReportedMissingAppName)
                {
                    hasReportedMissingAppName = true;
                    Debug.LogError($"Colibri voice: no voice is sent without an App Name. {ColibriConfig.NOT_CONFIGURED_MESSAGE}");
                }
                return false;
            }

            packet = VoicePacketCodec.Encode(appId, id, sequence, frameSize, codec, data);
            return true;
        }

        public void AddVoicePacketListener(short id, Action<VoicePacket> listener)
        {
            if (!voicePacketListeners.ContainsKey(id))
                voicePacketListeners.Add(id, new List<Action<VoicePacket>>());
            voicePacketListeners[id].Add(listener);
        }

        public void RemoveVoicePacketListener(short id, Action<VoicePacket> listener)
        {
            if (voicePacketListeners.ContainsKey(id))
        {
            var list = voicePacketListeners[id];
            list.Remove(listener);
            if (list.Count == 0)
                voicePacketListeners.Remove(id);
        }
        }

        private void Invoke(VoicePacket voicePacket)
        {
            if (voicePacketListeners.ContainsKey(voicePacket.Id))
            {
                foreach (var voicePacketListener in voicePacketListeners[voicePacket.Id].ToArray())
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
