using System;
using System.Threading;

namespace HCIKonstanz.Colibri.Networking.Protocol
{
    /// <summary>
    /// The voice a VoiceReceiver has received and not played yet: mono samples at the output
    /// rate, written on the main thread and read on the audio thread (OnAudioFilterRead).
    /// </summary>
    // Lock-free ring for one writer and one reader. With a lock, a main thread preempted while
    // holding it (busy Quest) makes the audio thread miss its deadline, which is audible.
    // For the same reason Read must not allocate.
    // Each thread owns one counter (samples written, samples read) and only reads the other's.
    // The counters wrap at 2^32 and index the ring by their low bits, so its length is a power of
    // two. A volatile write publishes a counter only after the samples it covers are written or read.
    // Clear is a mark at the written count; the reader skips to it once, unless it is already past it.
    // A full ring drops the newest samples; dropping the oldest is the reader's job (fast-forward).
    // No UnityEngine dependency, so plain NUnit EditMode tests can run it.
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
        /// <param name="startCount">Initial counter value; tests start just short of wrapping around.</param>
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
                // appliedClear before read: the reader publishes appliedClear after read, so an
                // applied clear comes with that read count.
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
        /// Writer only: appends up to <paramref name="count"/> of <paramref name="samples"/> and
        /// returns how many fit. The rest is dropped.
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
        /// Writer only: drops everything written so far. The reader skips it at its next read;
        /// until then it still takes up room.
        /// </summary>
        internal void Clear() => Volatile.Write(ref clearedTo, written);

        /// <summary>
        /// Reader only: fills <paramref name="data"/> (<paramref name="channels"/> interleaved
        /// channels) with the next samples, each copied to every channel, and the rest with
        /// silence. Returns the samples read.
        /// </summary>
        /// <param name="fastForwardAbove">
        /// With more samples than this waiting, the oldest are dropped until
        /// <paramref name="keep"/> are left.
        /// </param>
        /// <param name="keep">The samples fast-forward leaves; clamped to what is waiting.</param>
        internal int Read(float[] data, int channels, int fastForwardAbove = int.MaxValue, int keep = 0)
        {
            var readCount = read;
            // Before written, so the mark is never ahead of the written count.
            var cleared = Volatile.Read(ref clearedTo);
            var writeCount = Volatile.Read(ref written);
            // Only an unapplied mark: an applied one stays put and would look ahead of the reader
            // again after 2^31 samples (12.4 h at 48 kHz). Not one the reader is already past: it
            // can read samples written after the mark before it sees the mark.
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
