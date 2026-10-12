using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using HCIKonstanz.Colibri.Networking;
using NUnit.Framework;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// Opening the connection's stream: the socket's own without TLS, an encrypted one with it, and
    /// what a server that does not speak TLS looks like to a client that does. The handshake with a
    /// real TLS server is in the PlayMode suite (TlsTests), against colibri-server itself.
    /// </summary>
    public class TlsConnectTests
    {
        private readonly List<IDisposable> _disposables = new List<IDisposable>();

        // The socket of every address an attempt tried, in order.
        private readonly List<Socket> _attempted = new List<Socket>();

        [TearDown]
        public void CloseSockets()
        {
            foreach (var disposable in _disposables)
                disposable.Dispose();
            _disposables.Clear();
            _attempted.Clear();
        }

        /// <summary>Without TLS the frames go through the socket's own stream, byte for byte.</summary>
        [Test]
        public void WithoutTlsTheStreamIsTheSocketsOwn()
        {
            var listener = Listen();

            var stream = Wait(Opening("127.0.0.1", Port(listener), null, 5000, CancellationToken.None)).Stream;
            var server = Accept(listener);

            Assert.That(stream, Is.InstanceOf<NetworkStream>());

            stream.Write(new byte[] { 1, 2, 3 }, 0, 3);
            var received = new byte[3];
            Assert.That(server.Receive(received), Is.EqualTo(3));
            Assert.That(received, Is.EqualTo(new byte[] { 1, 2, 3 }));
        }

        /// <summary>
        /// colibri-server without TLS reads the client's TLS hello as a frame it cannot accept and
        /// hangs up. That is said as what it almost always is, a server without TLS, not as a
        /// network error, and not as a certificate problem: no certificate was ever seen.
        /// </summary>
        [Test]
        public void AServerThatHangsUpOnTheHandshakeDidNotAnswerIt()
        {
            var listener = Listen();
            var check = new ServerCertificateCheck("127.0.0.1", false, "");

            var opening = Opening("127.0.0.1", Port(listener), check, 5000, CancellationToken.None);
            var server = Accept(listener);
            server.Receive(new byte[1024]);
            server.Close();

            var e = Assert.Throws<TlsHandshakeException>(() => Wait(opening));

            Assert.That(e.Kind, Is.EqualTo(TlsHandshakeException.Failure.NoTlsAnswer));
            Assert.That(e.Message, Does.StartWith($"127.0.0.1:{Port(listener)} did not answer the TLS handshake"));
            Assert.That(check.Rejection, Is.Null);
        }

        /// <summary>A server that answers with something that is not TLS - a plain colibri-server's
        /// refusal, say - is the same case.</summary>
        [Test]
        public void AServerThatAnswersWithoutTlsDidNotAnswerTheHandshake()
        {
            var listener = Listen();

            var opening = Opening("127.0.0.1", Port(listener), new ServerCertificateCheck("127.0.0.1", true, ""), 5000, CancellationToken.None);
            var server = Accept(listener);
            server.Receive(new byte[1024]);
            server.Send(Encoding.ASCII.GetBytes("this is not TLS, and it goes on long enough to be read as a record\n"));

            var e = Assert.Throws<TlsHandshakeException>(() => Wait(opening));

            Assert.That(e.Kind, Is.EqualTo(TlsHandshakeException.Failure.NoTlsAnswer));
        }

        /// <summary>
        /// A server that accepts the connection and never answers the handshake would hold the
        /// attempt forever. The handshake has the same time as the connection itself - one budget
        /// for both - and giving up closes the socket, as a connect that times out does.
        /// </summary>
        [Test]
        public void AServerThatNeverAnswersTheHandshakeIsGivenUpWithinTheConnectTimeout()
        {
            var listener = Listen();

            var clock = Stopwatch.StartNew();
            var opening = Opening("127.0.0.1", Port(listener), new ServerCertificateCheck("127.0.0.1", false, ""), 600, CancellationToken.None);
            Accept(listener);

            var e = Assert.Throws<TlsHandshakeException>(() => Wait(opening));
            clock.Stop();

            Assert.That(e.Kind, Is.EqualTo(TlsHandshakeException.Failure.NoTlsAnswer));
            Assert.That(e.Message, Is.EqualTo($"127.0.0.1:{Port(listener)} accepted the connection but did not answer the TLS handshake within 0.6 s"));
            Assert.That(clock.ElapsedMilliseconds, Is.GreaterThanOrEqualTo(500).And.LessThan(5000),
                "The handshake was not given up when the connection's time was up");
            Assert.Throws<ObjectDisposedException>(() => _ = _attempted.Single().Available, "The abandoned socket was left open");
        }

        [Test]
        public void CancellingGivesUpTheHandshakeAtOnce()
        {
            var listener = Listen();

            using (var cancel = new CancellationTokenSource())
            {
                var clock = Stopwatch.StartNew();
                var opening = Opening("127.0.0.1", Port(listener), new ServerCertificateCheck("127.0.0.1", false, ""), 60000, cancel.Token);
                Accept(listener);
                cancel.CancelAfter(100);

                Assert.Catch<OperationCanceledException>(() => Wait(opening));
                Assert.That(clock.ElapsedMilliseconds, Is.LessThan(5000), "Cancelling did not end the handshake");
            }
        }


        /*
         *  The name the certificate is checked against
         *
         *  Against a TLS server in the test process, with "localhost" as the server address: a
         *  name, which every TLS backend matches against a certificate's names. Not every one
         *  matches an IP address against a certificate's IP addresses.
         */

        /// <summary>
        /// The certificate is checked against the configured server address. One issued for it has
        /// nothing wrong with it but being self-signed; checked against any other name, it would
        /// not be issued for that name either.
        /// </summary>
        [Test]
        public void TheCertificateIsCheckedAgainstTheConfiguredServerAddress()
        {
            var server = Serve(TlsTestServer.Localhost());
            var check = new ServerCertificateCheck("localhost", true, "");

            Open("localhost", server, check);

            Assert.That(check.Verdict, Is.EqualTo(ServerCertificatePolicy.Verdict.AcceptedUntrusted));
            Assert.That(check.Problems, Is.EqualTo("it is self-signed"),
                "The certificate is issued for localhost, so being self-signed is all that is wrong with it");
        }

        /// <summary>
        /// The server is asked for the configured address too (SNI): a server, or a proxy in front
        /// of several, picks the certificate to answer with by it.
        /// </summary>
        [Test]
        public void TheServerIsAskedForTheConfiguredServerAddress()
        {
            var server = Serve(TlsTestServer.Localhost());

            Open("localhost", server, new ServerCertificateCheck("localhost", true, ""));

            Assert.That(server.RequestedServerName, Is.EqualTo("localhost"));
        }

        /// <summary>
        /// A certificate issued for another name is rejected by default, and the rejection says
        /// which address it is not issued for.
        /// </summary>
        [Test]
        public void ACertificateIssuedForAnotherNameIsRejectedSayingWhichAddressItIsNotIssuedFor()
        {
            var server = Serve(TlsTestServer.OtherName());
            var check = new ServerCertificateCheck("localhost", false, "");

            var e = Assert.Throws<TlsHandshakeException>(() => Open("localhost", server, check));

            Assert.That(e.Kind, Is.EqualTo(TlsHandshakeException.Failure.CertificateRejected));
            Assert.That(e.Message, Does.StartWith(
                $"rejected the certificate of localhost:{server.Port}: it is self-signed and it is not issued for 'localhost'. "));
        }

        /// <summary>"Allow self-signed certificate" accepts it, and says what is wrong with it: both things.</summary>
        [Test]
        public void ACertificateIssuedForAnotherNameIsAcceptedWhenSelfSignedCertificatesAreAllowed()
        {
            var server = Serve(TlsTestServer.OtherName());
            var check = new ServerCertificateCheck("localhost", true, "");

            Open("localhost", server, check);

            Assert.That(check.Verdict, Is.EqualTo(ServerCertificatePolicy.Verdict.AcceptedUntrusted));
            Assert.That(check.Problems, Is.EqualTo("it is self-signed and it is not issued for 'localhost'"));
        }

        /// <summary>A pinned certificate is accepted whatever name it is issued for: the pin is the whole check.</summary>
        [Test]
        public void APinnedCertificateIsAcceptedWhateverNameItIsIssuedFor()
        {
            var server = Serve(TlsTestServer.OtherName());
            var check = new ServerCertificateCheck("localhost", false, TlsTestServer.OtherNameSha256);

            Open("localhost", server, check);

            Assert.That(check.Verdict, Is.EqualTo(ServerCertificatePolicy.Verdict.Pinned));
        }


        /*
         *  Helpers
         */

        private TlsTestServer Serve(System.Security.Cryptography.X509Certificates.X509Certificate2 certificate)
        {
            _disposables.Add(certificate);
            var server = new TlsTestServer(certificate);
            _disposables.Add(server);
            return server;
        }

        private void Open(string host, TlsTestServer server, ServerCertificateCheck check)
            => _disposables.Add(Wait(Opening(host, server.Port, check, 5000, CancellationToken.None)).Stream);

        /// <summary>Opens a session, keeping every socket it tries to close it afterwards.</summary>
        private Task<WebServerConnection.Session> Opening(string host, int port, ServerCertificateCheck check, int timeoutMs, CancellationToken token)
            => WebServerConnection.OpenSessionAsync(host, port, check, timeoutMs, Attempting, token);

        private void Attempting(Socket socket)
        {
            _attempted.Add(socket);
            _disposables.Add(socket);
        }

        private TcpListener Listen()
        {
            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            _disposables.Add(new Stopping(listener));
            return listener;
        }

        private static int Port(TcpListener listener) => ((IPEndPoint)listener.LocalEndpoint).Port;

        private Socket Accept(TcpListener listener)
        {
            var accepting = listener.AcceptSocketAsync();
            Assert.That(accepting.Wait(TimeSpan.FromSeconds(5)), Is.True, "The client never connected");

            var server = accepting.Result;
            server.ReceiveTimeout = 5000;
            _disposables.Add(server);
            return server;
        }

        /// <summary>Rethrows what the task failed with, rather than an AggregateException around it.</summary>
        private static T Wait<T>(Task<T> task)
        {
            try
            {
                task.Wait(TimeSpan.FromSeconds(30));
            }
            catch (AggregateException)
            {
                // Rethrown unwrapped below.
            }

            if (!task.IsCompleted)
                Assert.Fail("Opening the stream neither succeeded, failed nor gave up within 30 s");

            return task.GetAwaiter().GetResult();
        }

        private sealed class Stopping : IDisposable
        {
            private readonly TcpListener _listener;
            public Stopping(TcpListener listener) => _listener = listener;
            public void Dispose() => _listener.Stop();
        }
    }
}
