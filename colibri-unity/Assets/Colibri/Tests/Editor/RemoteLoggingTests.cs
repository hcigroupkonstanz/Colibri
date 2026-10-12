using System.Collections.Generic;
using System.Linq;
using System.Threading;
using HCIKonstanz.Colibri.Networking;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// RemoteLogging's own buffer, which fills from <c>Application.logMessageReceivedThreaded</c> -
    /// whichever threads happen to log, at the same time - and holds the lines while there is no
    /// connection to send them on.
    /// </summary>
    public class RemoteLoggingTests
    {
        private GameObject _gameObject;
        private RemoteLogging _logging;

        // Edit mode: the component's OnEnable never runs, so it neither subscribes to the log nor
        // creates a connection. The tests feed it directly.
        [SetUp]
        public void CreateComponent()
        {
            _gameObject = new GameObject("remote-logging-under-test");
            _logging = _gameObject.AddComponent<RemoteLogging>();
        }

        [TearDown]
        public void DestroyComponent()
        {
            if (_gameObject != null)
                Object.DestroyImmediate(_gameObject);
        }

        /// <summary>
        /// The buffer used to be a LockFreeQueue, whose node pool is only safe with a single
        /// producer. Losing or duplicating a line under contention is a race, so this cannot force
        /// the old failure on demand; it pins down that many loggers at once lose nothing.
        /// </summary>
        [Test]
        public void LinesLoggedFromManyThreadsAtOnceAreAllKeptExactlyOnce()
        {
            const int threads = 8;
            const int linesPerThread = 100;

            using (var start = new ManualResetEventSlim(false))
            {
                var loggers = Enumerable.Range(0, threads).Select(t => new Thread(() =>
                {
                    start.Wait();
                    for (var i = 0; i < linesPerThread; i++)
                        _logging.OnLogMessage($"thread {t} line {i}", "", LogType.Log);
                })).ToArray();

                foreach (var logger in loggers)
                    logger.Start();
                start.Set();
                foreach (var logger in loggers)
                    Assert.That(logger.Join(10000), Is.True, "A logging thread never finished");
            }

            var expected = Enumerable.Range(0, threads)
                .SelectMany(t => Enumerable.Range(0, linesPerThread).Select(i => $"thread {t} line {i}"))
                .OrderBy(line => line)
                .ToArray();

            Assert.That(_logging.BufferedLineCount, Is.EqualTo(threads * linesPerThread));
            Assert.That(_logging.BufferedLines.OrderBy(line => line).ToArray(), Is.EqualTo(expected));
        }

        /// <summary>
        /// Without a connection the lines wait - but not without limit. They used to: against a
        /// server that had refused this client, every line was put back after its send failed,
        /// for good.
        /// </summary>
        [Test]
        public void WithoutAConnectionOnlyTheNewestLinesAreKept()
        {
            for (var i = 1; i <= 1500; i++)
                _logging.OnLogMessage($"line {i}", "", LogType.Log);

            Assert.That(_logging.BufferedLineCount, Is.EqualTo(1000));
            Assert.That(_logging.BufferedLines,
                Is.EqualTo(Enumerable.Range(501, 1000).Select(i => $"line {i}").ToArray()),
                "The oldest lines should go first, and the rest stay in order");
        }

        /// <summary>
        /// The cap applies between any two sends, connected or not, so a burst of more than 1000
        /// lines within the one second between sends loses the oldest - and they used to vanish
        /// without a trace. The next send now starts with one line saying how many are missing,
        /// handed straight to the connection: through Debug.Log it would feed back into the buffer.
        /// </summary>
        [Test]
        public void DroppedLinesAreSummedUpInOneLineWhereTheyWentMissing()
        {
            for (var i = 1; i <= 1500; i++)
                _logging.OnLogMessage($"line {i}", "", LogType.Log);

            var sent = new List<(string Type, string Line)>();
            _logging.SendLog((type, line) => sent.Add((type, line)));

            Assert.That(sent.Count, Is.EqualTo(1001), "Expected one summary line and the 1000 lines kept");
            Assert.That(sent[0].Type, Is.EqualTo("warning"));
            Assert.That(sent[0].Line, Does.StartWith("Colibri: 500 log lines are missing here - more than 1000 were logged before they could be sent"));
            Assert.That(sent.Skip(1).Select(s => s.Line), Is.EqualTo(Enumerable.Range(501, 1000).Select(i => $"line {i}")));

            // Said for the lines it is about, and not again for the next batch.
            sent.Clear();
            _logging.OnLogMessage("line 1501", "", LogType.Log);
            _logging.SendLog((type, line) => sent.Add((type, line)));

            Assert.That(sent, Is.EqualTo(new[] { ("info", "line 1501") }));
            LogAssert.NoUnexpectedReceived();
        }

        [Test]
        public void AnErrorKeepsItsStackTrace()
        {
            _logging.OnLogMessage("it broke", "at Somewhere()", LogType.Error);

            Assert.That(_logging.BufferedLines, Is.EqualTo(new[] { "it broke\nat Somewhere()" }));
        }
    }
}
