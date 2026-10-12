using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Networking.Protocol;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// The queue between the voice receive thread and the main thread. There can be two receive
    /// threads at once: OnDisable only waits 500 ms for the old one, so after a quick disable and
    /// enable both may be handing packets over while the main thread takes them off.
    /// </summary>
    public class VoicePacketQueueTests
    {
        private GameObject _gameObject;
        private VoiceServerConnection _voice;

        // Edit mode: OnEnable never runs, so there is no socket and no receive thread of its own.
        // The tests are the receive threads.
        [SetUp]
        public void CreateComponent()
        {
            _gameObject = new GameObject("voice-under-test");
            _voice = _gameObject.AddComponent<VoiceServerConnection>();
        }

        [TearDown]
        public void DestroyComponent()
        {
            if (_gameObject != null)
                Object.DestroyImmediate(_gameObject);
        }

        /// <summary>
        /// The queue used to be a LockFreeQueue, whose node pool is only safe with one producer:
        /// with two, a node can be handed out twice, and packets are lost or delivered twice. That
        /// takes a thread being preempted at one exact instruction, so it cannot be forced on
        /// demand - this did not catch the old queue either. It pins down instead that several
        /// producers, with the main thread taking packets off at the same time, lose and repeat
        /// nothing.
        /// </summary>
        [Test]
        public void PacketsFromSeveralReceiveThreadsAtOnceAreEachDeliveredExactlyOnce()
        {
            const int threads = 4;
            const int packetsPerThread = 30000;

            // This is about handing packets over, not about how much audio is kept: a main thread
            // that falls behind the producers here must not make the bound drop any.
            _voice.MaxQueuedSeconds = 3600f;

            var delivered = new int[threads + 1, packetsPerThread];
            for (short id = 1; id <= threads; id++)
                _voice.AddVoicePacketListener(id, packet => delivered[packet.Id, packet.Sequence]++);

            var producers = Enumerable.Range(1, threads).Select(id => new Thread(() =>
            {
                for (var sequence = 0; sequence < packetsPerThread; sequence++)
                    _voice.EnqueueReceived(new VoicePacket { Id = (short)id, Sequence = (short)sequence, Codec = Codec.OPUS });
            })).ToArray();

            foreach (var producer in producers)
                producer.Start();

            // The main thread takes packets off while they are still being handed over.
            while (producers.Any(producer => producer.IsAlive))
                _voice.DeliverReceivedPackets();

            foreach (var producer in producers)
                Assert.That(producer.Join(10000), Is.True, "A receive thread never finished");
            _voice.DeliverReceivedPackets();

            var lost = 0;
            var repeated = 0;
            for (var id = 1; id <= threads; id++)
            {
                for (var sequence = 0; sequence < packetsPerThread; sequence++)
                {
                    if (delivered[id, sequence] == 0)
                        lost++;
                    else if (delivered[id, sequence] > 1)
                        repeated++;
                }
            }

            Assert.That((lost, repeated), Is.EqualTo((0, 0)), "Packets were lost or delivered more than once");
        }

        /// <summary>
        /// Packets keep coming while the main thread does not run - a Quest paused with the headset
        /// off, a long scene load. They used to queue without limit and were all played back, stale,
        /// when Update ran again. Each sender keeps its newest second of audio now, and a quiet
        /// sender loses nothing to a busy one.
        /// </summary>
        [Test]
        public void WhileNothingIsDeliveredEachSenderKeepsOnlyItsNewestSecondOfAudio()
        {
            var busy = new List<short>();
            var quiet = new List<short>();
            _voice.AddVoicePacketListener(1, packet => busy.Add(packet.Sequence));
            _voice.AddVoicePacketListener(2, packet => quiet.Add(packet.Sequence));

            // 20 ms frames at the voice server's 48 kHz: three seconds from one sender, a fifth of a
            // second from the other.
            for (short sequence = 0; sequence < 150; sequence++)
                _voice.EnqueueReceived(new VoicePacket { Id = 1, Sequence = sequence, FrameSize = 960, Codec = Codec.OPUS });
            for (short sequence = 0; sequence < 10; sequence++)
                _voice.EnqueueReceived(new VoicePacket { Id = 2, Sequence = sequence, FrameSize = 960, Codec = Codec.OPUS });

            _voice.DeliverReceivedPackets();

            Assert.That(busy, Is.EqualTo(Enumerable.Range(100, 50).Select(i => (short)i)),
                "Not exactly the newest second of the busy sender's audio was delivered");
            Assert.That(quiet, Is.EqualTo(Enumerable.Range(0, 10).Select(i => (short)i)),
                "The quiet sender lost audio");

            // Delivered is gone: the next second queues afresh.
            for (short sequence = 150; sequence < 160; sequence++)
                _voice.EnqueueReceived(new VoicePacket { Id = 1, Sequence = sequence, FrameSize = 960, Codec = Codec.OPUS });
            _voice.DeliverReceivedPackets();

            Assert.That(busy.Skip(50), Is.EqualTo(Enumerable.Range(150, 10).Select(i => (short)i)));
        }

        /// <summary>
        /// A packet that claims a frame size of zero counts as Opus's shortest frame, 2.5 ms, so a
        /// stream of those is bounded too: 400 to a second.
        /// </summary>
        [Test]
        public void PacketsThatClaimNoLengthAreBoundedToo()
        {
            var delivered = 0;
            _voice.AddVoicePacketListener(1, _ => delivered++);

            for (var sequence = 0; sequence < 2000; sequence++)
                _voice.EnqueueReceived(new VoicePacket { Id = 1, Sequence = (short)sequence, FrameSize = 0, Codec = Codec.OPUS });
            _voice.DeliverReceivedPackets();

            Assert.That(delivered, Is.EqualTo(400));
        }

        /// <summary>
        /// The queue belongs to its connection. It used to be static, so it outlived the component:
        /// with domain reload disabled, the next Play session's connection delivered the packets
        /// the previous one had received and not yet delivered.
        /// </summary>
        [Test]
        public void ANewConnectionNeverDeliversTheOldOnesPackets()
        {
            _voice.EnqueueReceived(new VoicePacket { Id = 1, Sequence = 7, Codec = Codec.OPUS });

            // The old connection goes away before its next Update; the next one takes over.
            Object.DestroyImmediate(_gameObject);
            _gameObject = new GameObject("next-voice-under-test");
            var next = _gameObject.AddComponent<VoiceServerConnection>();

            var delivered = new List<short>();
            next.AddVoicePacketListener(1, packet => delivered.Add(packet.Sequence));
            next.DeliverReceivedPackets();

            Assert.That(delivered, Is.Empty, "A new connection delivered a packet the previous one had received");
        }

        /// <summary>
        /// A listener that throws, such as a VoiceReceiver without an Opus decoder in the macOS
        /// Editor, used to throw out of the delivery, and every packet still to be delivered in
        /// that frame was dropped, other senders' included.
        /// </summary>
        [Test]
        public void AListenerThatThrowsDoesNotKeepTheOtherPacketsFromBeingDelivered()
        {
            var first = new List<short>();
            var second = new List<short>();
            var other = new List<short>();
            _voice.AddVoicePacketListener(1, packet => first.Add(packet.Sequence));
            _voice.AddVoicePacketListener(1, packet =>
            {
                if (packet.Sequence == 1)
                    throw new System.InvalidOperationException("listener bug");
                second.Add(packet.Sequence);
            });
            _voice.AddVoicePacketListener(2, packet => other.Add(packet.Sequence));

            for (short sequence = 0; sequence < 3; sequence++)
            {
                _voice.EnqueueReceived(new VoicePacket { Id = 1, Sequence = sequence, FrameSize = 960, Codec = Codec.PCM });
                _voice.EnqueueReceived(new VoicePacket { Id = 2, Sequence = sequence, FrameSize = 960, Codec = Codec.PCM });
            }

            // The first line only: Unity's Test Framework matches a multi-line message by its first
            // line, so the exception text after it never matched and the test failed in the Editor.
            LogAssert.Expect(LogType.Error, new Regex(@"^Colibri voice: a listener for voice id 1 threw an exception\. The other listeners and packets were still delivered\."));
            Assert.DoesNotThrow(() => _voice.DeliverReceivedPackets());

            Assert.That(first, Is.EqualTo(new short[] { 0, 1, 2 }));
            Assert.That(second, Is.EqualTo(new short[] { 0, 2 }));
            Assert.That(other, Is.EqualTo(new short[] { 0, 1, 2 }));
        }

        /// <summary>
        /// The server relays only the voice of this client's app. Whatever reaches the socket some
        /// other way is dropped before it is queued: a packet of another app with the same voice
        /// id, one from a Colibri 1.x client, one too short for the header. A short one used to
        /// throw on the receive thread and cost a log line each time.
        /// </summary>
        [Test]
        public void OnlyVoicePacketsOfThisClientsAppAreDelivered()
        {
            _voice.UseAppName("app-a");
            var delivered = new List<short>();
            _voice.AddVoicePacketListener(1, packet => delivered.Add(packet.Sequence));

            var appA = VoicePacketCodec.AppId("app-a");
            _voice.HandleReceived(VoicePacketCodec.Encode(appA, 1, 1, 960, Codec.OPUS, new byte[] { 0xF8 }));
            _voice.HandleReceived(VoicePacketCodec.Encode(VoicePacketCodec.AppId("app-b"), 1, 2, 960, Codec.OPUS, new byte[] { 0xF8 }));
            _voice.HandleReceived(new byte[] { 0x01, 0x00, 0x03, 0x00, 0xC0, 0x03, (byte)Codec.PCM, 0, 0 });
            _voice.HandleReceived(new byte[] { 0x01, 0x00, 0x04 });
            _voice.HandleReceived(VoicePacketCodec.Encode(appA, 0, 5, 960, Codec.OPUS, new byte[] { 0xF8 }));
            _voice.HandleReceived(VoicePacketCodec.Encode(appA, 1, 6, 960, Codec.OPUS, new byte[] { 0xF8 }));
            _voice.DeliverReceivedPackets();

            Assert.That(delivered, Is.EqualTo(new short[] { 1, 6 }));

            // Another App Name, and the other app's packets are the ones played.
            _voice.UseAppName("app-b");
            _voice.HandleReceived(VoicePacketCodec.Encode(appA, 1, 7, 960, Codec.OPUS, new byte[] { 0xF8 }));
            _voice.HandleReceived(VoicePacketCodec.Encode(VoicePacketCodec.AppId("app-b"), 1, 8, 960, Codec.OPUS, new byte[] { 0xF8 }));
            _voice.DeliverReceivedPackets();

            Assert.That(delivered, Is.EqualTo(new short[] { 1, 6, 8 }));
        }

        /// <summary>
        /// Without an App Name the TCP connection does not connect, and voice used to go out anyway,
        /// with the empty name's app id, to every other client on the server that has none. Nothing
        /// is sent now, and that is said once until there is an App Name again.
        /// </summary>
        [Test]
        public void NoVoiceIsSentWithoutAnAppName()
        {
            var noAppName = new Regex(@"^Colibri voice: no voice is sent without an App Name\. ");
            var data = new byte[] { 0xF8 };

            LogAssert.Expect(LogType.Error, noAppName);
            Assert.That(_voice.TryEncodeToSend(1, 0, 960, Codec.OPUS, data, out _), Is.False, "Voice was sent without an App Name");
            _voice.UseAppName("   ");
            Assert.That(_voice.TryEncodeToSend(1, 1, 960, Codec.OPUS, data, out _), Is.False, "Voice was sent with an App Name of spaces");
            LogAssert.NoUnexpectedReceived();

            _voice.UseAppName("app-a");
            Assert.That(_voice.TryEncodeToSend(1, 2, 960, Codec.OPUS, data, out var packet), Is.True, "No voice was sent with an App Name");
            Assert.That(packet, Is.EqualTo(VoicePacketCodec.Encode(VoicePacketCodec.AppId("app-a"), 1, 2, 960, Codec.OPUS, data)));

            _voice.UseAppName("");
            LogAssert.Expect(LogType.Error, noAppName);
            Assert.That(_voice.TryEncodeToSend(1, 3, 960, Codec.OPUS, data, out _), Is.False, "Voice was sent after the App Name was cleared");
            LogAssert.NoUnexpectedReceived();
        }

        /// <summary>
        /// The handshake replaces '::' and a ':' at either end of the App Name, and the server
        /// relays voice only from the address of a Unity client whose app, as the handshake sent
        /// it, hashes to the packet's app id. Voice used to hash the App Name as configured, so the
        /// server dropped all voice of such an App Name.
        /// </summary>
        [TestCase(":my::app:")]
        [TestCase("::app")]
        [TestCase("app:")]
        public void TheAppIdIsTheHashOfTheAppTheHandshakeSends(string appName)
        {
            _voice.UseAppName(appName);
            Assert.That(_voice.TryEncodeToSend(1, 0, 960, Codec.PCM, new byte[] { 0, 0 }, out var packet), Is.True);
            Assert.That(VoicePacketCodec.TryDecode(packet, out var appId, out _), Is.True);

            // The app field as the server reads it out of the handshake frame.
            var handshake = new FrameReader().Append(FrameCodec.EncodeHandshake("2", WebServerConnection.HandshakeAppName(appName), "device"));
            Assert.That(handshake.Count, Is.EqualTo(1));
            var handshakeApp = handshake[0].App;

            Assert.That(handshakeApp, Is.Not.EqualTo(appName), "The test needs an App Name the handshake changes");
            Assert.That(appId, Is.EqualTo(VoicePacketCodec.AppId(handshakeApp)));
        }
    }
}
