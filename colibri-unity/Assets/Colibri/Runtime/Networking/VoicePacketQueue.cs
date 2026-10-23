using System;
using System.Collections.Generic;

namespace HCIKonstanz.Colibri.Networking
{
    /// <summary>
    /// Holds the received voice packets per sender between the receive thread, which enqueues them, and the
    /// main thread, which takes them all each frame.
    /// </summary>
    internal sealed class VoicePacketQueue
    {
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

        internal const int DEFAULT_SAMPLING_RATE = 48000;

        // The voice server's, which a packet's FrameSize is counted in. Written by Connect, on the
        // main thread, before the receive thread starts.
        private volatile int _samplingRate = DEFAULT_SAMPLING_RATE;

        // Receive thread in, main thread out - and there can be two receive threads at once:
        // OnDisable waits only 500 ms for the old one, so after a quick disable and enable it may
        // still be handing over a packet while the new one starts. Everything in the queues is
        // under _queueLock.
        private readonly object _queueLock = new object();
        private readonly Dictionary<short, SenderQueue> _queuedVoicePackets = new Dictionary<short, SenderQueue>();

        private sealed class SenderQueue
        {
            public readonly Queue<VoicePacket> Packets = new Queue<VoicePacket>();

            // The audio in Packets, in samples at the voice server's sampling rate.
            public long Samples;
        }

        internal int SamplingRate
        {
            get => _samplingRate;
            set => _samplingRate = value;
        }

        /// <summary>
        /// Hands a received packet to the main thread, where <see cref="VoiceServerConnection.Update"/> delivers it,
        /// keeping no more than <see cref="MaxQueuedSeconds"/> of each sender's audio.
        /// </summary>
        /// <remarks>Called from the receive thread; internal so the EditMode tests can be several of them.</remarks>
        internal void EnqueueReceived(VoicePacket packet)
        {
            var rate = _samplingRate;
            var maxSamples = (long)(MaxQueuedSeconds * rate);
            var minSamples = rate / MIN_PACKET_DIVISOR;

            lock (_queueLock)
            {
                if (!_queuedVoicePackets.TryGetValue(packet.Id, out var queue))
                {
                    queue = new SenderQueue();
                    _queuedVoicePackets.Add(packet.Id, queue);
                }

                queue.Packets.Enqueue(packet);
                queue.Samples += Math.Max(packet.FrameSize, minSamples);

                // The newest is what is worth playing. The packet just queued always stays.
                while (queue.Samples > maxSamples && queue.Packets.Count > 1)
                    queue.Samples -= Math.Max(queue.Packets.Dequeue().FrameSize, minSamples);
            }
        }

        internal void TakeAll(List<VoicePacket> packets)
        {
            lock (_queueLock)
            {
                // A struct enumerator, and queues that keep their arrays: nothing allocated per frame.
                foreach (var queue in _queuedVoicePackets.Values)
                {
                    while (queue.Packets.Count > 0)
                        packets.Add(queue.Packets.Dequeue());
                    queue.Samples = 0;
                }
            }
        }
    }
}
