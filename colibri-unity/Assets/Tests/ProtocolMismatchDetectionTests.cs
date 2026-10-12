using System.Collections;
using System.Net;
using System.Net.Sockets;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Setup;
using HCIKonstanz.Colibri.Synchronization;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace HCIKonstanz.Colibri.E2E
{
    /// <summary>
    /// The half of the version check the server cannot perform: noticing that the *server* is the
    /// one out of date.
    ///
    /// A pre-2.0.0 server has no version check, so it never refuses this client and never says
    /// what it speaks. Worse, its framing differs enough that it could not decode an explicit
    /// refusal even if one were sent. All that is left is the symptom - connections that are
    /// accepted and then die before a single frame can be read - which is what
    /// <see cref="WebServerConnection.SuspectedProtocolMismatch"/> reports on.
    ///
    /// These tests do not use <see cref="ColibriE2EFixture"/>: they have to point the connection
    /// singleton somewhere other than the real server, so they own its lifetime themselves and put
    /// it back afterwards.
    /// </summary>
    public class ProtocolMismatchDetectionTests
    {
        private FakeV1Server _fakeServer;
        private FakeColibriServer _scriptedServer;
        private UnansweredPort _unansweredPort;
        private readonly TestCleanup _cleanup = new TestCleanup();

        [UnitySetUp]
        public IEnumerator ReplaceTheConnection()
        {
            E2EServer.RequirePlainTcp("the servers here that speak another protocol, or none, are plain TCP; "
                + "TlsTests cover a server that does not speak TLS, and a client that does not");
            E2EServer.RequireReachable();
            yield return DestroyConnection();
        }

        [UnityTearDown]
        public IEnumerator RestoreTheConnection()
        {
            // Before the connection goes: a RemoteLogging left for the end of the frame could run
            // an Update after the connection is destroyed, and build a new one.
            _cleanup.Run();

            _fakeServer?.Dispose();
            _fakeServer = null;
            _scriptedServer?.Dispose();
            _scriptedServer = null;
            _unansweredPort?.Dispose();
            _unansweredPort = null;

            // Put the singleton back the way the rest of the suite expects to find it: pointed at
            // the real server and freshly built, so the next fixture's Instance does not hand back
            // a connection still trying to reach a listener this test has closed.
            yield return DestroyConnection();
            E2EServer.Configure();

            LogAssert.ignoreFailingMessages = false;
        }

        /// <summary>
        /// A real 1.x server heartbeats <c>"\0\0\0h\0"</c> at every client every 100 ms, handshaked
        /// or not, and does not hang up on a handshake it cannot parse. Read as v3 framing those
        /// five bytes declare a 1.74 GB frame - past the reader's 5 MB ceiling - so the reader
        /// throws on the first beat of every attempt, and no attempt ever decodes anything.
        /// </summary>
        [UnityTest]
        public IEnumerator AServerSpeakingV1FramingIsReportedAsASuspectedMismatch()
        {
            // Every attempt fails on purpose and logs a decode error as it goes ("Invalid frame
            // length: 1744830464" - the 1.74 GB those five bytes declare). Set here rather than in
            // [UnitySetUp], which the framework's own per-test reset lands after.
            IgnoreTheExpectedFailures();

            _fakeServer = FakeV1Server.Start();
            yield return PointConnectionAt(_fakeServer.Port);

            // Three attempts, 500 ms and then 1000 ms apart - about 1.5 s - plus room for a loaded
            // batchmode editor to get round to them. The backoff only grows because none of these
            // sessions counts as a connection; see TheBackoffGrowsAgainstAServerThatAcceptsAndHangsUp.
            yield return E2EServer.WaitUntil(
                () => Connection.SuspectedProtocolMismatch != null,
                "The client never suspected a protocol mismatch against a server speaking v1 framing",
                20f);

            Assert.That(Connection.SuspectedProtocolMismatch, Does.Contain("protocol mismatch"));
            Assert.That(Connection.SuspectedProtocolMismatch, Does.Contain(WebServerConnection.ClientVersion));

            // A suspicion is not a finding: it reads the same as an address pointing at something
            // that is not colibri-server at all, so it must not become terminal.
            Assert.That(Connection.Status, Is.Not.EqualTo(ConnectionStatus.ProtocolMismatch),
                "A guess must not settle into the status reserved for a refusal the server actually sent");
            Assert.That(Connection.ProtocolMismatchReason, Is.Null,
                "ProtocolMismatchReason is for what the server said, and this server said nothing");
        }

        /// <summary>
        /// The counterpart, and the reason the hint is scoped to sessions that got past the
        /// handshake: a server that is simply not running fails every attempt without decoding a
        /// frame either, and blaming that on the protocol version would send people looking in
        /// entirely the wrong place.
        /// </summary>
        [UnityTest]
        public IEnumerator AServerThatIsNotRunningIsNotReportedAsAMismatch()
        {
            IgnoreTheExpectedFailures();

            yield return PointConnectionAt(FakeV1Server.FindClosedPort());

            // Comfortably past the three attempts the hint would need.
            yield return E2EServer.Settle(8f);

            Assert.That(Connection.SuspectedProtocolMismatch, Is.Null,
                "'Connection refused' is a server that is switched off, not a version problem");
            Assert.That(Connection.Status, Is.Not.EqualTo(ConnectionStatus.Connected));
        }


        /*
         *  What counts as a connection.
         *
         *  Connected used to mean "the TCP connection opened and the handshake went out". Anything
         *  accepts a connection - a 1.x server, a port that is not Colibri at all - so every doomed
         *  attempt counted as a success: it reset the backoff, which therefore never grew past
         *  500 ms, fired OnConnected and flushed the queued messages into a session about to fail.
         *  Against a 1.x server the client flapped between Connected and Disconnected about 1.6
         *  times a second. It now means the server has sent a frame.
         */

        /// <summary>
        /// A server that takes the connection, reads the handshake and hangs up without a word.
        /// None of those sessions is a connection, so the backoff keeps doubling and the third one
        /// in a row is enough to suspect a mismatch.
        /// </summary>
        [UnityTest]
        public IEnumerator TheBackoffGrowsAgainstAServerThatAcceptsAndHangsUp()
        {
            IgnoreTheExpectedFailures();

            _scriptedServer = FakeColibriServer.Start(FakeColibriServer.Behaviour.HangUpAfterHandshake);

            var onConnected = 0;
            var everConnected = false;
            ConnectionTo(_scriptedServer.Port).OnConnected += () => onConnected++;

            var sessionsWhenSuspected = -1;
            yield return E2EServer.WaitUntil(() =>
                {
                    everConnected |= Connection.Status == ConnectionStatus.Connected;
                    if (sessionsWhenSuspected < 0 && Connection.SuspectedProtocolMismatch != null)
                        sessionsWhenSuspected = _scriptedServer.Accepted;
                    return _scriptedServer.Accepted >= 4;
                },
                "The client stopped retrying a server that hangs up",
                20f);

            Assert.That(sessionsWhenSuspected, Is.EqualTo(3),
                "The mismatch should be suspected after the third session in a row ended without a frame, and not before");

            // Lower bounds only: a delay never fires early, but a loaded editor can make it late.
            // The 50 ms of slack is for timer granularity, not for scheduling.
            var accepted = _scriptedServer.AcceptTimes;
            Assert.That(accepted[1] - accepted[0], Is.GreaterThanOrEqualTo(450), "first backoff");
            Assert.That(accepted[2] - accepted[1], Is.GreaterThanOrEqualTo(950),
                "The backoff did not grow: a session the server never spoke on was counted as a connection and reset it");
            Assert.That(accepted[3] - accepted[2], Is.GreaterThanOrEqualTo(1950), "third backoff");

            Assert.That(onConnected, Is.Zero, "OnConnected fired for a session on which the server never said a word");
            Assert.That(everConnected, Is.False, "Status reported Connected for a session on which the server never said a word");
        }

        /// <summary>
        /// The other way to never say a word: accept and then stay silent. Nothing would ever end
        /// such a session once Connected waits for the server to speak, so the heartbeat watchdog
        /// covers the time before the first frame as well.
        /// </summary>
        [UnityTest]
        public IEnumerator AServerThatAcceptsButNeverSpeaksIsDroppedWithoutCountingAsConnected()
        {
            IgnoreTheExpectedFailures();

            _scriptedServer = FakeColibriServer.Start(FakeColibriServer.Behaviour.Silent);

            var onConnected = 0;
            var everConnected = false;
            ConnectionTo(_scriptedServer.Port).OnConnected += () => onConnected++;

            // The watchdog's 2 s, the 500 ms backoff, and room for a loaded editor.
            yield return E2EServer.WaitUntil(() =>
                {
                    everConnected |= Connection.Status == ConnectionStatus.Connected;
                    return _scriptedServer.Accepted >= 2;
                },
                "The client never gave up on a server that accepted the connection and then said nothing",
                15f);

            var accepted = _scriptedServer.AcceptTimes;
            Assert.That(accepted[1] - accepted[0], Is.GreaterThanOrEqualTo(2000 + 450),
                "The silent session should last the watchdog's 2 s, followed by the 500 ms backoff");
            Assert.That(onConnected, Is.Zero, "OnConnected fired for a server that never said a word");
            Assert.That(everConnected, Is.False, "Status reported Connected for a server that never said a word");
        }

        /// <summary>
        /// "Consecutive" has to mean what it says. The count used to be updated only when a session
        /// ended cleanly or on an undecodable frame, so a session ended by a reset or by the
        /// watchdog neither counted nor cleared anything, and the suspicion outlived the server
        /// that caused it. Now the first decoded frame clears both at once, and every session that
        /// ends without one counts, however it ends, unless the watchdog ended it: see
        /// <see cref="SessionsTheWatchdogEndsBeforeAnyFrameAreReportedAsSilenceNotAsAMismatch"/>.
        /// </summary>
        [UnityTest]
        public IEnumerator AnyDecodedFrameClearsTheSuspicionAndTheCountAtOnce()
        {
            IgnoreTheExpectedFailures();

            _scriptedServer = FakeColibriServer.Start(FakeColibriServer.Behaviour.HangUpAfterHandshake);
            yield return PointConnectionAt(_scriptedServer.Port);

            yield return E2EServer.WaitUntil(() => Connection.SuspectedProtocolMismatch != null,
                "Three sessions that ended without a frame were not enough to suspect a mismatch", 20f);

            // The server comes good before the next attempt, which is 2 s of backoff away.
            _scriptedServer.Mode = FakeColibriServer.Behaviour.Heartbeat;
            yield return E2EServer.WaitUntil(() => Connection.Status == ConnectionStatus.Connected,
                "The client never connected once the server started heartbeating", 10f);

            // Cleared by the frame itself, while the session is still open.
            Assert.That(Connection.SuspectedProtocolMismatch, Is.Null,
                "The suspicion outlived the first frame the server sent");
            Assert.That(Connection.ConsecutiveEarlyFrameFailures, Is.Zero);

            // Then the session ends the hard way - a reset, which the client sees as a
            // SocketException - and the server goes back to hanging up.
            _scriptedServer.Mode = FakeColibriServer.Behaviour.HangUpAfterHandshake;
            _scriptedServer.ResetConnections();

            // Counted from zero again: two in a row is not yet a suspicion...
            yield return E2EServer.WaitUntil(() => Connection.ConsecutiveEarlyFrameFailures == 2,
                "The sessions after the reset were not counted", 10f);
            Assert.That(Connection.SuspectedProtocolMismatch, Is.Null,
                "Two failures after a session that decoded frames were counted as more than two");

            // ...and the third is.
            yield return E2EServer.WaitUntil(() => Connection.SuspectedProtocolMismatch != null,
                "The third session in a row without a frame did not raise the suspicion again", 10f);
            Assert.That(Connection.ConsecutiveEarlyFrameFailures, Is.EqualTo(3));
        }

        /// <summary>
        /// A port that accepts and then says nothing, until the watchdog ends the session: a proxy
        /// or port forwarding whose backend is down, a captive portal, a firewall, or a server that
        /// does not answer. Not a protocol mismatch: a 1.x server heartbeats from the moment it
        /// accepts, and a server with TLS on closes the connection. These sessions used to count
        /// towards the suspected mismatch, so an outage was reported as a version problem.
        /// </summary>
        [UnityTest]
        public IEnumerator SessionsTheWatchdogEndsBeforeAnyFrameAreReportedAsSilenceNotAsAMismatch()
        {
            IgnoreTheExpectedFailures();

            _scriptedServer = FakeColibriServer.Start(FakeColibriServer.Behaviour.Silent);
            var connection = ConnectionTo(_scriptedServer.Port);

            var silenceWarnings = 0;
            var failures = 0;
            void OnLog(string message, string stackTrace, LogType type)
            {
                if (type == LogType.Warning && message.Contains("were accepted, but nothing was received on any of them"))
                    Interlocked.Increment(ref silenceWarnings);
                if (Regex.IsMatch(message, @"^Colibri: connection to \S+ failed \("))
                    Interlocked.Increment(ref failures);
            }

            Application.logMessageReceivedThreaded += OnLog;
            _cleanup.Add(() => Application.logMessageReceivedThreaded -= OnLog);

            // Three silent sessions of 2 s each, 500 ms and 1000 ms apart, and the fourth accepted
            // 2 s after the third ended.
            yield return E2EServer.WaitUntil(() => _scriptedServer.Accepted >= 4,
                "The client stopped retrying a server that accepts the connection and then says nothing", 20f);

            Assert.That(connection.SuspectedProtocolMismatch, Is.Null,
                "Sessions on which nothing was received before the watchdog ended them were reported as a suspected protocol mismatch");
            Assert.That(connection.ConsecutiveEarlyFrameFailures, Is.Zero);
            Assert.That(silenceWarnings, Is.EqualTo(1),
                "Three silent sessions in a row should be named as such, once");
            Assert.That(failures, Is.Zero,
                "A session the watchdog dropped was also logged as a failed connection, after the watchdog had said why");
            Assert.That(connection.Status, Is.Not.EqualTo(ConnectionStatus.ProtocolMismatch));
        }

        /// <summary>
        /// A silent session between two that end without a frame breaks the row either way, so
        /// each warning means what it says: that many sessions in a row ended that way.
        /// </summary>
        [UnityTest]
        public IEnumerator ASilentSessionBreaksTheRowOfSessionsThatEndWithoutAFrame()
        {
            IgnoreTheExpectedFailures();

            _scriptedServer = FakeColibriServer.Start(FakeColibriServer.Behaviour.HangUpAfterHandshake);
            var connection = ConnectionTo(_scriptedServer.Port);

            yield return E2EServer.WaitUntil(() => connection.ConsecutiveEarlyFrameFailures == 2,
                "Two sessions that ended without a frame were not counted", 10f);

            // The third session is silent, and the watchdog ends it.
            _scriptedServer.Mode = FakeColibriServer.Behaviour.Silent;
            yield return E2EServer.WaitUntil(() => _scriptedServer.Accepted >= 3,
                "The client did not try again after two sessions that ended without a frame", 10f);
            _scriptedServer.Mode = FakeColibriServer.Behaviour.HangUpAfterHandshake;

            yield return E2EServer.WaitUntil(() => connection.ConsecutiveEarlyFrameFailures == 1,
                "The session after the silent one was not counted from one again", 15f);
            Assert.That(connection.SuspectedProtocolMismatch, Is.Null,
                "A silent session was counted as a third session that ended without a frame");
        }

        /// <summary>
        /// The suspicion is raised on the session loop's thread, and the console line has to exist
        /// by the time the main thread can see <see cref="WebServerConnection.SuspectedProtocolMismatch"/>.
        /// It used to be published first and logged after: a test that ended as soon as the value
        /// appeared had the error arrive in its TearDown, outside the scope that ignored it.
        /// </summary>
        [UnityTest]
        public IEnumerator TheSuspicionIsLoggedBeforeItIsReported()
        {
            IgnoreTheExpectedFailures();

            _scriptedServer = FakeColibriServer.Start(FakeColibriServer.Behaviour.HangUpAfterHandshake);
            var connection = ConnectionTo(_scriptedServer.Port);

            // Read on the logging thread, at the moment the line is logged.
            var reportedWhenLogged = "(never logged)";
            void OnLog(string message, string stackTrace, LogType type)
            {
                if (message.Contains("connections in a row were accepted"))
                    reportedWhenLogged = connection.SuspectedProtocolMismatch;
            }

            Application.logMessageReceivedThreaded += OnLog;
            _cleanup.Add(() => Application.logMessageReceivedThreaded -= OnLog);

            yield return E2EServer.WaitUntil(() => connection.SuspectedProtocolMismatch != null,
                "Three sessions that ended without a frame were not enough to suspect a mismatch", 20f);

            Assert.That(reportedWhenLogged, Is.Null,
                "The suspicion was visible before its console line was logged, or the line came after it was seen");
        }

        /*
         *  An address nothing answers on.
         */

        /// <summary>
        /// A wrong address, or a server on another network: nothing refuses the connection, and
        /// nothing answers it. The attempt used to stay in Connecting for the OS's SYN timeout -
        /// about two minutes on a Quest - without a retry or a word in the log. It is given up after
        /// 5 s now, says why, and the backoff carries on as after any other failed attempt.
        /// </summary>
        [UnityTest]
        public IEnumerator AnAttemptNothingAnswersIsGivenUpAfterFiveSecondsAndRetried()
        {
            IgnoreTheExpectedFailures();

            _unansweredPort = new UnansweredPort();
            if (!_unansweredPort.Hangs)
                Assert.Ignore("This system refuses a connection to a full backlog instead of leaving it unanswered, "
                    + "so there is no port here that never answers. Check the timeout by hand: an unreachable server address "
                    + "should leave Connecting after 5 s.");

            var started = Time.realtimeSinceStartup;
            ConnectionTo(_unansweredPort.Port);
            Assert.That(Connection.Status, Is.EqualTo(ConnectionStatus.Connecting));

            yield return E2EServer.WaitUntil(() => Connection.LastConnectFailure != null,
                "The attempt to reach a port that never answers was never given up", 15f);
            var gaveUpAfter = Time.realtimeSinceStartup - started;

            // Refused after all, only later than the probe waited for: not the case under test.
            if (Connection.LastConnectFailure.Contains(nameof(SocketError.ConnectionRefused)))
                Assert.Ignore($"The port refused the attempt after {gaveUpAfter:0.0} s "
                    + "instead of leaving it unanswered, so there is no port here that never answers. Check the timeout by hand: "
                    + "an unreachable server address should leave Connecting after 5 s.");

            Assert.That(gaveUpAfter, Is.GreaterThanOrEqualTo(4.5f).And.LessThan(10f),
                "The attempt should be given up after the connect timeout of 5 s");
            Assert.That(Connection.LastConnectFailure, Does.Contain($":{_unansweredPort.Port} did not answer within 5 s"));

            // The failure is recorded where the attempt fails, and the status only changes a moment
            // later, as the connection loop unwinds - not necessarily before the frame that saw it.
            yield return E2EServer.WaitUntil(() => Connection.Status != ConnectionStatus.Connecting,
                "The client stayed in Connecting after giving up the attempt", 2f);

            yield return E2EServer.WaitUntil(() => Connection.Status == ConnectionStatus.Reconnecting,
                "The client did not try again after giving up an attempt", 5f);

            // Nothing was accepted, so this says nothing about protocol versions.
            Assert.That(Connection.SuspectedProtocolMismatch, Is.Null);
            Assert.That(Connection.ConsecutiveEarlyFrameFailures, Is.Zero);
        }


        /*
         *  A refusal the server actually sent: final, and it has to look final to user code too.
         */

        /// <summary>
        /// A newer server refuses this client in its very first frame - colibri-server says nothing
        /// at all to a client before it has accepted its handshake. That is never a connection,
        /// is not retried, and leaves nothing waiting: OnDisconnected used to never fire for it,
        /// the Connected task stayed pending for good, and every later send awaited it forever.
        /// </summary>
        [UnityTest]
        public IEnumerator ARefusalInTheFirstFrameIsFinalAndLeavesNothingWaiting()
        {
            IgnoreTheExpectedFailures();

            _scriptedServer = FakeColibriServer.Start(FakeColibriServer.Behaviour.Refuse);

            var onConnected = 0;
            var onDisconnected = 0;
            var everConnected = false;
            var connection = ConnectionTo(_scriptedServer.Port);
            connection.OnConnected += () => onConnected++;
            connection.OnDisconnected += () => onDisconnected++;

            var refusalWarnings = 0;
            Application.LogCallback countRefusalWarnings = (message, stackTrace, type) =>
            {
                if (type == LogType.Warning && message.Contains("the server refused this client's protocol version, so nothing is sent any more"))
                    Interlocked.Increment(ref refusalWarnings);
            };

            Application.logMessageReceivedThreaded += countRefusalWarnings;
            _cleanup.Add(() => Application.logMessageReceivedThreaded -= countRefusalWarnings);

            // Sent in the frame the connection was created, so it is waiting in the queue
            // when the refusal arrives.
            var queuedBefore = connection.SendCommandAsync("refusal-test", "broadcast::int", 1);
            var awaitingConnected = connection.Connected;

            yield return E2EServer.WaitUntil(() =>
                {
                    everConnected |= Connection.Status == ConnectionStatus.Connected;
                    return Connection.Status == ConnectionStatus.ProtocolMismatch;
                },
                "The client never settled into ProtocolMismatch after the server refused it", 10f);

            Assert.That(Connection.ServerVersion, Is.EqualTo("3"));
            Assert.That(Connection.ProtocolMismatchReason, Does.Contain("Unsupported protocol version"));

            Assert.That(queuedBefore.IsCompleted, Is.True, "A message queued before the refusal is still waiting for a connection that will never come");
            Assert.That(queuedBefore.Result, Is.False, "A message that was never sent was reported as sent");
            Assert.That(awaitingConnected.IsCanceled, Is.True, "`await Connected` would wait forever after a refusal");
            Assert.That(Connection.Connected.IsCanceled, Is.True, "`await Connected` would wait forever after a refusal");

            // Sends after the refusal complete at once, as dropped, and say so once between them.
            var sentAfter = Connection.SendCommandAsync("refusal-test", "broadcast::int", 2);
            Assert.That(sentAfter.IsCompleted, Is.True, "A send after the refusal is waiting for a connection that will never come");
            Assert.That(sentAfter.Result, Is.False);
            Sync.Send("refusal-test", 3);

            // Long enough for a retry to have happened, if there were going to be one.
            yield return E2EServer.Settle(1.5f);

            Assert.That(_scriptedServer.Accepted, Is.EqualTo(1), "A refusal is final, but the client tried again");
            Assert.That(Connection.Status, Is.EqualTo(ConnectionStatus.ProtocolMismatch));
            Assert.That(onConnected, Is.Zero, "A refusal in the first frame was reported as a connection");
            Assert.That(everConnected, Is.False, "A refusal in the first frame was reported as a connection");
            Assert.That(onDisconnected, Is.Zero, "OnDisconnected without an OnConnected before it");
            Assert.That(refusalWarnings, Is.EqualTo(1), "Dropping sends after a refusal should be said exactly once");
        }

        /// <summary>
        /// The same refusal from a server that heartbeats a connection before it has read the
        /// handshake, as colibri-server used to: by the time the refusal arrives the session has
        /// counted as connected. It has to be just as final, and the OnConnected it raised still
        /// gets its OnDisconnected, after it.
        /// </summary>
        [UnityTest]
        public IEnumerator ARefusalAfterTheSessionCountedAsConnectedIsFinalToo()
        {
            IgnoreTheExpectedFailures();

            _scriptedServer = FakeColibriServer.Start(FakeColibriServer.Behaviour.HeartbeatThenRefuse);

            var events = new System.Collections.Generic.List<string>();
            var connection = ConnectionTo(_scriptedServer.Port);
            connection.OnConnected += () => events.Add("connected");
            connection.OnDisconnected += () => events.Add("disconnected");

            yield return E2EServer.WaitUntil(() => Connection.Status == ConnectionStatus.ProtocolMismatch,
                "The client never settled into ProtocolMismatch after the server refused it", 10f);

            Assert.That(Connection.ServerVersion, Is.EqualTo("3"));
            Assert.That(Connection.Connected.IsCanceled, Is.True, "`await Connected` would wait forever after a refusal");

            var sentAfter = Connection.SendCommandAsync("refusal-test", "broadcast::int", 2);
            Assert.That(sentAfter.IsCompleted && !sentAfter.Result, Is.True,
                "A send after the refusal is waiting for a connection that will never come");

            // Long enough for a retry to have happened, if there were going to be one.
            yield return E2EServer.Settle(1.5f);

            Assert.That(_scriptedServer.Accepted, Is.EqualTo(1), "A refusal is final, but the client tried again");
            Assert.That(Connection.Status, Is.EqualTo(ConnectionStatus.ProtocolMismatch));
            Assert.That(events, Is.EqualTo(new[] { "connected", "disconnected" }),
                "The session the refusal ended was connected, so it should end with OnDisconnected");
        }

        /// <summary>
        /// RemoteLogging against a server that refused this client. Its one send in flight used to
        /// wait forever, and then - once sends failed instead - every line was put back after its
        /// send failed: either way its queue grew with every line logged, for the rest of the run.
        /// </summary>
        [UnityTest]
        public IEnumerator RemoteLoggingStopsCollectingOnceTheServerHasRefusedThisClient()
        {
            IgnoreTheExpectedFailures();

            _scriptedServer = FakeColibriServer.Start(FakeColibriServer.Behaviour.Refuse);
            yield return PointConnectionAt(_scriptedServer.Port);

            var loggingObject = _cleanup.Add(new GameObject("remote-logging"));
            var logging = loggingObject.AddComponent<RemoteLogging>();

            yield return E2EServer.WaitUntil(() => Connection.Status == ConnectionStatus.ProtocolMismatch,
                "The client never settled into ProtocolMismatch after the server refused it", 10f);

            for (var i = 0; i < 200; i++)
                Debug.Log($"remote logging after a refusal, line {i}");

            // Past RemoteLogging's one-second send interval, twice.
            yield return E2EServer.Settle(2.5f);

            Assert.That(logging.BufferedLineCount, Is.Zero,
                "RemoteLogging is still collecting lines for a server that will never take them");
        }

        /// <summary>
        /// OnConnected and OnDisconnected come in pairs. OnDisconnected used to be raised for every
        /// attempt that failed, connected or not - against a server that is down, twice a second.
        /// </summary>
        [UnityTest]
        public IEnumerator OnDisconnectedIsRaisedOnceForEveryOnConnected()
        {
            IgnoreTheExpectedFailures();

            _scriptedServer = FakeColibriServer.Start(FakeColibriServer.Behaviour.Heartbeat);

            var onConnected = 0;
            var onDisconnected = 0;
            var connection = ConnectionTo(_scriptedServer.Port);
            connection.OnConnected += () => onConnected++;
            connection.OnDisconnected += () => onDisconnected++;

            yield return E2EServer.WaitUntil(() => onConnected == 1, "The client never connected", 10f);

            // The connection drops, and the attempts after it fail.
            _scriptedServer.Mode = FakeColibriServer.Behaviour.HangUpAfterHandshake;
            _scriptedServer.ResetConnections();

            yield return E2EServer.WaitUntil(() => _scriptedServer.Accepted >= 3,
                "The client stopped retrying after its connection dropped", 10f);
            yield return null;

            Assert.That(onConnected, Is.EqualTo(1));
            Assert.That(onDisconnected, Is.EqualTo(1),
                "OnDisconnected should be raised once for the connection that ended, and not for the attempts that failed after it");
        }

        /// <summary>
        /// A handler of OnConnected or OnDisconnected with a bug in it. The exception used to leave
        /// Update, skipping every handler after it - Sync's re-request of the models after a
        /// reconnect is one - and the rest of that frame's work.
        /// </summary>
        [UnityTest]
        public IEnumerator AThrowingConnectionEventHandlerDoesNotStopTheOthers()
        {
            _scriptedServer = FakeColibriServer.Start(FakeColibriServer.Behaviour.Heartbeat);

            var connected = 0;
            var disconnected = 0;
            var connection = ConnectionTo(_scriptedServer.Port);
            connection.OnConnected += () => throw new System.InvalidOperationException("OnConnected handler bug");
            connection.OnConnected += () => connected++;
            connection.OnDisconnected += () => throw new System.InvalidOperationException("OnDisconnected handler bug");
            connection.OnDisconnected += () => disconnected++;

            LogAssert.Expect(LogType.Error, new Regex("^Colibri: a handler of OnConnected threw an exception"));
            yield return E2EServer.WaitUntil(() => connected == 1,
                "A throwing OnConnected handler kept the next one from being called", 10f);

            // The next attempt finds a server that never speaks, so nothing connects again
            // while the test is looking.
            _scriptedServer.Mode = FakeColibriServer.Behaviour.Silent;
            LogAssert.Expect(LogType.Error, new Regex("^Colibri: a handler of OnDisconnected threw an exception"));
            _scriptedServer.ResetConnections();

            yield return E2EServer.WaitUntil(() => disconnected == 1,
                "A throwing OnDisconnected handler kept the next one from being called", 10f);
        }

        /// <summary>The counterpart: a server that heartbeats is connected, once, and stays so.</summary>
        [UnityTest]
        public IEnumerator AServerThatSpeaksCountsAsConnected()
        {
            _scriptedServer = FakeColibriServer.Start(FakeColibriServer.Behaviour.Heartbeat);

            var onConnected = 0;
            ConnectionTo(_scriptedServer.Port).OnConnected += () => onConnected++;

            yield return E2EServer.WaitUntil(() => Connection.Status == ConnectionStatus.Connected && onConnected == 1,
                "The client never counted a server sending heartbeats as connected", 10f);

            yield return E2EServer.Settle(0.5f);

            Assert.That(Connection.Status, Is.EqualTo(ConnectionStatus.Connected), "A heartbeating server was dropped");
            Assert.That(_scriptedServer.Accepted, Is.EqualTo(1));
            Assert.That(onConnected, Is.EqualTo(1));
        }


        /*
         *  Driving the connection singleton
         */

        private static WebServerConnection Connection => WebServerConnection.Instance;

        /// <summary>
        /// Failing to connect is the subject of these tests, so the logs it produces are expected
        /// output rather than an unhandled error. Must be called from the test body: the framework
        /// resets this per test, after <c>[UnitySetUp]</c> has run.
        /// </summary>
        private static void IgnoreTheExpectedFailures() => LogAssert.ignoreFailingMessages = true;

        private static IEnumerator PointConnectionAt(int tcpPort)
        {
            ConnectionTo(tcpPort);
            yield return null;
        }

        /// <summary>
        /// Points a fresh connection at the given port and hands it back without waiting a frame.
        /// A test that subscribes to its events has to do it here: the connection raises them from
        /// its Update, and against a local server the first one can be due by the next frame.
        /// </summary>
        private static WebServerConnection ConnectionTo(int tcpPort)
        {
            E2EServer.Configure();
            var config = ColibriConfig.Load();
            config.TcpServerPort = tcpPort;

            // OnEnable is what reads the config, so the port only takes effect on a fresh
            // instance - which touching Instance after the teardown above creates.
            var connection = Connection;
            Assert.That(connection, Is.Not.Null);
            return connection;
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


        /// <summary>
        /// The 1.x wire behaviour that matters here, and nothing else: accept, then heartbeat
        /// <c>"\0\0\0h\0"</c> every 100 ms without ever reading what the client sent. A real 1.x
        /// server logs the unparseable handshake and keeps the connection open, which is what
        /// makes this detectable at all.
        /// </summary>
        private sealed class FakeV1Server : System.IDisposable
        {
            private static readonly byte[] V1Heartbeat = { 0, 0, 0, (byte)'h', 0 };

            private readonly TcpListener _listener;
            private readonly CancellationTokenSource _lifetime = new CancellationTokenSource();

            public int Port { get; }

            private FakeV1Server(TcpListener listener, int port)
            {
                _listener = listener;
                Port = port;
            }

            public static FakeV1Server Start()
            {
                var listener = new TcpListener(IPAddress.Loopback, 0);
                listener.Start();
                var port = ((IPEndPoint)listener.LocalEndpoint).Port;

                var server = new FakeV1Server(listener, port);
                _ = server.AcceptLoop();
                return server;
            }

            /// <summary>A port nothing is listening on: bound to reserve it, then released.</summary>
            public static int FindClosedPort()
            {
                var listener = new TcpListener(IPAddress.Loopback, 0);
                listener.Start();
                var port = ((IPEndPoint)listener.LocalEndpoint).Port;
                listener.Stop();
                return port;
            }

            private async Task AcceptLoop()
            {
                while (!_lifetime.IsCancellationRequested)
                {
                    TcpClient client;
                    try
                    {
                        client = await _listener.AcceptTcpClientAsync().ConfigureAwait(false);
                    }
                    catch
                    {
                        return; // listener stopped
                    }

                    _ = HeartbeatLoop(client);
                }
            }

            private async Task HeartbeatLoop(TcpClient client)
            {
                using (client)
                {
                    var stream = client.GetStream();
                    while (!_lifetime.IsCancellationRequested)
                    {
                        try
                        {
                            await stream.WriteAsync(V1Heartbeat, 0, V1Heartbeat.Length, _lifetime.Token)
                                .ConfigureAwait(false);
                            await Task.Delay(100, _lifetime.Token).ConfigureAwait(false);
                        }
                        catch
                        {
                            return; // the client dropped us, which is the expected ending
                        }
                    }
                }
            }

            public void Dispose()
            {
                _lifetime.Cancel();
                _listener.Stop();
                _lifetime.Dispose();
            }
        }
    }
}
