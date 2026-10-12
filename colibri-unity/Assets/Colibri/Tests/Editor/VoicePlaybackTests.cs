using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using HCIKonstanz.Colibri.Networking.Protocol;
using NUnit.Framework;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// VoiceReceiver's StartPlayback and StopPlayback. StartPlayback said it was playing before it
    /// had a buffer, so the audio thread could find none, and it added a listener every time:
    /// started twice for the same voice id, it played each packet twice.
    /// </summary>
    public class VoicePlaybackTests
    {
        private readonly List<string> _listeners = new List<string>();

        [SetUp]
        public void Clear() => _listeners.Clear();

        private VoicePlayback Playback()
            => new VoicePlayback(new VoicePlaybackBuffer(4096), id => _listeners.Add("+" + id), id => _listeners.Add("-" + id));

        private static float[] Numbered(int first, int count)
            => Enumerable.Range(first, count).Select(i => (float)i).ToArray();

        [Test]
        public void BeforeStartTheAudioThreadReadsSilence()
        {
            var playback = Playback();
            var data = Enumerable.Repeat(9f, 8).ToArray();

            Assert.That(playback.Read(data, 2), Is.Zero);
            Assert.That(data, Is.All.EqualTo(0f));
            Assert.That(playback.IsPlaying, Is.False);
            Assert.That(_listeners, Is.Empty);
        }

        [Test]
        public void StartingTwiceAddsTheListenerOnce()
        {
            var playback = Playback();

            Assert.That(playback.Start(5), Is.True);
            Assert.That(playback.Start(5), Is.False, "The second start of the same id changed something");
            Assert.That(_listeners, Is.EqualTo(new[] { "+5" }));
            Assert.That(playback.Id, Is.EqualTo(5));
        }

        [Test]
        public void StartingAnotherIdReplacesTheFirst()
        {
            var playback = Playback();
            playback.Start(5);
            playback.Buffer.Write(Numbered(1, 100), 100);

            Assert.That(playback.Start(7), Is.True);

            Assert.That(_listeners, Is.EqualTo(new[] { "+5", "-5", "+7" }));
            Assert.That(playback.Id, Is.EqualTo(7));
            Assert.That(playback.Read(new float[200], 1), Is.Zero, "The first id's audio was played for the second");
        }

        [Test]
        public void StoppingTwiceRemovesTheListenerOnce()
        {
            var playback = Playback();

            Assert.That(playback.Stop(), Is.False, "A stop before any start did something");
            playback.Start(5);
            Assert.That(playback.Stop(), Is.True);
            Assert.That(playback.Stop(), Is.False, "The second stop did something");
            Assert.That(_listeners, Is.EqualTo(new[] { "+5", "-5" }));

            // And it starts again as the first time.
            Assert.That(playback.Start(5), Is.True);
            Assert.That(_listeners, Is.EqualTo(new[] { "+5", "-5", "+5" }));
        }

        [Test]
        public void WhatIsLeftOfTheLastPlaybackIsNotPlayed()
        {
            var playback = Playback();
            playback.Start(5);
            playback.Buffer.Write(Numbered(1, 100), 100);
            playback.Stop();

            var data = Enumerable.Repeat(9f, 50).ToArray();
            Assert.That(playback.Read(data, 1), Is.Zero);
            Assert.That(data, Is.All.EqualTo(0f), "Stopped, it did not play silence");

            playback.Start(5);
            playback.Buffer.Write(Numbered(101, 10), 10);
            Assert.That(playback.Read(data, 1), Is.EqualTo(10));
            Assert.That(data.Take(10), Is.EqualTo(Numbered(101, 10)));
        }

        /// <summary>
        /// The audio thread reads all along while the main thread starts, writes and stops over and
        /// over. Nothing throws, and nothing is read but silence or what was written.
        /// </summary>
        [Test]
        public void StartingAndStoppingWhileTheAudioThreadReadsNeverThrows()
        {
            var playback = Playback();
            var stop = 0;
            Exception readerError = null;
            var unexpected = (string)null;

            var reader = new Thread(() =>
            {
                try
                {
                    var data = new float[2 * 256];
                    while (Volatile.Read(ref stop) == 0)
                    {
                        playback.Read(data, 2, 4800, 960);
                        foreach (var sample in data)
                        {
                            if (sample < 0f || sample > 1000f || sample != Math.Floor(sample))
                                unexpected = $"Read {sample}, which was never written";
                        }
                    }
                }
                catch (Exception e)
                {
                    readerError = e;
                }
            });
            reader.Start();

            try
            {
                for (var round = 0; round < 20000; round++)
                {
                    playback.Start((short)(round % 3 + 1));
                    playback.Buffer.Write(Numbered(1, 960), 960);
                    if (round % 2 == 0)
                        playback.Stop();
                }
            }
            finally
            {
                Volatile.Write(ref stop, 1);
                Assert.That(reader.Join(TimeSpan.FromSeconds(60)), Is.True, "The reader never finished");
            }

            Assert.That(readerError, Is.Null);
            Assert.That(unexpected, Is.Null);
        }
    }
}
