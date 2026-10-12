using System;
using System.Diagnostics;
using System.Linq;
using System.Threading;
using HCIKonstanz.Colibri.Networking.Protocol;
using NUnit.Framework;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// The buffer between VoiceReceiver's main thread, which writes the received voice, and its
    /// audio thread, which plays it. Both threads used to change one List unguarded, which now
    /// and then threw, and fast-forward threw on a frame longer than its latency.
    /// </summary>
    public class VoicePlaybackBufferTests
    {
        private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(60);

        /// <summary>Samples numbered from <paramref name="first"/>; from 1, so that 0 is silence. Exact as floats up to 2^24.</summary>
        private static float[] Numbered(int first, int count)
            => Enumerable.Range(first, count).Select(i => (float)i).ToArray();

        private static float[] ReadAll(VoicePlaybackBuffer buffer)
        {
            var data = new float[buffer.Capacity];
            var read = buffer.Read(data, 1);
            return data.Take(read).ToArray();
        }

        /// <summary>
        /// One thread writes frames of every length while another reads them in chunks of every
        /// length, round a small ring some 700 times. Every sample arrives once, in order, on both
        /// channels. The writer waits for room here, so nothing may be dropped.
        /// </summary>
        [Test]
        public void AWriterAndAReaderOnTwoThreadsLoseAndRepeatNothing()
        {
            const int total = 3_000_000;
            var buffer = new VoicePlaybackBuffer(4096);
            Assert.That(buffer.Capacity, Is.EqualTo(4096));

            Exception writerError = null;
            var writer = new Thread(() =>
            {
                try
                {
                    var frameLengths = new[] { 960, 441, 1, 2048, 7, 4096 };
                    var clock = Stopwatch.StartNew();
                    for (int next = 1, frame = 0; next <= total; frame++)
                    {
                        var length = Math.Min(frameLengths[frame % frameLengths.Length], total - next + 1);
                        var samples = Numbered(next, length);
                        var done = 0;
                        while (done < length)
                        {
                            var rest = new float[length - done];
                            Array.Copy(samples, done, rest, 0, rest.Length);
                            done += buffer.Write(rest, rest.Length);
                            if (done < length)
                            {
                                if (clock.Elapsed > Timeout)
                                    throw new TimeoutException("The reader stopped taking samples");
                                Thread.Yield();
                            }
                        }
                        next += length;
                    }
                }
                catch (Exception e)
                {
                    writerError = e;
                }
            });
            writer.Start();

            // Stereo, in chunks of 1024, 256, 1 and 513 samples.
            var chunks = new[] { new float[2048], new float[512], new float[2], new float[1026] };
            var expected = 1;
            var mismatch = (string)null;
            var readerClock = Stopwatch.StartNew();
            for (var chunk = 0; expected <= total && mismatch == null; chunk++)
            {
                var data = chunks[chunk % chunks.Length];
                var read = buffer.Read(data, 2);
                for (var i = 0; i < read && mismatch == null; i++, expected++)
                {
                    if (data[2 * i] != expected || data[2 * i + 1] != expected)
                        mismatch = $"Sample {expected} was read as {data[2 * i]} and {data[2 * i + 1]}";
                }
                for (var i = 2 * read; i < data.Length && mismatch == null; i++)
                {
                    if (data[i] != 0f)
                        mismatch = $"After {read} samples, position {i} is {data[i]} instead of silence";
                }

                if (read == 0)
                {
                    if (readerClock.Elapsed > Timeout || !writer.IsAlive && buffer.Count == 0 && expected <= total)
                        break;
                    Thread.Yield();
                }
            }

            Assert.That(writer.Join(Timeout), Is.True, "The writer never finished");
            Assert.That(writerError, Is.Null);
            Assert.That(mismatch, Is.Null);
            Assert.That(expected - 1, Is.EqualTo(total), "Not every sample was read");
            Assert.That(buffer.Count, Is.Zero);
            Assert.That(buffer.FastForwarded, Is.Zero);
        }

        /// <summary>
        /// A writer that does not wait for room, as VoiceReceiver does not, and a reader with
        /// fast-forward on. Samples are lost only as documented: those that did not fit, and those
        /// fast-forward dropped. What is read is in order, and nothing twice.
        /// </summary>
        [Test]
        public void UnderLoadOnlyWhatDidNotFitOrWasFastForwardedIsLost()
        {
            const int frames = 2000;
            const int frameLength = 960;
            var buffer = new VoicePlaybackBuffer(4096);
            var accepted = new int[frames];

            Exception writerError = null;
            var writer = new Thread(() =>
            {
                try
                {
                    for (var frame = 0; frame < frames; frame++)
                    {
                        accepted[frame] = buffer.Write(Numbered(frame * frameLength + 1, frameLength), frameLength);
                        if (frame % 7 == 0)
                            Thread.Yield();
                    }
                }
                catch (Exception e)
                {
                    writerError = e;
                }
            });

            var received = new float[frames * frameLength];
            var receivedCount = 0;
            var data = new float[1024];
            writer.Start();
            var clock = Stopwatch.StartNew();
            for (var round = 0; writer.IsAlive && clock.Elapsed < Timeout; round++)
            {
                // 100 ms at 48 kHz, keeping the last frame, as VoiceReceiver does.
                var read = buffer.Read(data, 1, 4800, frameLength);
                Array.Copy(data, 0, received, receivedCount, read);
                receivedCount += read;
                if (round % 3 == 0)
                    Thread.Yield();
            }
            Assert.That(writer.Join(Timeout), Is.True, "The writer never finished");
            Assert.That(writerError, Is.Null);

            // What is left, without fast-forward.
            int rest;
            while ((rest = buffer.Read(data, 1)) > 0)
            {
                Array.Copy(data, 0, received, receivedCount, rest);
                receivedCount += rest;
            }

            var mismatch = (string)null;
            for (var i = 0; i < receivedCount && mismatch == null; i++)
            {
                var sample = (int)received[i] - 1;
                if (sample < 0 || sample >= frames * frameLength || sample % frameLength >= accepted[sample / frameLength])
                    mismatch = $"Sample {received[i]} was read but never accepted";
                else if (i > 0 && received[i] <= received[i - 1])
                    mismatch = $"Sample {received[i]} came after {received[i - 1]}";
            }
            Assert.That(mismatch, Is.Null);
            Assert.That(receivedCount + buffer.FastForwarded, Is.EqualTo(accepted.Sum()), "Samples were lost that did fit and were not fast-forwarded");
        }

        /// <summary>
        /// 120 ms frames at 48 kHz against a 100 ms fast-forward latency. Keeping the last frame and
        /// dropping the rest was a negative count with only one frame waiting, and List.RemoveRange
        /// threw on the audio thread.
        /// </summary>
        [Test]
        public void FastForwardKeepsAFrameLongerThanTheLatencyWhole()
        {
            var buffer = new VoicePlaybackBuffer(48000);
            var data = new float[2 * 480];

            Assert.That(buffer.Write(Numbered(1, 5760), 5760), Is.EqualTo(5760));
            Assert.That(buffer.Read(data, 2, 4800, 5760), Is.EqualTo(480));
            Assert.That(data[0], Is.EqualTo(1f));
            Assert.That(buffer.FastForwarded, Is.Zero);

            // Two more frames: what is left of the first and all of the second are dropped.
            buffer.Write(Numbered(5761, 2 * 5760), 2 * 5760);
            Assert.That(buffer.Read(data, 2, 4800, 5760), Is.EqualTo(480));
            Assert.That(data[0], Is.EqualTo(2 * 5760 + 1f));
            Assert.That(buffer.FastForwarded, Is.EqualTo(5760 - 480 + 5760));
            Assert.That(buffer.Count, Is.EqualTo(5760 - 480));
        }

        [Test]
        public void FastForwardDropsAllButTheLastFrameOnlyPastTheLatency()
        {
            var buffer = new VoicePlaybackBuffer(48000);

            buffer.Write(Numbered(1, 4800), 4800);
            var data = new float[960];
            buffer.Read(data, 1, 4800, 960);
            Assert.That(data[0], Is.EqualTo(1f), "Audio within the latency was dropped");
            ReadAll(buffer);

            buffer.Write(Numbered(1, 10 * 960), 10 * 960);
            buffer.Read(data, 1, 4800, 960);
            Assert.That(data, Is.EqualTo(Numbered(9 * 960 + 1, 960)));
            Assert.That(buffer.Count, Is.Zero);
        }

        [Test]
        public void FastForwardKeepsNoMoreThanIsWaiting()
        {
            var buffer = new VoicePlaybackBuffer(4096);

            buffer.Write(Numbered(1, 500), 500);
            Assert.That(ReadAllFastForwarded(buffer, 100, 1000), Is.EqualTo(Numbered(1, 500)));
            Assert.That(buffer.FastForwarded, Is.Zero);

            buffer.Write(Numbered(1, 500), 500);
            Assert.That(ReadAllFastForwarded(buffer, 100, 0), Is.Empty);
            Assert.That(buffer.FastForwarded, Is.EqualTo(500));

            buffer.Write(Numbered(1, 500), 500);
            Assert.That(ReadAllFastForwarded(buffer, 100, -5), Is.Empty);
        }

        private static float[] ReadAllFastForwarded(VoicePlaybackBuffer buffer, int fastForwardAbove, int keep)
        {
            var data = new float[buffer.Capacity];
            var read = buffer.Read(data, 1, fastForwardAbove, keep);
            return data.Take(read).ToArray();
        }

        [Test]
        public void EachSampleGoesToEveryChannelAndTheRestIsSilence()
        {
            var buffer = new VoicePlaybackBuffer(1024);
            buffer.Write(new[] { 0.5f, -0.25f, 1f }, 3);

            var stereo = Enumerable.Repeat(9f, 8).ToArray();
            Assert.That(buffer.Read(stereo, 2), Is.EqualTo(3));
            Assert.That(stereo, Is.EqualTo(new[] { 0.5f, 0.5f, -0.25f, -0.25f, 1f, 1f, 0f, 0f }));

            buffer.Write(new[] { 0.5f, -0.25f }, 2);
            var surround = Enumerable.Repeat(9f, 13).ToArray();
            Assert.That(buffer.Read(surround, 6), Is.EqualTo(2));
            Assert.That(surround, Is.EqualTo(Enumerable.Repeat(0.5f, 6).Concat(Enumerable.Repeat(-0.25f, 6)).Concat(new[] { 0f })));

            var empty = Enumerable.Repeat(9f, 4).ToArray();
            Assert.That(buffer.Read(empty, 2), Is.Zero);
            Assert.That(empty, Is.All.EqualTo(0f));
        }

        /// <summary>What does not fit is dropped, the newest samples, and what did fit plays in full.</summary>
        [Test]
        public void WhatDoesNotFitIsDropped()
        {
            var buffer = new VoicePlaybackBuffer(1000);
            Assert.That(buffer.Capacity, Is.EqualTo(1024));

            Assert.That(buffer.Write(Numbered(1, 1500), 1500), Is.EqualTo(1024));
            Assert.That(buffer.Write(Numbered(1501, 10), 10), Is.Zero);
            Assert.That(buffer.Count, Is.EqualTo(1024));

            Assert.That(ReadAll(buffer), Is.EqualTo(Numbered(1, 1024)));
            Assert.That(buffer.Write(Numbered(1, 10), 10), Is.EqualTo(10));
        }

        [Test]
        public void ClearedSamplesAreNeverRead()
        {
            var buffer = new VoicePlaybackBuffer(1024);

            buffer.Write(Numbered(1, 1000), 1000);
            buffer.Clear();
            Assert.That(buffer.Count, Is.Zero);
            Assert.That(ReadAll(buffer), Is.Empty);

            buffer.Write(Numbered(1001, 10), 10);
            buffer.Clear();
            buffer.Write(Numbered(1011, 10), 10);
            Assert.That(ReadAll(buffer), Is.EqualTo(Numbered(1011, 10)));
        }

        /// <summary>
        /// One clear, as StartPlayback makes, then 2^31 samples, 12.4 hours at 48 kHz. The clear's
        /// mark stays where it was, and the reader took it for a clear still to come: it jumped
        /// back to it, played silence, and dropped everything written, for another 2^31 samples.
        /// </summary>
        [Test]
        public void AClearIsSkippedToOnceAndNot2To31SamplesLater()
        {
            var buffer = new VoicePlaybackBuffer(1 << 16);
            buffer.Clear();

            // Past 2^31 and short of 2^32, where the old check was right again. Fast-forward drops
            // each frame, so this takes under a second, not hours.
            var frame = new float[buffer.Capacity];
            var data = new float[2];
            var accepted = 0L;
            for (var fed = 0L; fed < (1L << 31) + 4 * frame.Length; fed += frame.Length)
            {
                accepted += buffer.Write(frame, frame.Length);
                buffer.Read(data, 2, 0, 0);
            }
            Assert.That(accepted, Is.EqualTo((1L << 31) + 4 * frame.Length));
            Assert.That(buffer.Count, Is.Zero);

            buffer.Write(Numbered(1, 960), 960);
            Assert.That(buffer.Count, Is.EqualTo(960));
            Assert.That(ReadAll(buffer), Is.EqualTo(Numbered(1, 960)));
        }

        /// <summary>The counters wrap around at 2^32, after some 25 hours at 48 kHz.</summary>
        [Test]
        public void TheCountersWrapAroundWithoutLosingTheirPlace()
        {
            var buffer = new VoicePlaybackBuffer(1024, int.MaxValue - 1500);

            for (var round = 0; round < 6; round++)
            {
                Assert.That(buffer.Write(Numbered(round * 1000 + 1, 1000), 1000), Is.EqualTo(1000));
                Assert.That(buffer.Count, Is.EqualTo(1000));
                Assert.That(ReadAll(buffer), Is.EqualTo(Numbered(round * 1000 + 1, 1000)), $"Round {round}");
            }

            buffer.Write(Numbered(1, 1000), 1000);
            Assert.That(ReadAllFastForwarded(buffer, 100, 10), Is.EqualTo(Numbered(991, 10)));

            buffer.Write(Numbered(1, 1000), 1000);
            buffer.Clear();
            Assert.That(buffer.Write(Numbered(1, 1024), 1024), Is.EqualTo(24), "Cleared samples take up room until the reader skips them");
            Assert.That(ReadAll(buffer), Is.EqualTo(Numbered(1, 24)));
        }
    }
}
