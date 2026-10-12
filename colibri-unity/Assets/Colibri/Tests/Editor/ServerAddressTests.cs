using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using HCIKonstanz.Colibri.Networking;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// Finding the server over TCP: what counts as an IP address, the order a name's addresses are
    /// tried in, how they share the connect timeout, and moving on from one that is refused or does
    /// not answer. While the socket was IPv4, a server name with only IPv6 addresses, or an IPv6
    /// address, could not be reached at all.
    /// </summary>
    public class ServerAddressTests
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


        /*
         *  What counts as an IP address
         */

        [TestCase("192.168.0.10", "192.168.0.10")]
        [TestCase("::1", "::1")]
        [TestCase("[::1]", "::1")]
        [TestCase("2001:db8::1", "2001:db8::1")]
        [TestCase("[2001:db8::1]", "2001:db8::1")]
        public void AnIPAddressIsTakenAsItIs(string host, string expected)
        {
            Assert.That(WebServerConnection.TryParseAddress(host, out var address), Is.True);
            Assert.That(address, Is.EqualTo(IPAddress.Parse(expected)));
        }

        /// <summary>Brackets hold an IPv6 address and nothing else, as in a URL.</summary>
        [TestCase("colibri.example.org")]
        [TestCase("localhost")]
        [TestCase("[colibri.example.org]")]
        [TestCase("[192.168.0.10]")]
        [TestCase("[::1")]
        [TestCase("[]")]
        [TestCase("")]
        [TestCase(null)]
        public void AnythingElseIsNot(string host)
        {
            Assert.That(WebServerConnection.TryParseAddress(host, out var address), Is.False);
            Assert.That(address, Is.Null);
        }

        [Test]
        public void AnIPAddressIsNotLookedUp()
        {
            var resolving = WebServerConnection.ResolveAsync("[::1]", 5000, CancellationToken.None);

            Assert.That(resolving.IsCompleted, Is.True);
            Assert.That(resolving.Result, Is.EqualTo(new[] { IPAddress.IPv6Loopback }));
        }

        /// <summary>The real resolver on this machine, which is where the order within each family comes from.</summary>
        [Test]
        public void LocalhostResolvesToLoopbackAddresses()
        {
            var addresses = Wait(WebServerConnection.ResolveAsync("localhost", 5000, CancellationToken.None));

            Assert.That(addresses, Is.Not.Empty);
            Assert.That(addresses.All(IPAddress.IsLoopback), Is.True, string.Join(", ", addresses));
        }


        /*
         *  The order the addresses are tried in
         */

        /// <summary>
        /// Voice goes to IPv4 whenever the name has an IPv4 address, and the server relays voice only
        /// from the address of a TCP connection, so TCP has to use IPv4 then too. In the resolver's
        /// order, usually IPv6 first, it connected over IPv6 and all voice was dropped.
        /// </summary>
        [Test]
        public void IPv4AddressesAreTriedBeforeIPv6Addresses()
        {
            var v6 = IPAddress.Parse("2001:db8::1");
            var v4 = IPAddress.Parse("192.0.2.1");

            Assert.That(WebServerConnection.AddressesToTry(new[] { v6, v4 }), Is.EqualTo(new[] { v4, v6 }));
            Assert.That(WebServerConnection.AddressesToTry(new[] { v4, v6 }), Is.EqualTo(new[] { v4, v6 }));
        }

        [Test]
        public void EachFamilyKeepsTheOrderTheResolverGaveIt()
        {
            var v6a = IPAddress.Parse("2001:db8::1");
            var v6b = IPAddress.Parse("2001:db8::2");
            var v4a = IPAddress.Parse("192.0.2.1");
            var v4b = IPAddress.Parse("192.0.2.2");

            Assert.That(WebServerConnection.AddressesToTry(new[] { v6a, v4a, v6b, v4b }), Is.EqualTo(new[] { v4a, v4b, v6a, v6b }));
            Assert.That(WebServerConnection.AddressesToTry(new[] { v4b, v6b, v4a, v6a }), Is.EqualTo(new[] { v4b, v4a, v6b, v6a }));
        }

        /// <summary>A name with only IPv6 addresses still connects over IPv6, as voice then goes to IPv6 too.</summary>
        [Test]
        public void OnlyIPv6AddressesAreTriedInTheResolversOrder()
        {
            var v6a = IPAddress.Parse("2001:db8::1");
            var v6b = IPAddress.Parse("2001:db8::2");

            Assert.That(WebServerConnection.AddressesToTry(new[] { v6b, v6a }), Is.EqualTo(new[] { v6b, v6a }));
        }

        /// <summary>A resolver may hand out an address once per socket type; trying it again gains nothing.</summary>
        [Test]
        public void AnAddressFoundTwiceIsTriedOnce()
        {
            var v6 = IPAddress.Parse("2001:db8::1");
            var v4 = IPAddress.Parse("192.0.2.1");

            Assert.That(WebServerConnection.AddressesToTry(new[] { v6, v6, v4, v6, v4 }), Is.EqualTo(new[] { v4, v6 }));
        }

        [Test]
        public void AnIPv4MappedAddressIsTriedAsTheIPv4AddressItStandsFor()
        {
            var v4 = IPAddress.Parse("192.0.2.1");

            var addresses = WebServerConnection.AddressesToTry(new[] { v4.MapToIPv6() });

            Assert.That(addresses, Is.EqualTo(new[] { v4 }));
            Assert.That(addresses[0].AddressFamily, Is.EqualTo(AddressFamily.InterNetwork));
        }

        /// <summary>
        /// An IPv4-mapped address counts as IPv4 for the order as well, and as the same address as
        /// the IPv4 address it stands for.
        /// </summary>
        [Test]
        public void AnIPv4MappedAddressIsTriedWithTheIPv4Addresses()
        {
            var v6a = IPAddress.Parse("2001:db8::1");
            var v6b = IPAddress.Parse("2001:db8::2");
            var v4a = IPAddress.Parse("192.0.2.1");
            var v4b = IPAddress.Parse("192.0.2.2");

            Assert.That(WebServerConnection.AddressesToTry(new[] { v6a, v4a.MapToIPv6(), v6b, v4b }), Is.EqualTo(new[] { v4a, v4b, v6a, v6b }));
            Assert.That(WebServerConnection.AddressesToTry(new[] { v6a, v4a.MapToIPv6(), v4a }), Is.EqualTo(new[] { v4a, v6a }));
        }


        /*
         *  Looking up a name
         */

        [Test]
        public void ALookupThatDoesNotFinishIsGivenUpAfterTheTimeout()
        {
            var neverCompletes = new TaskCompletionSource<IPAddress[]>().Task;

            var clock = Stopwatch.StartNew();
            var e = Assert.Throws<TimeoutException>(() =>
                Wait(WebServerConnection.WaitForLookupAsync(neverCompletes, "colibri.example.org", 300, CancellationToken.None)));

            Assert.That(clock.ElapsedMilliseconds, Is.GreaterThanOrEqualTo(250).And.LessThan(5000));
            Assert.That(e.Message, Is.EqualTo("colibri.example.org could not be resolved within 0.3 s"));
        }

        [Test]
        public void CancellingGivesUpTheLookupAtOnce()
        {
            var neverCompletes = new TaskCompletionSource<IPAddress[]>().Task;

            using (var cancel = new CancellationTokenSource())
            {
                var clock = Stopwatch.StartNew();
                var lookup = WebServerConnection.WaitForLookupAsync(neverCompletes, "colibri.example.org", 60000, cancel.Token);
                cancel.CancelAfter(100);

                Assert.Catch<OperationCanceledException>(() => Wait(lookup));
                Assert.That(clock.ElapsedMilliseconds, Is.LessThan(5000), "Cancelling did not end the lookup");
            }
        }

        [Test]
        public void ALookupThatFindsNothingFailsAsHostNotFound()
        {
            var e = Assert.Throws<SocketException>(() =>
                Wait(WebServerConnection.WaitForLookupAsync(Task.FromResult(new IPAddress[0]), "colibri.example.org", 5000, CancellationToken.None)));

            Assert.That(e.SocketErrorCode, Is.EqualTo(SocketError.HostNotFound));
        }


        /*
         *  Sharing the connect timeout
         */

        [Test]
        public void EachAddressGetsAnEqualShareOfTheTimeLeft()
        {
            Assert.That(WebServerConnection.AttemptTimeoutMs(5000, 2, false), Is.EqualTo(2500));
            Assert.That(WebServerConnection.AttemptTimeoutMs(4500, 3, false), Is.EqualTo(1500));
        }

        [Test]
        public void TheLastAddressGetsAllTheTimeLeft()
        {
            Assert.That(WebServerConnection.AttemptTimeoutMs(2400, 1, false), Is.EqualTo(2400));
            Assert.That(WebServerConnection.AttemptTimeoutMs(2400, 1, true), Is.EqualTo(2400));
        }

        [Test]
        public void ManyAddressesGetASecondEachButNeverMoreThanIsLeft()
        {
            Assert.That(WebServerConnection.AttemptTimeoutMs(5000, 8, false), Is.EqualTo(1000));
            Assert.That(WebServerConnection.AttemptTimeoutMs(600, 3, false), Is.EqualTo(600));
        }

        /// <summary>
        /// Windows takes a second or more to report a refused loopback connection, as on 127.0.0.1
        /// when localhost is tried against a server on ::1 only.
        /// </summary>
        [Test]
        public void ALoopbackAddressWithOthersAfterItGetsAQuarterOfASecond()
        {
            Assert.That(WebServerConnection.AttemptTimeoutMs(5000, 2, true), Is.EqualTo(250));
        }


        /*
         *  Trying the addresses
         */

        /// <summary>
        /// A name with an IPv4 and an IPv6 address for a server that listens on IPv6 only: IPv4 is
        /// refused, and IPv6 is tried at once, each with a socket of its own family.
        /// </summary>
        [Test]
        public void ARefusedAddressIsFollowedByTheNextAtOnce()
        {
            RequireIPv6();
            var port = Port(Listen(IPAddress.IPv6Loopback));

            LogAssert.Expect(LogType.Log, new Regex(
                $@"^Colibri: no (connection to 127\.0\.0\.1:{port} \(ConnectionRefused\)|answer from 127\.0\.0\.1:{port} within [0-9.]+ s), trying \[::1\]:{port}$"));

            var clock = Stopwatch.StartNew();
            var (socket, address) = Wait(WebServerConnection.ConnectAnyAsync(new[] { IPAddress.Loopback, IPAddress.IPv6Loopback },
                "localhost", port, 5000, 5000, Attempting, CancellationToken.None));

            Assert.That(clock.ElapsedMilliseconds, Is.LessThan(2000), "The refused address held up the attempt");
            Assert.That(address, Is.EqualTo(IPAddress.IPv6Loopback));
            Assert.That(socket.Connected, Is.True);
            Assert.That(_attempted.Select(s => s.AddressFamily), Is.EqualTo(new[] { AddressFamily.InterNetwork, AddressFamily.InterNetworkV6 }));
            Assert.That(socket, Is.SameAs(_attempted[1]));
            Assert.That(socket.NoDelay, Is.True);
            Assert.Throws<ObjectDisposedException>(() => _ = _attempted[0].Available, "The refused attempt's socket was left open");
        }

        /// <summary>
        /// localhost with no server running fails as a refusal, which says to start the server. On
        /// Windows, 127.0.0.1 refuses only after its 0.25 s are up and reads as no answer, so the
        /// refusal reported is the one from ::1. ARefusalIsReportedOverAnAddressGivenUpBeforeIt
        /// covers that case on every system.
        /// </summary>
        [Test]
        public void EveryAddressRefusedFailsAsARefusal()
        {
            RequireIPv6();
            var port = ClosedPort();

            var e = Assert.Throws<SocketException>(() => Wait(WebServerConnection.ConnectAnyAsync(
                new[] { IPAddress.Loopback, IPAddress.IPv6Loopback }, "localhost", port, 5000, 5000, Attempting, CancellationToken.None)));

            Assert.That(e.SocketErrorCode, Is.EqualTo(SocketError.ConnectionRefused));
            Assert.That(_attempted, Has.Count.EqualTo(2));
            foreach (var socket in _attempted)
                Assert.Throws<ObjectDisposedException>(() => _ = socket.Available, "A failed attempt's socket was left open");
        }

        /// <summary>
        /// localhost on Windows with no server running: Windows reports a refused loopback
        /// connection only after a second or more, so 127.0.0.1 is given up after its 0.25 s as no
        /// answer, and ::1 then refuses. The refusal is reported, which says to start the server;
        /// the timeout said to check the address and the network. A loopback port that never
        /// answers stands in for the late refusal on 127.0.0.1.
        /// </summary>
        [Test]
        public void ARefusalIsReportedOverAnAddressGivenUpBeforeIt()
        {
            RequireIPv6();
            var port = UnansweredPort();
            // Proves that ::1 is there, and leaves nothing listening on it.
            Listen(IPAddress.IPv6Loopback, port).Stop();

            LogAssert.Expect(LogType.Log, $"Colibri: no connection to 127.0.0.1:{port} within 0.25 s, trying [::1]:{port}");

            var e = Assert.Throws<SocketException>(() => Wait(WebServerConnection.ConnectAnyAsync(
                new[] { IPAddress.Loopback, IPAddress.IPv6Loopback }, "localhost", port, 5000, 5000, Attempting, CancellationToken.None)));

            Assert.That(e.SocketErrorCode, Is.EqualTo(SocketError.ConnectionRefused));
            Assert.That(_attempted, Has.Count.EqualTo(2));
        }

        /// <summary>
        /// An IPv6 address the device has no route to, tried after a refused IPv4 address, does not
        /// hide the refusal: on a network without IPv6, a server that is down reads as down, not as
        /// a network without a route. The IPv6 address here is link-local without a scope, which no
        /// socket connects to. Where the route check does not see that, the loopback address gets
        /// 0.25 s, and Windows reports the refusal only after that, as no answer.
        /// </summary>
        [Test]
        public void AnUnreachableAddressAfterARefusedOneDoesNotHideTheRefusal()
        {
            var port = ClosedIPv4Port();

            LogAssert.Expect(LogType.Log, new Regex(
                $@"^Colibri: no (connection to 127\.0\.0\.1:{port} \(ConnectionRefused\)|answer from 127\.0\.0\.1:{port} within [0-9.]+ s), trying \[fe80::1\]:{port}$"));

            var e = Assert.Catch(() => Wait(WebServerConnection.ConnectAnyAsync(new[] { IPAddress.Loopback, IPAddress.Parse("fe80::1") },
                "colibri.example.org", port, 3000, 3000, Attempting, CancellationToken.None)));

            Assert.That(e is TimeoutException || (e is SocketException refused && refused.SocketErrorCode == SocketError.ConnectionRefused),
                Is.True, $"The unreachable address's error was reported: {e}");
        }

        /// <summary>
        /// An address that nothing answers on, an IPv6 address on a network that does not route
        /// IPv6, say, holds up the attempt only for its share of the time. Here the first address is
        /// a loopback port that never answers, and the second is another loopback address, which
        /// only Linux routes without further setup. The log gives the loopback address's 250 ms
        /// as 0.25 s, as the guide does.
        /// </summary>
        [Test]
        public void AnAddressThatDoesNotAnswerLeavesTimeForTheNext()
        {
            var unanswered = UnansweredPort();
            var other = IPAddress.Parse("127.0.0.2");
            Listen(other, unanswered);

            LogAssert.Expect(LogType.Log, $"Colibri: no connection to 127.0.0.1:{unanswered} within 0.25 s, trying 127.0.0.2:{unanswered}");

            var clock = Stopwatch.StartNew();
            var (_, address) = Wait(WebServerConnection.ConnectAnyAsync(new[] { IPAddress.Loopback, other },
                "colibri.example.org", unanswered, 3000, 3000, Attempting, CancellationToken.None));

            Assert.That(address, Is.EqualTo(other));
            Assert.That(clock.ElapsedMilliseconds, Is.LessThan(1500), "The address that does not answer used up the time of the next");
        }

        /// <summary>
        /// An address the device has no route to fails at once, so it takes no share of the time
        /// from the addresses before it. On Wi-Fi without IPv6, a name with an AAAA record left its
        /// IPv4 address half of the 5 s, too little for a connection that needs a third SYN. Here
        /// the IPv4 address is a loopback port that never answers, which with a routed address
        /// after it would get 0.25 s.
        /// </summary>
        [Test]
        public void AnAddressWithoutARouteLeavesTheTimeToTheOneBeforeIt()
        {
            var unanswered = UnansweredPort();
            var unrouted = IPAddress.Parse("fe80::1");
            var asked = new List<IPAddress>();
            Func<IPAddress, bool> hasRoute = address =>
            {
                asked.Add(address);
                return !address.Equals(unrouted);
            };

            var clock = Stopwatch.StartNew();
            Assert.Throws<TimeoutException>(() => Wait(WebServerConnection.ConnectAnyAsync(new[] { IPAddress.Loopback, unrouted },
                "colibri.example.org", unanswered, 1500, 5000, hasRoute, Attempting, CancellationToken.None)));

            Assert.That(clock.ElapsedMilliseconds, Is.GreaterThanOrEqualTo(1400), "The address before the one without a route did not get the whole time");
            Assert.That(asked, Is.EqualTo(new[] { unrouted }), "The route check was not asked once about the address after the first");
        }

        /// <summary>The timeout names the server address as configured and the time the whole connection had.</summary>
        [Test]
        public void NoAnswerFromAnyAddressIsATimeoutForTheServerAddress()
        {
            var unanswered = UnansweredPort();

            var clock = Stopwatch.StartNew();
            var e = Assert.Throws<TimeoutException>(() => Wait(WebServerConnection.ConnectAnyAsync(new[] { IPAddress.Loopback },
                "colibri.example.org", unanswered, 600, 5000, Attempting, CancellationToken.None)));

            Assert.That(clock.ElapsedMilliseconds, Is.GreaterThanOrEqualTo(500).And.LessThan(5000));
            Assert.That(e.Message, Is.EqualTo($"colibri.example.org:{unanswered} did not answer within 5 s"));
            Assert.Throws<ObjectDisposedException>(() => _ = _attempted.Single().Available, "The abandoned socket was left open");
        }

        /// <summary>Cancelling closes the socket of the address being tried, as OnDisable relies on.</summary>
        [Test]
        public void CancellingClosesTheSocketBeingTried()
        {
            var unanswered = UnansweredPort();

            using (var cancel = new CancellationTokenSource())
            {
                var clock = Stopwatch.StartNew();
                var attempt = WebServerConnection.ConnectAnyAsync(new[] { IPAddress.Loopback }, "colibri.example.org", unanswered,
                    60000, 60000, Attempting, cancel.Token);
                cancel.CancelAfter(100);

                Assert.Catch<OperationCanceledException>(() => Wait(attempt));
                Assert.That(clock.ElapsedMilliseconds, Is.LessThan(5000), "Cancelling did not end the attempt");
                Assert.Throws<ObjectDisposedException>(() => _ = _attempted.Single().Available, "The socket being tried was left open");
            }
        }


        /*
         *  The whole connection
         */

        [Test]
        public void ABracketedIPv6AddressConnectsOverIPv6()
        {
            RequireIPv6();
            var port = Port(Listen(IPAddress.IPv6Loopback));

            var session = Wait(WebServerConnection.OpenSessionAsync("[::1]", port, null, 5000, Attempting, CancellationToken.None));
            _disposables.Add(session.Stream);

            Assert.That(session.Socket.AddressFamily, Is.EqualTo(AddressFamily.InterNetworkV6));
            Assert.That(session.Address, Is.EqualTo(IPAddress.IPv6Loopback));
            Assert.That(session.Socket.Connected, Is.True);
        }

        /// <summary>
        /// localhost against a server on IPv4 only, as colibri-server listens by default: 127.0.0.1
        /// is tried first, also where localhost resolves to ::1 first, here and on Windows.
        /// </summary>
        [Test]
        public void LocalhostReachesAServerOnTheIPv4LoopbackOnly()
        {
            var port = Port(Listen(IPAddress.Loopback));

            var session = Wait(WebServerConnection.OpenSessionAsync("localhost", port, null, 5000, Attempting, CancellationToken.None));
            _disposables.Add(session.Stream);

            Assert.That(session.Address, Is.EqualTo(IPAddress.Loopback));
            Assert.That(session.Socket.Connected, Is.True);
            Assert.That(_attempted.Select(s => s.AddressFamily), Is.EqualTo(new[] { AddressFamily.InterNetwork }));
        }

        /// <summary>
        /// localhost against a server on both loopbacks, as with TCP_HOST :: on Windows: TCP goes to
        /// 127.0.0.1, where voice goes as well, so the server lets the voice in. Over ::1 it dropped
        /// every voice packet, which came from 127.0.0.1.
        /// </summary>
        [Test]
        public void LocalhostConnectsOverIPv4ToAServerOnBothLoopbacks()
        {
            RequireIPv6();
            var port = Port(Listen(IPAddress.IPv6Loopback));
            Listen(IPAddress.Loopback, port);

            var session = Wait(WebServerConnection.OpenSessionAsync("localhost", port, null, 5000, Attempting, CancellationToken.None));
            _disposables.Add(session.Stream);

            Assert.That(session.Address, Is.EqualTo(IPAddress.Loopback));
            Assert.That(session.Socket.AddressFamily, Is.EqualTo(AddressFamily.InterNetwork));
            Assert.That(_attempted, Has.Count.EqualTo(1));
        }


        /*
         *  Helpers
         */

        private void Attempting(Socket socket)
        {
            _attempted.Add(socket);
            _disposables.Add(socket);
        }

        private static void RequireIPv6()
        {
            if (!Socket.OSSupportsIPv6)
                Assert.Ignore("This machine has no IPv6.");
        }

        private TcpListener Listen(IPAddress address, int port = 0)
        {
            var listener = new TcpListener(address, port);
            try
            {
                listener.Start();
            }
            catch (SocketException e)
            {
                Assert.Ignore($"Cannot listen on {address} here ({e.SocketErrorCode}).");
            }

            _disposables.Add(new Stopping(listener));
            return listener;
        }

        private static int Port(TcpListener listener) => ((IPEndPoint)listener.LocalEndpoint).Port;

        /// <summary>A port nothing listens on, on the IPv4 loopback.</summary>
        private static int ClosedIPv4Port()
        {
            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            var port = Port(listener);
            listener.Stop();
            return port;
        }

        /// <summary>A port nothing listens on, on either loopback.</summary>
        private int ClosedPort()
        {
            var listener = new TcpListener(IPAddress.IPv6Loopback, 0);
            listener.Start();
            var port = Port(listener);
            listener.Stop();
            return port;
        }

        /// <summary>
        /// A loopback port nothing answers on: a listener that never accepts, with its backlog
        /// already full. See ConnectTimeoutTests.UnansweredPort, which this is a copy of.
        /// </summary>
        private int UnansweredPort()
        {
            if (Environment.OSVersion.Platform == PlatformID.Win32NT)
                IgnoreNoUnansweredPort();

            var listener = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
            _disposables.Add(listener);
            listener.Bind(new IPEndPoint(IPAddress.Loopback, 0));
            listener.Listen(0);
            var port = ((IPEndPoint)listener.LocalEndPoint).Port;

            for (var i = 0; i < 16; i++)
            {
                var probe = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
                _disposables.Add(probe);
                var connecting = probe.ConnectAsync(IPAddress.Loopback, port);

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
                Assert.Fail("The attempt neither connected, failed nor gave up within 30 s");

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
