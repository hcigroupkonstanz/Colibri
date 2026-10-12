using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using HCIKonstanz.Colibri.Core;
using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Setup;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace HCIKonstanz.Colibri.E2E
{
    /// <summary>
    /// The connection component's own lifetime: what it does with a configuration it cannot use,
    /// and what happens when it is disabled, destroyed, or torn down with the app.
    ///
    /// Like <see cref="ProtocolMismatchDetectionTests"/>, these point the connection singleton at a
    /// <see cref="FakeColibriServer"/>, so they own its lifetime and put it back afterwards. In a run
    /// over TLS (<see cref="E2EServer.OverTls"/>) that server speaks TLS, so the writes these drive
    /// through a slow link, a held send lock and the end of the app go through TLS as well.
    /// </summary>
    public class ConnectionLifetimeTests
    {
        private static readonly Regex Attempt = new Regex("^Colibri: connecting to ");

        // What the connection says about an attempt or a session that failed, and about trying again.
        private static readonly Regex Failure = new Regex("did not answer|failed|retrying|server closed the connection|invalid frame",
            RegexOptions.IgnoreCase);

        private FakeColibriServer _server;
        private readonly TestCleanup _cleanup = new TestCleanup();

        [UnitySetUp]
        public IEnumerator ReplaceTheConnection()
        {
            yield return DestroyConnection();
        }

        [UnityTearDown]
        public IEnumerator RestoreTheConnection()
        {
            _cleanup.Run();
            _server?.Dispose();
            _server = null;

            // Pointed at the real server and freshly built, the way the rest of the suite expects
            // to find it.
            yield return DestroyConnection();
            E2EServer.Configure();

            LogAssert.ignoreFailingMessages = false;
        }


        /*
         *  A configuration the connection cannot use
         */

        /// <summary>
        /// An App Name of spaces is no App Name: the setup and status windows say the project is not
        /// configured. The connection used to disagree - it connected, as an app of its own that no
        /// other client is in, and said nothing. It now says it is not configured, once, and waits
        /// for a real name, which it connects with as soon as there is one.
        /// </summary>
        [UnityTest]
        public IEnumerator AnAppNameOfSpacesIsNotConfiguredAndConnectsNowhere()
        {
            _server = StartServer();

            var notConfigured = 0;
            Application.LogCallback countNotConfigured = (message, stackTrace, type) =>
            {
                if (type == LogType.Error && message == ColibriConfig.NOT_CONFIGURED_MESSAGE)
                    Interlocked.Increment(ref notConfigured);
            };

            Application.logMessageReceivedThreaded += countNotConfigured;
            _cleanup.Add(() => Application.logMessageReceivedThreaded -= countNotConfigured);

            // Logged by the connection loop, off the main thread; counted above instead.
            LogAssert.ignoreFailingMessages = true;

            var connection = ConnectionTo(_server.Port, appName: "   ");

            // Three of the loop's half-second polls.
            yield return E2EServer.Settle(1.5f);

            Assert.That(_server.Accepted, Is.Zero, "An App Name of spaces was used to connect");
            Assert.That(connection.Status, Is.EqualTo(ConnectionStatus.Disconnected));
            Assert.That(notConfigured, Is.EqualTo(1), "Not being configured should be said exactly once");

            ColibriConfig.Load().AppName = E2EServer.App;
            yield return E2EServer.WaitUntil(() => connection.Status == ConnectionStatus.Connected,
                "The connection did not connect once the App Name was set", 10f);
        }


        /*
         *  The end of Play mode, or of the app
         */

        /// <summary>
        /// SyncTicker hands the connection what the send-rate limit was holding as the app quits,
        /// and the connection closes its socket in its own OnDisable a moment later. On Mono and
        /// IL2CPP a socket write completes on a worker thread, so the last update could still be
        /// on its way and was then lost with the socket. Quitting now waits briefly for the outbox.
        /// </summary>
        /// <remarks>
        /// Under .NET a small write usually completes inline, so the write still in progress is
        /// staged here: the socket is held, as a write that has not finished holds it, and let go
        /// 30 ms later from another thread.
        /// </remarks>
        [UnityTest]
        public IEnumerator WhatIsStillBeingWrittenWhenTheAppQuitsReachesTheServer()
        {
            _server = StartServer();
            var connection = ConnectionTo(_server.Port);
            yield return E2EServer.WaitUntil(() => connection.Status == ConnectionStatus.Connected,
                "The client never connected", 10f);

            HoldTheSocket(connection, releaseAfterMs: 30);
            SingletonLifetime.IsQuitting = true;
            try
            {
                connection.SendCommand("quit-test", "model::update", new JObject { { "id", "x" }, { "label", "last" } });
                Object.DestroyImmediate(connection.gameObject);
            }
            finally
            {
                // Every later test needs a live application again.
                SingletonLifetime.IsQuitting = false;
            }

            yield return E2EServer.WaitUntil(() => _server.Received.Any(sent => sent.Frame.Channel == "quit-test"),
                "The update sent as the app quit never reached the server", 2f);
        }

        /// <summary>
        /// The wait is bounded: a write that does not finish - a link that has just gone - holds up
        /// the end of Play mode or the app by no more than a brief moment.
        /// </summary>
        [UnityTest]
        public IEnumerator QuittingWaitsOnlyBrieflyForAWriteThatDoesNotFinish()
        {
            _server = StartServer();
            var connection = ConnectionTo(_server.Port);
            yield return E2EServer.WaitUntil(() => connection.Status == ConnectionStatus.Connected,
                "The client never connected", 10f);

            connection.SendLock.Wait();
            SingletonLifetime.IsQuitting = true;
            try
            {
                connection.SendCommand("quit-test", "model::update", new JObject { { "id", "x" }, { "label", "last" } });

                var clock = System.Diagnostics.Stopwatch.StartNew();
                Object.DestroyImmediate(connection.gameObject);

                Assert.That(clock.ElapsedMilliseconds, Is.LessThan(500), "Quitting waited too long for a write that does not finish");
            }
            finally
            {
                SingletonLifetime.IsQuitting = false;
                connection.SendLock.Release();
            }
        }

        /// <summary>
        /// Only the end of the app waits. An ordinary disable closes the socket at once, and what
        /// was still queued goes out after the component is enabled again, on the next connection.
        /// </summary>
        [UnityTest]
        public IEnumerator AnOrdinaryDisableDoesNotWaitAndSendsWhatWasQueuedAfterTheNextEnable()
        {
            _server = StartServer();
            var connection = ConnectionTo(_server.Port);
            yield return E2EServer.WaitUntil(() => connection.Status == ConnectionStatus.Connected,
                "The client never connected", 10f);

            HoldTheSocket(connection, releaseAfterMs: 30);
            connection.SendCommand("disable-test", "broadcast::int", 1);
            connection.enabled = false;

            yield return E2EServer.Settle(0.3f);
            Assert.That(_server.Received.Where(sent => sent.Frame.Channel == "disable-test"), Is.Empty,
                "An ordinary disable waited for the outbox");

            connection.enabled = true;
            yield return E2EServer.WaitUntil(() => _server.Received.Any(sent => sent.Frame.Channel == "disable-test"),
                "What was queued when the component was disabled was not sent after it was enabled again", 10f);

            Assert.That(_server.Received.Single(sent => sent.Frame.Channel == "disable-test").Session, Is.EqualTo(2));
        }


        /*
         *  A write that takes longer than the heartbeat watchdog
         *
         *  The receive loop used to wait for the socket to echo each heartbeat, and a large message
         *  on a slow link holds the socket for as long as it takes to write. Waiting, the loop read
         *  nothing - the server's heartbeats included - so after 2 s the watchdog dropped a healthy
         *  connection. The next session sent the same message first and was dropped the same way,
         *  over and over, with nothing else getting through.
         */

        /// <summary>
        /// The mechanism on its own: the socket is held, the way a long write holds it, for longer
        /// than the watchdog's 2 s, while the server keeps heartbeating and Update keeps running.
        /// </summary>
        [UnityTest]
        public IEnumerator HoldingTheSocketPastTheWatchdogDoesNotDropAHealthyConnection()
        {
            _server = StartServer();
            var connection = ConnectionTo(_server.Port);
            var events = Record(connection);
            yield return E2EServer.WaitUntil(() => events.Count == 1, "The client never connected", 10f);

            connection.SendLock.Wait();
            try
            {
                yield return E2EServer.Settle(3f);
            }
            finally
            {
                connection.SendLock.Release();
            }

            // Echoing resumes once the socket is free.
            var echoes = _server.Echoes;
            yield return E2EServer.WaitUntil(() => _server.Echoes > echoes, "No heartbeat was echoed once the socket was free again", 2f);

            Assert.That(events, Is.EqualTo(new[] { "connected" }),
                "The connection was dropped while a write held the socket, though the server never stopped heartbeating");
            Assert.That(_server.Accepted, Is.EqualTo(1));
        }

        /// <summary>
        /// The same through a real slow link: a server that reads a quarter of a megabyte a second,
        /// and a send buffer that holds little of what is written, so that writing 1 MiB takes some
        /// 4 s. The message arrives whole, on the first connection, and so does the one queued
        /// behind it.
        /// </summary>
        [UnityTest]
        public IEnumerator ALargeMessageOnASlowLinkArrivesWithoutTheConnectionBeingDropped()
        {
            _server = StartServer(readBytesPerSecond: 256 * 1024);
            var connection = ConnectionTo(_server.Port);
            var events = Record(connection);
            yield return E2EServer.WaitUntil(() => events.Count == 1, "The client never connected", 10f);

            connection.CurrentSocket.SendBufferSize = 64 * 1024;

            var clock = System.Diagnostics.Stopwatch.StartNew();
            connection.SendCommand("slow-link", "broadcast::json", new JValue(new string('x', 1024 * 1024)));
            connection.SendCommand("slow-link-after", "broadcast::int", 1);

            yield return E2EServer.WaitUntil(
                () => events.Count > 1 || _server.Received.Any(sent => sent.Frame.Channel == "slow-link-after"),
                "Neither message arrived", 20f);

            Assert.That(events, Is.EqualTo(new[] { "connected" }),
                "The connection was dropped while it was writing a large message to a slow link");
            Assert.That(_server.Received.Select(sent => $"{sent.Session} {sent.Frame.Channel} {sent.Frame.Payload.Length}"),
                Is.EqualTo(new[] { $"1 slow-link {1024 * 1024 + 2}", "1 slow-link-after 1" }));
            Assert.That(clock.Elapsed.TotalSeconds, Is.GreaterThan(2.5),
                "Precondition: writing the message should have taken longer than the watchdog's 2 s");
        }


        /*
         *  OnConnected and OnDisconnected when the component goes away
         *
         *  Both are raised from Update, which a disabled or destroyed component no longer gets. So
         *  the OnDisconnected of a connection that was open at that moment was never raised, and
         *  the last event user code saw said it was still connected.
         */

        [UnityTest]
        public IEnumerator DestroyingTheConnectionWhileConnectedRaisesOnDisconnected()
        {
            _server = StartServer();
            var connection = ConnectionTo(_server.Port);
            var events = Record(connection);
            yield return E2EServer.WaitUntil(() => events.Count == 1, "The client never connected", 10f);

            Object.DestroyImmediate(connection.gameObject);

            Assert.That(events, Is.EqualTo(new[] { "connected", "disconnected" }),
                "The connection was destroyed while connected, but the last event raised said it was connected");
        }

        /// <summary>
        /// Connected, but destroyed before an Update could report it: both are raised, in order, so
        /// the pair still matches and the last one still tells the truth.
        /// </summary>
        [UnityTest]
        public IEnumerator AConnectionNotYetReportedIsReportedAndEndedWhenTheComponentIsDestroyed()
        {
            _server = StartServer();
            var connection = ConnectionTo(_server.Port);
            var events = Record(connection);

            // No Update runs while this holds the main thread; the connection loop does not need one.
            var deadline = System.DateTime.UtcNow.AddSeconds(10);
            while (connection.Status != ConnectionStatus.Connected && System.DateTime.UtcNow < deadline)
                Thread.Sleep(10);
            Assert.That(connection.Status, Is.EqualTo(ConnectionStatus.Connected), "The client never connected");
            Assert.That(events, Is.Empty);

            Object.DestroyImmediate(connection.gameObject);

            Assert.That(events, Is.EqualTo(new[] { "connected", "disconnected" }));
            yield break;
        }

        /// <summary>
        /// Disabling raises OnDisconnected at once - it used to wait for the Update after the
        /// component was enabled again - and enabling it again connects anew.
        /// </summary>
        [UnityTest]
        public IEnumerator DisablingTheConnectionWhileConnectedRaisesOnDisconnectedAtOnce()
        {
            _server = StartServer();
            var connection = ConnectionTo(_server.Port);
            var events = Record(connection);
            yield return E2EServer.WaitUntil(() => events.Count == 1, "The client never connected", 10f);

            connection.enabled = false;
            Assert.That(events, Is.EqualTo(new[] { "connected", "disconnected" }),
                "The connection was disabled while connected, but the last event raised said it was connected");

            connection.enabled = true;
            yield return E2EServer.WaitUntil(() => events.Count == 3, "The client never connected again after it was enabled", 10f);

            // A frame more, for anything that was going to be raised late.
            yield return null;
            Assert.That(events, Is.EqualTo(new[] { "connected", "disconnected", "connected" }));
        }

        /// <summary>
        /// A handler of OnConnected that disables the connection: the OnDisconnected that its
        /// OnDisable is due waits until OnConnected has reached every handler. Raised right away,
        /// in the middle of OnConnected, it would reach the handlers after this one first, and the
        /// last event they saw would say connected while the connection is off.
        /// </summary>
        [UnityTest]
        public IEnumerator AHandlerThatDisablesTheConnectionOnConnectedLeavesTheOtherHandlersTheEventsInOrder()
        {
            _server = StartServer();
            var connection = ConnectionTo(_server.Port);

            var disabling = new List<string>();
            connection.OnConnected += () =>
            {
                disabling.Add("connected");
                connection.enabled = false;
            };
            connection.OnDisconnected += () => disabling.Add("disconnected");
            var later = Record(connection);

            yield return E2EServer.WaitUntil(() => disabling.Count > 0, "The client never connected", 10f);

            // A frame more, for anything that was going to be raised late.
            yield return null;
            Assert.That(connection.enabled, Is.False);
            Assert.That(disabling, Is.EqualTo(new[] { "connected", "disconnected" }));
            Assert.That(later, Is.EqualTo(new[] { "connected", "disconnected" }),
                "A handler after the one that disabled the connection was told it connected after it was told it disconnected");
        }

        /// <summary>
        /// The end of Play mode or of the app raises neither event: teardown has no order, so a
        /// handler would as likely run on an object destroyed a moment before.
        /// </summary>
        [UnityTest]
        public IEnumerator TheEndOfTheAppRaisesNoConnectionEvents()
        {
            _server = StartServer();
            var connection = ConnectionTo(_server.Port);
            var events = Record(connection);
            yield return E2EServer.WaitUntil(() => events.Count == 1, "The client never connected", 10f);

            SingletonLifetime.IsQuitting = true;
            try
            {
                Object.DestroyImmediate(connection.gameObject);
            }
            finally
            {
                SingletonLifetime.IsQuitting = false;
            }

            Assert.That(events, Is.EqualTo(new[] { "connected" }));
        }


        /*
         *  Disabling and enabling again in one frame
         *
         *  OnEnable starts the next connection loop at once, while the one OnDisable ended is still
         *  unwinding on a worker thread. That loop's cleanup used to act on what had become the next
         *  loop's: it closed the new socket in the middle of its connect - on Mono the connect then
         *  never finished, and a healthy server was reported as not answering within 5 s - and it
         *  could close the outbox and set Disconnected under a session that was already Connected.
         *  It also said it was retrying, which it was not.
         */

        /// <summary>
        /// The next loop connects with its first attempt, at once, and the loop that was ended
        /// says nothing.
        /// </summary>
        [UnityTest]
        public IEnumerator DisablingAndEnablingInOneFrameConnectsAgainWithTheFirstAttempt()
        {
            _server = StartServer();
            var connection = ConnectionTo(_server.Port);
            var events = Record(connection);
            yield return E2EServer.WaitUntil(() => events.Count == 1, "The client never connected", 10f);

            var log = _cleanup.Add(new LogLines());

            var clock = System.Diagnostics.Stopwatch.StartNew();
            connection.enabled = false;
            connection.enabled = true;

            yield return E2EServer.WaitUntil(() => events.Count == 3, "The client never connected again after it was enabled", 10f);
            var reconnected = clock.Elapsed.TotalSeconds;

            // Time for anything the ended loop was still going to do.
            yield return E2EServer.Settle(1f);

            Assert.That(log.Matching(Attempt), Has.Length.EqualTo(1),
                $"Enabling the connection again took more than one attempt to connect. Logged:\n{log}");
            Assert.That(log.Matching(Failure), Is.Empty,
                $"Something failed, or said it was retrying, after a disable and enable. Logged:\n{log}");
            Assert.That(reconnected, Is.LessThan(2), "Connecting again after a disable and enable took too long");
            Assert.That(_server.Accepted, Is.EqualTo(2));
            Assert.That(events, Is.EqualTo(new[] { "connected", "disconnected", "connected" }));
            Assert.That(connection.Status, Is.EqualTo(ConnectionStatus.Connected));
        }

        /// <summary>
        /// What is sent right after the component is enabled again waits for the next session and
        /// goes out on it, and so does what is sent once that session is up: the session stays
        /// Connected, and its outbox open, whenever the ended loop gets round to its cleanup.
        /// </summary>
        [UnityTest]
        public IEnumerator WhatIsSentRightAfterADisableAndEnableInOneFrameIsDelivered()
        {
            _server = StartServer();
            var connection = ConnectionTo(_server.Port);
            var events = Record(connection);
            yield return E2EServer.WaitUntil(() => events.Count == 1, "The client never connected", 10f);

            connection.enabled = false;
            connection.enabled = true;
            var first = connection.SendCommandAsync("toggle-test", "broadcast::int", 1);

            yield return E2EServer.Await(first, "What was sent right after the component was enabled again was not written in time", 3f);
            Assert.That(first.Result, Is.True);

            // Time for anything the ended loop was still going to do to the session.
            yield return E2EServer.Settle(1f);
            Assert.That(connection.Status, Is.EqualTo(ConnectionStatus.Connected));

            var second = connection.SendCommandAsync("toggle-test", "broadcast::int", 2);
            yield return E2EServer.Await(second, "What was sent once the next session was up was not written", 2f);
            Assert.That(second.Result, Is.True);

            yield return E2EServer.WaitUntil(() => _server.Received.Count(sent => sent.Frame.Channel == "toggle-test") == 2,
                "The server did not receive both messages", 2f);
            Assert.That(_server.Received.Where(sent => sent.Frame.Channel == "toggle-test").Select(sent => sent.Session),
                Is.EqualTo(new[] { 2, 2 }), "Both messages should have gone out on the session the enable started");
            Assert.That(events, Is.EqualTo(new[] { "connected", "disconnected", "connected" }));
            Assert.That(connection.ConnectedSessions, Is.EqualTo(2));
        }

        /// <summary>
        /// The ended loop's cleanup, held until the next loop's session is Connected and let go
        /// then: the session stays Connected, and what is sent goes out on it. On its own the ended
        /// loop has cleaned up long before the next session is up, which the test above cannot get
        /// past.
        /// </summary>
        [UnityTest]
        public IEnumerator AnEndedLoopThatCleansUpLateLeavesTheNextSessionAlone()
        {
            _server = StartServer();
            var connection = ConnectionTo(_server.Port);
            var events = Record(connection);
            yield return E2EServer.WaitUntil(() => events.Count == 1, "The client never connected", 10f);

            // Holds the first loop to get there, the one the disable ends.
            var release = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            var held = 0;
            connection.BeforeSessionCleanup = () => Interlocked.Increment(ref held) == 1 ? release.Task : Task.CompletedTask;
            var ended = connection.CurrentLoop;
            _cleanup.Add(() =>
            {
                connection.BeforeSessionCleanup = null;
                release.TrySetResult(true);
            });

            connection.enabled = false;
            connection.enabled = true;

            yield return E2EServer.WaitUntil(() => Volatile.Read(ref held) == 1, "The ended loop never got to its cleanup", 5f);
            yield return E2EServer.WaitUntil(() => events.Count == 3, "The client never connected again after it was enabled", 10f);
            Assert.That(ended.IsCompleted, Is.False, "The ended loop should still be waiting to clean up");

            release.SetResult(true);
            yield return E2EServer.Await(ended, "The ended loop never finished its cleanup", 5f);

            // One Update, to raise whatever the cleanup changed.
            yield return null;
            Assert.That(connection.Status, Is.EqualTo(ConnectionStatus.Connected), "The ended loop's cleanup changed the next session's status");

            var sent = connection.SendCommandAsync("late-cleanup-test", "broadcast::int", 1);
            yield return E2EServer.Await(sent, "What was sent after the ended loop's cleanup was not written", 2f);
            Assert.That(sent.Result, Is.True);

            yield return E2EServer.WaitUntil(() => _server.Received.Any(received => received.Frame.Channel == "late-cleanup-test"),
                "The server did not receive the message", 2f);
            Assert.That(_server.Received.Where(received => received.Frame.Channel == "late-cleanup-test").Select(received => received.Session),
                Is.EqualTo(new[] { 2 }), "The message should have gone out on the session the enable started");
            Assert.That(events, Is.EqualTo(new[] { "connected", "disconnected", "connected" }));
        }

        /// <summary>
        /// Twice over: of the two loops started in one frame, the first is ended at once and the
        /// second connects, and neither the first nor the one before it says or changes anything.
        /// </summary>
        [UnityTest]
        public IEnumerator DisablingAndEnablingTwiceInOneFrameConnectsOnce()
        {
            _server = StartServer();
            var connection = ConnectionTo(_server.Port);
            var events = Record(connection);
            yield return E2EServer.WaitUntil(() => events.Count == 1, "The client never connected", 10f);

            var log = _cleanup.Add(new LogLines());

            connection.enabled = false;
            connection.enabled = true;
            connection.enabled = false;
            connection.enabled = true;
            connection.SendCommand("rapid-test", "broadcast::int", 1);

            yield return E2EServer.WaitUntil(() => events.Count == 3, "The client never connected again after it was enabled", 10f);
            yield return E2EServer.WaitUntil(() => _server.Received.Any(sent => sent.Frame.Channel == "rapid-test"),
                "What was sent after the second enable never reached the server", 3f);
            yield return E2EServer.Settle(1f);

            Assert.That(log.Matching(Attempt), Has.Length.EqualTo(2), $"One attempt per enable, and no more. Logged:\n{log}");
            Assert.That(log.Matching(Failure), Is.Empty, $"Logged:\n{log}");
            Assert.That(events, Is.EqualTo(new[] { "connected", "disconnected", "connected" }));
            Assert.That(connection.Status, Is.EqualTo(ConnectionStatus.Connected));
            Assert.That(_server.Received.Where(sent => sent.Frame.Channel == "rapid-test").Select(sent => sent.Session),
                Is.EqualTo(new[] { _server.Accepted }), "The message should have gone out once, on the last session");
        }

        /// <summary>
        /// Destroyed in the frame it was enabled again: no loop is left running, none of them says
        /// anything, and nothing connects.
        /// </summary>
        [UnityTest]
        public IEnumerator DestroyingTheConnectionRightAfterEnablingItLeavesNothingRunning()
        {
            _server = StartServer();
            var connection = ConnectionTo(_server.Port);
            yield return E2EServer.WaitUntil(() => connection.Status == ConnectionStatus.Connected, "The client never connected", 10f);

            var log = _cleanup.Add(new LogLines());

            connection.enabled = false;
            connection.enabled = true;
            Object.DestroyImmediate(connection.gameObject);

            // Longer than the shortest reconnect backoff: a loop left running would have tried again.
            yield return E2EServer.Settle(1.5f);

            Assert.That(log.Matching(Attempt), Has.Length.EqualTo(1), $"Logged:\n{log}");
            Assert.That(log.Matching(Failure), Is.Empty, $"Logged:\n{log}");
            Assert.That(log.Matching(new Regex("^Colibri: connected to ")), Is.Empty, $"Logged:\n{log}");
            Assert.That(_server.Accepted, Is.LessThanOrEqualTo(2));
        }


        /*
         *  Driving the connection singleton
         */

        /// <summary>A server that heartbeats, over TLS in a run over TLS.</summary>
        private static FakeColibriServer StartServer(int readBytesPerSecond = 0)
            => FakeColibriServer.Start(FakeColibriServer.Behaviour.Heartbeat, readBytesPerSecond, useTls: E2EServer.OverTls);

        private static List<string> Record(WebServerConnection connection)
        {
            var events = new List<string>();
            connection.OnConnected += () => events.Add("connected");
            connection.OnDisconnected += () => events.Add("disconnected");
            return events;
        }

        /// <summary>
        /// Points a fresh connection at the given port and hands it back without waiting a frame,
        /// so that a test can subscribe to its events before it raises any.
        /// </summary>
        private static WebServerConnection ConnectionTo(int tcpPort, string appName = null)
        {
            E2EServer.ConfigureInProcess(tcpPort);
            var config = ColibriConfig.Load();
            if (appName != null)
                config.AppName = appName;

            // OnEnable is what reads the config, so the port only takes effect on a fresh
            // instance - which touching Instance after the teardown above creates.
            var connection = WebServerConnection.Instance;
            Assert.That(connection, Is.Not.Null);
            return connection;
        }

        /// <summary>
        /// Holds the socket the way a write that has not finished holds it, and lets go after
        /// <paramref name="releaseAfterMs"/> from another thread - which is where a write completes
        /// on Mono and IL2CPP.
        /// </summary>
        private static void HoldTheSocket(WebServerConnection connection, int releaseAfterMs)
        {
            var sendLock = connection.SendLock;
            sendLock.Wait();
            _ = Task.Run(async () =>
            {
                await Task.Delay(releaseAfterMs).ConfigureAwait(false);
                sendLock.Release();
            });
        }

        /// <summary>What Colibri logs, from any thread, until this is disposed.</summary>
        private sealed class LogLines : System.IDisposable
        {
            private readonly List<string> _lines = new List<string>();

            public LogLines()
            {
                Application.logMessageReceivedThreaded += Record;
            }

            public string[] Matching(Regex pattern)
            {
                lock (_lines)
                    return _lines.Where(line => pattern.IsMatch(line)).ToArray();
            }

            public override string ToString()
            {
                lock (_lines)
                    return string.Join("\n", _lines);
            }

            public void Dispose()
            {
                Application.logMessageReceivedThreaded -= Record;
            }

            private void Record(string message, string stackTrace, LogType type)
            {
                if (!message.StartsWith("Colibri:"))
                    return;

                lock (_lines)
                    _lines.Add(message);
            }
        }

        private static IEnumerator DestroyConnection()
        {
            var existing = Object.FindAnyObjectByType<WebServerConnection>();
            if (existing != null)
            {
                // OnDisable cancels the loop and closes the socket; the frame after is what lets
                // the cancelled loop unwind before anything rebuilds it.
                Object.DestroyImmediate(existing.gameObject);
                yield return null;
            }
        }
    }
}
