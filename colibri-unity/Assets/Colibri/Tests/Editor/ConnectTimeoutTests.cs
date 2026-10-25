using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;
using HCIKonstanz.Colibri.Networking;
using NUnit.Framework;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// Opening the TCP connection, which has no timeout of its own: an address nothing answers on
    /// used to hold an attempt for the OS's SYN timeout - about two minutes on Android - before the
    /// client even retried. Timed here against a loopback port that never answers, with a timeout
    /// short enough for an EditMode test; the PlayMode suite runs the connection's own 5 s.
    /// </summary>
    public class ConnectTimeoutTests
    {
        private readonly List<IDisposable> _disposables = new List<IDisposable>();

        [TearDown]
        public void CloseSockets()
        {
            foreach (var disposable in _disposables)
                disposable.Dispose();
            _disposables.Clear();
        }

        [Test]
        public void AnAttemptNothingAnswersIsGivenUpAfterTheTimeout()
        {
            var port = UnansweredPort();
            var socket = NewSocket();

            var clock = Stopwatch.StartNew();
            var e = Assert.Throws<TimeoutException>(() =>
                Wait(ConnectRace.ConnectAsync(socket, IPAddress.Loopback, port, 300, CancellationToken.None)));
            clock.Stop();

            Assert.That(clock.ElapsedMilliseconds, Is.GreaterThanOrEqualTo(250).And.LessThan(5000),
                "The attempt was not given up when its time was up");
            Assert.That(e.Message, Is.EqualTo($"127.0.0.1:{port} did not answer within 0.3 s"));

            // Closing it is what abandons the attempt; left open, it would go on sending SYNs.
            Assert.Throws<ObjectDisposedException>(() => _ = socket.Available, "The abandoned socket was left open");
        }

        [Test]
        public void CancellingGivesUpTheAttemptAtOnce()
        {
            var port = UnansweredPort();
            var socket = NewSocket();

            using (var cancel = new CancellationTokenSource())
            {
                var clock = Stopwatch.StartNew();
                var attempt = ConnectRace.ConnectAsync(socket, IPAddress.Loopback, port, 60000, cancel.Token);
                cancel.CancelAfter(100);

                Assert.Catch<OperationCanceledException>(() => Wait(attempt));
                Assert.That(clock.ElapsedMilliseconds, Is.LessThan(5000), "Cancelling did not end the attempt");
            }
        }

        /// <summary>
        /// A socket closed under the attempt ends it at once, as closed, and not as a server that
        /// did not answer once the time is up.
        /// </summary>
        [Test]
        public void ClosingTheSocketEndsTheAttemptAtOnce()
        {
            var port = UnansweredPort();
            var socket = NewSocket();

            var clock = Stopwatch.StartNew();
            var attempt = ConnectRace.ConnectAsync(socket, IPAddress.Loopback, port, 10000, CancellationToken.None);
            Thread.Sleep(100);
            socket.Close();

            Assert.Throws<ObjectDisposedException>(() => Wait(attempt));
            Assert.That(clock.ElapsedMilliseconds, Is.LessThan(2000), "Closing the socket did not end the attempt");
        }

        /// <summary>
        /// The same on Mono, where a connect whose socket is closed neither completes nor fails: a
        /// connect that never completes stands in for it here. The attempt used to wait out the
        /// whole timeout, and then said a server that may well have answered had not.
        /// </summary>
        [Test]
        public void ClosingTheSocketEndsTheAttemptAtOnceEvenIfTheConnectNeverNotices()
        {
            var socket = NewSocket();
            var neverCompletes = new TaskCompletionSource<bool>().Task;

            var clock = Stopwatch.StartNew();
            var attempt = ConnectRace.WaitForConnectAsync(socket, neverCompletes, "127.0.0.1", 9212, 10000, CancellationToken.None);
            Thread.Sleep(100);
            socket.Close();

            Assert.Throws<ObjectDisposedException>(() => Wait(attempt));
            Assert.That(clock.ElapsedMilliseconds, Is.LessThan(2000), "Closing the socket did not end the attempt");
        }

        [Test]
        public void AnAnsweredAttemptConnects()
        {
            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            try
            {
                var socket = NewSocket();
                Wait(ConnectRace.ConnectAsync(socket, IPAddress.Loopback, ((IPEndPoint)listener.LocalEndpoint).Port, 5000, CancellationToken.None));

                Assert.That(socket.Connected, Is.True);
            }
            finally
            {
                listener.Stop();
            }
        }

        /// <summary>A refusal is not a timeout, and is reported as what it is, straight away.</summary>
        [Test]
        public void ARefusedAttemptFailsAsARefusalWithoutWaitingForTheTimeout()
        {
            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            var closedPort = ((IPEndPoint)listener.LocalEndpoint).Port;
            listener.Stop();

            var socket = NewSocket();
            var clock = Stopwatch.StartNew();
            var e = Assert.Throws<SocketException>(() =>
                Wait(ConnectRace.ConnectAsync(socket, IPAddress.Loopback, closedPort, 30000, CancellationToken.None)));

            Assert.That(e.SocketErrorCode, Is.EqualTo(SocketError.ConnectionRefused));
            Assert.That(clock.ElapsedMilliseconds, Is.LessThan(5000));
        }


        /*
         *  Helpers
         */

        private Socket NewSocket()
        {
            var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
            _disposables.Add(socket);
            return socket;
        }

        /// <summary>Rethrows what the task failed with, rather than an AggregateException around it.</summary>
        private static void Wait(Task task)
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
                Assert.Fail("The attempt neither connected, failed nor gave up within 30 s");

            task.GetAwaiter().GetResult();
        }

        /// <summary>
        /// A loopback port nothing answers on: a listener that never accepts, with its backlog
        /// already full. Linux - and so Android - and macOS drop further SYNs instead of refusing
        /// them, so connecting hangs as it does to a host that is not there. Windows refuses them,
        /// after retrying the SYN for a second or so, and then the test cannot run; see
        /// UnansweredPort in the PlayMode suite.
        /// </summary>
        private int UnansweredPort()
        {
            // Not probed: its late refusal would outlast a short probe and pass for no answer.
            if (Environment.OSVersion.Platform == PlatformID.Win32NT)
                IgnoreNoUnansweredPort();

            var listener = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
            _disposables.Add(listener);
            listener.Bind(new IPEndPoint(IPAddress.Loopback, 0));
            listener.Listen(0);
            var port = ((IPEndPoint)listener.LocalEndPoint).Port;

            for (var i = 0; i < 16; i++)
            {
                var probe = NewSocket();
                var connecting = probe.ConnectAsync(IPAddress.Loopback, port);

                // A loopback connection that is answered at all is answered within a millisecond;
                // the rest leaves room for a busy machine and for a refusal that comes late.
                bool answered;
                try
                {
                    answered = connecting.Wait(1000);
                }
                catch (AggregateException)
                {
                    break;
                }

                if (answered)
                    continue;

                probe.Close();
                _ = connecting.ContinueWith(attempt => { _ = attempt.Exception; }, CancellationToken.None,
                    TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
                return port;
            }

            IgnoreNoUnansweredPort();
            return 0;
        }

        private static void IgnoreNoUnansweredPort()
        {
            Assert.Ignore("This system refuses a connection to a full backlog instead of leaving it unanswered, "
                + "so there is no port here that never answers.");
        }
    }
}
