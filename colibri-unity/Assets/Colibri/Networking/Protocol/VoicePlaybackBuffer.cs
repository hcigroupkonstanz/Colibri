using System;
using System.Threading;

namespace HCIKonstanz.Colibri.Networking.Protocol
{
    /// <summary>
    /// The voice a VoiceReceiver has received and not played yet: mono samples at the output
    /// rate, written on the main thread and read on the audio thread, in OnAudioFilterRead.
    ///
    /// A ring for one writer and one reader, without a lock. VoiceReceiver used a List that both
    /// threads changed unguarded, which now and then threw ArgumentOutOfRangeException, and the
    /// audio thread allocated two arrays per callback. A lock would be held only briefly, but the
    /// audio thread would still wait whenever the main thread held it, and a main thread that is
    /// preempted while holding it, as on a busy Quest, makes the audio thread miss its deadline,
    /// which is audible. Here neither thread ever waits for the other, and reading allocates
    /// nothing.
    ///
    /// Each thread owns one counter and only reads the other's: the writer counts the samples
    /// written, the reader the samples read. Both only grow, wrap around at 2^32 and index the
    /// ring by their low bits, so its length is a power of two. A volatile write publishes a
    /// counter only after the samples it covers have been written or read.
    ///
    /// A clear is a mark at the written count, which the reader skips to once, the first time it
    /// sees that mark, unless it has read past it already.
    ///
    /// What does not fit is dropped, the newest samples: the oldest are the reader's to drop.
    /// Fast-forward, on the reader's side, drops the oldest long before the ring is full.
    ///
    /// Free of any <c>UnityEngine</c> dependency, so plain NUnit EditMode tests exercise it.
    /// </summary>
    internal sealed class VoicePlaybackBuffer
    {
        private const int MinCapacity = 1024;
        private const int MaxCapacity = 1 << 30;

        private readonly float[] ring;
        private readonly int mask;

        // Written by the writer only.
        private int written;
        private int clearedTo;

        // Written by the reader only.
        private int read;
        private int appliedClear;
        private long fastForwarded;

        /// <param name="capacity">The samples it holds at least; rounded up to a power of two.</param>
        /// <param name="startCount">
        /// Where both counters start. For the tests, which start them just short of wrapping around.
        /// </param>
        internal VoicePlaybackBuffer(int capacity, int startCount = 0)
        {
            var length = MinCapacity;
            while (length < capacity && length < MaxCapacity)
                length <<= 1;
            ring = new float[length];
            mask = length - 1;
            written = clearedTo = read = appliedClear = startCount;
        }

        internal int Capacity => ring.Length;

        /// <summary>The samples waiting to be read. Any thread, and only a snapshot.</summary>
        internal int Count
        {
            get
            {
                // In this order: the reader publishes a clear as applied after the read count it
                // moved, so a clear seen applied comes with that count.
                var applied = Volatile.Read(ref appliedClear);
                var from = Volatile.Read(ref read);
                var cleared = Volatile.Read(ref clearedTo);
                var to = Volatile.Read(ref written);
                if (cleared != applied && unchecked(cleared - from) > 0)
                    from = cleared;
                return unchecked(to - from);
            }
        }

        /// <summary>The samples fast-forward has dropped so far. Any thread.</summary>
        internal long FastForwarded => Interlocked.Read(ref fastForwarded);

        /// <summary>
        /// Writer only: appends the first <paramref name="count"/> of <paramref name="samples"/>, as
        /// many as fit, and returns how many that is. The rest is dropped.
        /// </summary>
        internal int Write(float[] samples, int count)
        {
            if (samples == null)
                throw new ArgumentNullException(nameof(samples));

            var writeCount = written;
            var free = ring.Length - unchecked(writeCount - Volatile.Read(ref read));
            var n = Math.Min(Math.Max(0, Math.Min(count, samples.Length)), free);

            var start = writeCount & mask;
            var first = Math.Min(n, ring.Length - start);
            Array.Copy(samples, 0, ring, start, first);
            Array.Copy(samples, first, ring, 0, n - first);

            Volatile.Write(ref written, unchecked(writeCount + n));
            return n;
        }

        /// <summary>
        /// Writer only: drops everything written so far. The reader skips it at its next read, and
        /// until then it still takes up room.
        /// </summary>
        internal void Clear() => Volatile.Write(ref clearedTo, written);

        /// <summary>
        /// Reader only: fills <paramref name="data"/>, <paramref name="channels"/> interleaved
        /// channels, with the next samples, each on every channel, and what is left with silence.
        /// Returns the samples read.
        /// </summary>
        /// <param name="fastForwardAbove">
        /// With more samples than this waiting, the oldest are dropped first, so that
        /// <paramref name="keep"/> are left.
        /// </param>
        /// <param name="keep">
        /// The samples fast-forward keeps, as many as there are at most. VoiceReceiver kept the
        /// last frame's worth and removed the rest, and with a frame longer than what was waiting,
        /// such as one of 120 ms against a 100 ms latency, that was a negative count, which threw.
        /// </param>
        internal int Read(float[] data, int channels, int fastForwardAbove = int.MaxValue, int keep = 0)
        {
            var readCount = read;
            // Before the written count, which then covers all the clear drops.
            var cleared = Volatile.Read(ref clearedTo);
            var writeCount = Volatile.Read(ref written);
            // Only a clear not applied yet: the mark stays put while the counters move on, and
            // 2^31 samples on, 12.4 hours at 48 kHz, it looked ahead of the reader again. Nor one
            // the reader has passed, having read what was written after it before it saw it.
            if (cleared != appliedClear && unchecked(cleared - readCount) > 0)
                readCount = cleared;

            var available = unchecked(writeCount - readCount);
            if (available > fastForwardAbove)
            {
                var skip = available - Math.Min(Math.Max(0, keep), available);
                if (skip > 0)
                {
                    readCount = unchecked(readCount + skip);
                    available -= skip;
                    Interlocked.Add(ref fastForwarded, skip);
                }
            }

            channels = Math.Max(1, channels);
            var samples = Math.Min(data.Length / channels, available);
            var index = 0;
            for (var i = 0; i < samples; i++)
            {
                var sample = ring[unchecked(readCount + i) & mask];
                for (var channel = 0; channel < channels; channel++)
                    data[index++] = sample;
            }
            Array.Clear(data, index, data.Length - index);

            Volatile.Write(ref read, unchecked(readCount + samples));
            // After the read count, for Count.
            Volatile.Write(ref appliedClear, cleared);
            return samples;
        }
    }
}
