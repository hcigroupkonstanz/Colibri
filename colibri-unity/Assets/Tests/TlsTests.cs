using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text.RegularExpressions;
using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Setup;
using HCIKonstanz.Colibri.Synchronization;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;
using Object = UnityEngine.Object;

namespace HCIKonstanz.Colibri.E2E
{
    /// <summary>
    /// The TCP connection with TLS, against a colibri-server with TLS turned on: the one in
    /// <c>colibri-unity/tls-test-server</c>, which run-tests.mjs starts next to the plain test
    /// server. Its certificate is self-signed, the case a server of one's own usually has, so these
    /// cover which certificates are accepted, what a client and a server that disagree about TLS
    /// say, and that messages, models and reconnects work the same inside TLS. A certificate from a
    /// trusted authority takes the system's own check, which only a real deployment exercises.
    ///
    /// Like <see cref="ReconnectTests"/>, these point the connection singleton at a server of their
    /// own, so they own its lifetime and put it back afterwards.
    /// </summary>
    public class TlsTests
    {
        /// <summary>Some other certificate's fingerprint: the SHA-256 of "abc".</summary>
        private const string OtherSha256 =
            "BA:78:16:BF:8F:01:CF:EA:41:41:40:DE:5D:AE:22:23:B0:03:61:A3:96:17:7A:9C:B4:10:FF:61:F2:00:15:AD";

        private static readonly Regex Attempt = new Regex(@"^Colibri: connecting to \S+ \(TLS\)$");
        private static readonly Regex UntrustedAccepted = new Regex(@"^Colibri: accepted the certificate of \S+ although .*'Allow self-signed certificate' is on", RegexOptions.Singleline);
        private static readonly Regex Rejected = new Regex(@"^Colibri: rejected the certificate of ", RegexOptions.Singleline);
        private static readonly Regex NoTlsAnswer = new Regex(@"^Colibri: \S+ (accepted the connection but )?did not answer the TLS handshake", RegexOptions.Singleline);
        private static readonly Regex Unanswered = new Regex(@"^Colibri: 3 connections in a row to \S+ were accepted, but nothing was received on any of them: each was closed by the other end or dropped after 2 s of silence\.");
        private static readonly Regex Failed = new Regex(@"^Colibri: connection to \S+ failed \(");

        private readonly List<(LogType Type, string Message, double Seconds)> _log = new List<(LogType, string, double)>();
        private readonly Stopwatch _clock = Stopwatch.StartNew();
        private TcpProxy _proxy;
        private TcpPeer _peer;
        private readonly TestCleanup _cleanup = new TestCleanup();

        private static WebServerConnection Connection => WebServerConnection.Instance;

        [UnitySetUp]
        public IEnumerator ReplaceTheConnection()
        {
            E2EServer.RequireTlsServer();
            yield return DestroyConnection();

            // NUnit runs every test of a fixture on the same instance: without this, a test would
            // see the earlier tests' attempts and warnings as its own.
            lock (_log)
                _log.Clear();
            Application.logMessageReceivedThreaded += Record;
        }

        [UnityTearDown]
        public IEnumerator RestoreTheConnection()
        {
            _cleanup.Run();
            Application.logMessageReceivedThreaded -= Record;

            _peer?.Dispose();
            _peer = null;
            _proxy?.Dispose();
            _proxy = null;

            yield return DestroyConnection();
            E2EServer.Configure();

            LogAssert.ignoreFailingMessages = false;
        }


        /*
         *  Which certificates are accepted
         */

        /// <summary>
        /// "Allow self-signed certificate" accepts a certificate the system does not trust: the
        /// connection is encrypted, which is what a network that blocks plain TCP asks for. That
        /// nothing checked whose server it is gets said, once per session rather than at every
        /// reconnect, with the fingerprint that would pin it.
        /// </summary>
        [UnityTest]
        public IEnumerator ASelfSignedCertificateIsAcceptedWhenAllowedAndThatIsSaidOncePerSession()
        {
            ConnectionTo(allowSelfSigned: true, pin: "");
            yield return WaitForConnection();

            Assert.That(Connection.UsesTls, Is.True);
            Assert.That(Normalized(Connection.ServerCertificateSha256), Is.EqualTo(E2EServer.TlsCertificateSha256));
            Assert.That(Connection.CertificateAcceptance, Does.StartWith("not trusted"));
            Assert.That(Logged(LogType.Warning, UntrustedAccepted).Length, Is.EqualTo(1));
            Assert.That(Normalized(Logged(LogType.Warning, UntrustedAccepted)[0]), Does.Contain(E2EServer.TlsCertificateSha256),
                "The warning should give the fingerprint that would pin this certificate");
            Assert.That(Logged(LogType.Warning, UntrustedAccepted)[0], Does.Match(ProblemsUnder(E2EServer.Host)),
                "The warning should say what is wrong with the certificate under the configured server address, and nothing else");

            // A reconnect is the same session.
            Connection.CurrentSocket.Close();
            yield return E2EServer.WaitUntil(() => Connection.ConnectedSessions == 2 && Connection.Status == ConnectionStatus.Connected,
                "The client did not reconnect over TLS", 20f);

            Assert.That(Logged(LogType.Warning, UntrustedAccepted).Length, Is.EqualTo(1),
                "Accepting the same untrusted certificate again was said again at the reconnect");
        }

        /// <summary>
        /// A pinned certificate is accepted whether the system trusts it or not, and without a
        /// warning: it is exactly the certificate the configuration asked for.
        /// </summary>
        [UnityTest]
        public IEnumerator ThePinnedCertificateIsAcceptedWithoutBeingTrusted()
        {
            ConnectionTo(allowSelfSigned: false, pin: E2EServer.TlsCertificateSha256);
            yield return WaitForConnection();

            Assert.That(Connection.CertificateAcceptance, Does.StartWith("matches"));
            Assert.That(Logged(LogType.Warning, UntrustedAccepted), Is.Empty,
                "A pinned certificate is the one the configuration asked for; there is nothing to warn about");
        }

        /// <summary>
        /// By default only what the system trusts is accepted. A self-signed certificate is
        /// rejected with the reason and both ways to accept it, said as an error once, and the
        /// connection keeps being retried: the server may get another certificate at any time.
        /// </summary>
        [UnityTest]
        public IEnumerator ASelfSignedCertificateIsRejectedByDefaultWithTheReasonAndTheWaysToAcceptIt()
        {
            LogAssert.Expect(LogType.Error, new Regex(@"^Colibri: rejected the certificate of \S+: it is self-signed.*'Allow self-signed certificate'", RegexOptions.Singleline));

            ConnectionTo(allowSelfSigned: false, pin: "");

            // Three attempts, 500 ms and then 1000 ms apart.
            yield return E2EServer.WaitUntil(() => Logged(LogType.Log, Attempt).Length >= 3,
                "The client stopped retrying after the server's certificate was rejected", 20f);

            Assert.That(Connection.ConnectedSessions, Is.Zero, "A rejected certificate still connected");
            Assert.That(Logged(LogType.Error, Rejected).Length, Is.EqualTo(1),
                "A certificate rejected the same way at every attempt should be an error once, and only noted after that");
            Assert.That(Connection.LastConnectFailure, Does.Contain("it is self-signed"));
            Assert.That(Normalized(Connection.LastConnectFailure), Does.Contain(E2EServer.TlsCertificateSha256),
                "The reason should give the fingerprint that would pin this certificate");
        }

        /// <summary>A pin accepts exactly one certificate: the right server with another certificate is rejected, even with self-signed ones allowed.</summary>
        [UnityTest]
        public IEnumerator AnyOtherCertificateIsRejectedWhenOneIsPinned()
        {
            LogAssert.Expect(LogType.Error, new Regex(@"^Colibri: rejected the certificate of \S+: its SHA-256 fingerprint is [0-9A-F:]{95}, not the one in 'Server certificate SHA-256'"));

            ConnectionTo(allowSelfSigned: true, pin: OtherSha256);

            // Three attempts, so that the second rejection is in before the third starts.
            yield return E2EServer.WaitUntil(() => Logged(LogType.Log, Attempt).Length >= 3,
                "The client stopped retrying after the server's certificate was rejected", 20f);

            Assert.That(Connection.ConnectedSessions, Is.Zero, "A certificate other than the pinned one was accepted");
            Assert.That(Logged(LogType.Error, Rejected).Length, Is.EqualTo(1),
                "A certificate rejected the same way at every attempt should be an error once, and only noted after that");
        }


        /*
         *  A client and a server that disagree about TLS
         */

        /// <summary>
        /// "Server supports SSL/TLS" ticked, but the server does not have TLS on: the handshake is
        /// never answered. That is said as what it is, with both ways out, once - and the client
        /// keeps retrying with a growing backoff, so turning TLS on at the server is picked up.
        /// </summary>
        [UnityTest]
        public IEnumerator TlsAgainstAServerWithoutTlsSaysSoAndKeepsRetryingWithBackoff()
        {
            E2EServer.RequirePlainServer();
            LogAssert.Expect(LogType.Error, new Regex(
                @"^Colibri: \S+ (accepted the connection but )?did not answer the TLS handshake.*'Server supports SSL/TLS' is ticked in the Colibri configuration.*"
                + @"turn TLS on at the server \(TLS_CERT and TLS_KEY\), or untick the setting\. Retrying\.\.\.$", RegexOptions.Singleline));

            ConnectionTo(allowSelfSigned: true, pin: "", tcpPort: E2EServer.PlainTcpPort);

            // Up to the connect timeout per attempt, if the server waits for more of what it takes
            // to be a frame, plus 500 ms and 1000 ms of backoff.
            yield return E2EServer.WaitUntil(() => Logged(LogType.Log, Attempt).Length >= 3,
                "The client stopped retrying a server that does not answer the TLS handshake", 30f);

            var attempts = Times(LogType.Log, Attempt);
            var firstGap = attempts[1] - attempts[0];
            var secondGap = attempts[2] - attempts[1];
            Assert.That(secondGap - firstGap, Is.GreaterThanOrEqualTo(0.4),
                $"The backoff did not grow: the attempts were {firstGap:0.00} s and then {secondGap:0.00} s apart");

            Assert.That(Connection.ConnectedSessions, Is.Zero);
            Assert.That(Logged(LogType.Error, NoTlsAnswer).Length, Is.EqualTo(1),
                "A server without TLS should be named as such once, and only noted after that");
            Assert.That(Connection.LastConnectFailure, Does.Contain("did not answer the TLS handshake"));
        }

        /// <summary>
        /// The other way round: a client without TLS against a server with it. The server hangs up
        /// on it without a frame, which the client can only suspect the cause of; the suspicion now
        /// names TLS as well as the protocol version, and a proxy whose backend is down, which hangs
        /// up the same way.
        /// </summary>
        [UnityTest]
        public IEnumerator APlainClientAgainstATlsServerIsToldToTickTheTlsSetting()
        {
            LogAssert.Expect(LogType.Error, new Regex(
                @"connections in a row were accepted but ended before a single frame could be read.*If the server has TLS turned on, tick 'Server supports SSL/TLS'",
                RegexOptions.Singleline));

            E2EServer.Configure();
            var config = ColibriConfig.Load();
            config.TcpServerPort = E2EServer.TlsTcpPort;
            config.IsSSL = false;
            config.ServerCertificateSha256 = "";
            Assert.That(Connection, Is.Not.Null);

            yield return E2EServer.WaitUntil(() => Connection.SuspectedProtocolMismatch != null,
                "Three sessions against a TLS server without TLS raised no suspicion", 20f);

            Assert.That(Connection.SuspectedProtocolMismatch, Does.Contain("tick 'Server supports SSL/TLS'"));
            Assert.That(Connection.SuspectedProtocolMismatch, Does.Contain("If a proxy or port forwarding is in front of the server"));
            Assert.That(Connection.UsesTls, Is.False);
        }

        /// <summary>
        /// A TLS-terminating proxy whose backend is down: the TLS handshake completes, and then
        /// nothing comes. As without TLS, that is named as silence. It used to be reported as a
        /// suspected protocol mismatch, as an error.
        /// </summary>
        [UnityTest]
        public IEnumerator ALinkThatCompletesTheTlsHandshakeAndThenSendsNothingIsNotReportedAsAMismatch()
        {
            var server = _cleanup.Add(FakeColibriServer.Start(FakeColibriServer.Behaviour.Silent, useTls: true));
            ConnectionTo(allowSelfSigned: false, pin: TestTls.CertificateSha256, tcpPort: server.Port);

            // Three silent sessions of 2 s each, 500 ms and 1000 ms apart, and the fourth accepted
            // 2 s after the third ended.
            yield return E2EServer.WaitUntil(() => server.Accepted >= 4,
                "The client stopped retrying a link that completes the TLS handshake and then sends nothing", 20f);

            Assert.That(Connection.SuspectedProtocolMismatch, Is.Null,
                "A link that completed the TLS handshake and then sent nothing was reported as a suspected protocol mismatch");
            Assert.That(Logged(LogType.Warning, Unanswered).Length, Is.EqualTo(1),
                "Three silent sessions in a row should be named as such, once");
            Assert.That(Logged(LogType.Log, Failed), Is.Empty,
                "A session the watchdog dropped was also logged as a failed connection, after the watchdog had said why");
        }

        /// <summary>
        /// A TLS-terminating proxy whose backend refuses the connection: the TLS handshake completes,
        /// and then the proxy hangs up without a frame. Past a completed TLS handshake that is not a
        /// mismatch, so it is named with the silent links. It used to be reported as a suspected
        /// protocol mismatch, as an error that named only the server's version.
        /// </summary>
        [UnityTest]
        public IEnumerator ALinkThatCompletesTheTlsHandshakeAndThenHangsUpIsNotReportedAsAMismatch()
        {
            var server = _cleanup.Add(FakeColibriServer.Start(FakeColibriServer.Behaviour.HangUpAfterHandshake, useTls: true));
            ConnectionTo(allowSelfSigned: false, pin: TestTls.CertificateSha256, tcpPort: server.Port);

            // Three sessions, 500 ms and 1000 ms apart, and the fourth accepted 2 s after the third.
            yield return E2EServer.WaitUntil(() => server.Accepted >= 4,
                "The client stopped retrying a link that completes the TLS handshake and then hangs up", 20f);

            Assert.That(Connection.SuspectedProtocolMismatch, Is.Null,
                "A link that completed the TLS handshake and then hung up was reported as a suspected protocol mismatch");
            Assert.That(Connection.ConsecutiveEarlyFrameFailures, Is.Zero);
            Assert.That(Logged(LogType.Warning, Unanswered).Length, Is.EqualTo(1),
                "Three sessions in a row closed without a frame should be named as such, once");
        }

        /// <summary>
        /// The counterpart: a 1.x server behind a TLS-terminating proxy. The TLS handshake completes,
        /// and then the server's heartbeats arrive, which this client cannot decode. With TLS that is
        /// the one kind of session without a frame that still counts towards the suspicion.
        /// </summary>
        [UnityTest]
        public IEnumerator AnOutOfDateServerBehindATlsProxyIsStillSuspectedOfAMismatch()
        {
            // Every session ends on an "invalid frame from server" error, and the suspicion is one too.
            LogAssert.ignoreFailingMessages = true;

            var server = _cleanup.Add(FakeColibriServer.Start(FakeColibriServer.Behaviour.SpeakV1, useTls: true));
            ConnectionTo(allowSelfSigned: false, pin: TestTls.CertificateSha256, tcpPort: server.Port);

            yield return E2EServer.WaitUntil(() => Connection.SuspectedProtocolMismatch != null,
                "Three sessions with a 1.x server behind a TLS proxy raised no suspicion", 20f);

            Assert.That(Connection.SuspectedProtocolMismatch, Does.Contain("needs colibri-server >= 2.0.0"));
            Assert.That(Connection.SuspectedProtocolMismatch, Does.Not.Contain("tick 'Server supports SSL/TLS'"),
                "The client uses TLS already");
            Assert.That(Logged(LogType.Warning, Unanswered), Is.Empty);
        }


        /*
         *  Everything else, inside TLS
         */

        /// <summary>
        /// The frames are the same inside TLS: broadcasts both ways, one larger than a TLS record,
        /// and a model's request, its updates from the other client and its own.
        /// </summary>
        [UnityTest]
        public IEnumerator MessagesAndModelsGoBothWaysOverTls()
        {
            ConnectionTo(allowSelfSigned: false, pin: E2EServer.TlsCertificateSha256);
            yield return WaitForConnection();
            yield return ConnectPeer("tls-peer");

            // Unity -> peer.
            var outbound = E2EServer.Channel("tls-out");
            Sync.Send(outbound, "over tls");
            yield return _peer.Expect(outbound, "broadcast::string",
                frame => Assert.That(TcpPeer.Text(frame), Is.EqualTo("\"over tls\"")));

            // More than one 16 KB TLS record, in both directions.
            var large = new string('x', 200 * 1024);
            Sync.Send(outbound, large);
            yield return _peer.Expect(outbound, "broadcast::string",
                frame => Assert.That(TcpPeer.Text(frame), Is.EqualTo($"\"{large}\"")));

            // Peer -> Unity.
            var inbound = E2EServer.Channel("tls-in");
            var received = new List<string>();
            Action<string> onString = received.Add;
            Sync.Receive(inbound, onString);
            _cleanup.Add(() => Sync.Unregister(inbound, onString));

            _peer.Send(inbound, "broadcast::string", "\"back over tls\"");
            _peer.Send(inbound, "broadcast::string", $"\"{large}\"");

            yield return E2EServer.WaitUntil(() => received.Count >= 2, "The peer's broadcasts never reached Unity over TLS");
            Assert.That(received, Is.EqualTo(new[] { "back over tls", large }));

            // A model: the server answers its request, and its updates go both ways.
            var models = E2EServer.Channel("tls-model");
            var id = Guid.NewGuid().ToString();
            var updates = new List<JObject>();
            Action<JObject> onModel = updates.Add;
            Sync.AddModelUpdateListener(models, onModel, id);
            _cleanup.Add(() => Sync.RemoveModelUpdateListener(models, onModel));

            yield return E2EServer.WaitUntil(() => updates.Any(update => (string)update["id"] == id),
                "The server never answered the model's request over TLS");

            _peer.Send(models, "model::update", new JObject { { "id", id }, { "label", "from the peer" } });
            yield return E2EServer.WaitUntil(() => updates.Any(update => (string)update["label"] == "from the peer"),
                "The peer's model update never reached Unity over TLS");

            Sync.SendModelUpdate(models, new JObject { { "id", id }, { "label", "from unity" } });
            yield return _peer.Expect(models, "model::update",
                frame => Assert.That((string)TcpPeer.Json(frame)["label"], Is.EqualTo("from unity")));
        }

        /// <summary>
        /// A dropped link over TLS: the client notices, queues what is sent meanwhile, makes a new
        /// TLS connection, and sends the queue in order ahead of anything newer.
        /// </summary>
        [UnityTest]
        public IEnumerator AConnectionOverTlsComesBackAfterAnOutageAndSendsWhatWasQueuedInOrder()
        {
            // The proxy cannot read TLS, so it only passes the bytes on.
            _proxy = TcpProxy.Start(E2EServer.Host, E2EServer.TlsTcpPort, recordMessages: false);
            ConnectionTo(allowSelfSigned: false, pin: E2EServer.TlsCertificateSha256, tcpPort: _proxy.Port);
            yield return WaitForConnection();
            yield return ConnectPeer("tls-reconnect-peer");

            var channel = E2EServer.Channel("tls-outage");
            var next = 1;
            for (var i = 0; i < 5; i++)
                Sync.Send(channel, next++);
            yield return E2EServer.WaitUntil(() => Received(channel).Length == 5, "The messages sent before the outage never arrived");

            var sessions = _proxy.Sessions;
            _proxy.Cut();
            yield return E2EServer.WaitUntil(() => Connection.Status != ConnectionStatus.Connected,
                "The client never noticed that its connection was cut");

            for (var i = 0; i < 10; i++)
                Sync.Send(channel, next++);

            yield return E2EServer.WaitUntil(() => Connection.Status == ConnectionStatus.Connected && Connection.ConnectedSessions == 2,
                "The client never reconnected over TLS after the outage", 20f);

            for (var i = 0; i < 5; i++)
                Sync.Send(channel, next++);

            var expected = Enumerable.Range(1, next - 1).ToArray();
            yield return E2EServer.WaitUntil(() => Received(channel).Length >= expected.Length,
                $"Only {Received(channel).Length} of the {expected.Length} messages arrived");
            yield return E2EServer.Settle(0.3f);

            Assert.That(Received(channel), Is.EqualTo(expected), "Messages arrived out of order, or twice, across the outage");
            Assert.That(_proxy.Sessions, Is.EqualTo(sessions + 1));
        }


        /*
         *  Helpers
         */

        private static void ConnectionTo(bool allowSelfSigned, string pin, int tcpPort = 0)
        {
            E2EServer.ConfigureTls(allowSelfSigned, pin, tcpPort);

            // OnEnable is what reads the config, so it only takes effect on a fresh instance -
            // which touching Instance after the teardown in the setup creates.
            Assert.That(Connection, Is.Not.Null);
        }

        private static IEnumerator WaitForConnection()
        {
            var deadline = Time.realtimeSinceStartup + 20f;
            while (Connection.Status != ConnectionStatus.Connected)
            {
                if (Time.realtimeSinceStartup > deadline)
                    Assert.Fail($"The client never connected over TLS. Last attempt: {Connection.LastConnectFailure ?? "(none failed)"}");

                yield return null;
            }
        }

        private IEnumerator ConnectPeer(string name)
        {
            _peer = new TcpPeer(E2EServer.TlsTcpPort, useTls: true);
            yield return _peer.Connect(name);

            // The peer's handshake and a test's first message travel on different connections.
            yield return E2EServer.Settle(0.3f);
        }

        private int[] Received(string channel)
            => _peer.Received
                .Where(frame => frame.Channel == channel)
                .Select(frame => int.Parse(TcpPeer.Text(frame)))
                .ToArray();

        private void Record(string message, string stackTrace, LogType type)
        {
            lock (_log)
                _log.Add((type, message, _clock.Elapsed.TotalSeconds));
        }

        private string[] Logged(LogType type, Regex pattern)
        {
            lock (_log)
                return _log.Where(entry => entry.Type == type && pattern.IsMatch(entry.Message)).Select(entry => entry.Message).ToArray();
        }

        private double[] Times(LogType type, Regex pattern)
        {
            lock (_log)
                return _log.Where(entry => entry.Type == type && pattern.IsMatch(entry.Message)).Select(entry => entry.Seconds).ToArray();
        }

        /// <summary>
        /// What is wrong with the TLS test server's certificate under <paramref name="host"/>, as it
        /// appears in "accepted the certificate of ... although ..., because": it is self-signed,
        /// and under an address it is not issued for, it is not issued for that address. It is
        /// issued for localhost, 127.0.0.1 and ::1. Not every TLS backend matches an address
        /// against the IP addresses in a certificate, so under those two either is right; under a
        /// name, only the check against the configured one is (the EditMode TlsConnectTests pin
        /// that down for every backend).
        /// </summary>
        private static string ProblemsUnder(string host)
        {
            const string selfSigned = "it is self-signed";
            var notIssuedFor = Regex.Escape($" and it is not issued for '{host}'");

            string problems;
            if (host == "localhost")
                problems = selfSigned;
            else if (host == "127.0.0.1" || host == "::1")
                problems = $"{selfSigned}({notIssuedFor})?";
            else
                problems = selfSigned + notIssuedFor;

            return $" although {problems}, because ";
        }

        /// <summary>A fingerprint, or a line that contains one, without colons and in lower case.</summary>
        private static string Normalized(string text) => text?.Replace(":", "").ToLowerInvariant();

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
