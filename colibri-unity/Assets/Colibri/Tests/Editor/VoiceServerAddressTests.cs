using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text.RegularExpressions;
using System.Threading;
using HCIKonstanz.Colibri.Networking;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;
using Object = UnityEngine.Object;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// Every server takes voice over IPv4, but not every one over IPv6, so out of everything the
    /// server name resolves to, voice goes to an IPv4 address when there is one. It used to take
    /// whichever came first, and on Windows "localhost" usually resolves to ::1 first. A name with
    /// IPv6 addresses only gets its voice sent over IPv6, when the device has a route there.
    /// </summary>
    public class VoiceServerAddressTests
    {
        private static readonly IPAddress V4 = IPAddress.Parse("192.168.0.10");
        private static readonly IPAddress OtherV4 = IPAddress.Parse("10.0.0.2");
        private static readonly IPAddress V6 = IPAddress.Parse("fe80::1");
        private static readonly IPAddress GlobalV6 = IPAddress.Parse("2001:db8::1");
        private const int VoicePort = 9213;

        private static readonly Func<IPAddress, bool> EveryRoute = _ => true;
        private static readonly Func<IPAddress, bool> NoRoute = _ => false;

        [Test]
        public void LocalhostResolvedIPv6FirstStillGivesTheIPv4Loopback()
        {
            var chosen = VoiceServerConnection.SelectServerAddress(new[] { IPAddress.IPv6Loopback, IPAddress.Loopback }, EveryRoute);

            Assert.That(chosen, Is.EqualTo(IPAddress.Loopback));
        }

        [Test]
        public void TheFirstIPv4AddressIsChosenWhenThereAreSeveral()
        {
            var chosen = VoiceServerConnection.SelectServerAddress(new[] { V6, V4, OtherV4 }, EveryRoute);

            Assert.That(chosen, Is.EqualTo(V4));
        }

        [Test]
        public void AnIPv4MappedIPv6AddressCountsAsIPv4()
        {
            var chosen = VoiceServerConnection.SelectServerAddress(new[] { V6, V4.MapToIPv6() }, EveryRoute);

            Assert.That(chosen, Is.EqualTo(V4));
            Assert.That(chosen.AddressFamily, Is.EqualTo(AddressFamily.InterNetwork));
        }

        [Test]
        public void AnIPv4AddressWinsOverAnEarlierIPv6Address()
        {
            Assert.That(VoiceServerConnection.SelectServerAddress(new[] { GlobalV6, V4 }, EveryRoute), Is.EqualTo(V4));
        }

        /// <summary>A server whose name has only AAAA records, its IPv4 address being behind carrier-grade NAT, say.</summary>
        [Test]
        public void OnlyIPv6AddressesGiveTheFirstOfThem()
        {
            Assert.That(VoiceServerConnection.SelectServerAddress(new[] { GlobalV6, IPAddress.IPv6Loopback }, EveryRoute), Is.EqualTo(GlobalV6));
            Assert.That(VoiceServerConnection.SelectServerAddress(new[] { IPAddress.IPv6Loopback, GlobalV6 }, EveryRoute), Is.EqualTo(IPAddress.IPv6Loopback));
        }

        /// <summary>A link-local address names no interface without a scope, so nothing can be sent to it.</summary>
        [Test]
        public void ALinkLocalIPv6AddressWithoutAScopeIsSkipped()
        {
            Assert.That(VoiceServerConnection.SelectServerAddress(new[] { V6, GlobalV6 }, EveryRoute), Is.EqualTo(GlobalV6));
            Assert.That(VoiceServerConnection.SelectServerAddress(new[] { V6 }, EveryRoute), Is.Null);
        }

        [Test]
        public void ALinkLocalIPv6AddressWithAScopeIsTaken()
        {
            var scoped = IPAddress.Parse("fe80::1%2");

            Assert.That(VoiceServerConnection.SelectServerAddress(new[] { scoped }, EveryRoute), Is.EqualTo(scoped));
        }

        [Test]
        public void NoAddressesGiveNothing()
        {
            Assert.That(VoiceServerConnection.SelectServerAddress(new IPAddress[0], EveryRoute), Is.Null);
            Assert.That(VoiceServerConnection.SelectServerAddress(null, EveryRoute), Is.Null);
        }

        /// <summary>The real resolver on this machine, which is where the ::1-first order comes from.</summary>
        [Test]
        public void LocalhostOnThisMachineGivesAnIPv4Loopback()
        {
            var chosen = VoiceServerConnection.SelectServerAddress(Dns.GetHostAddresses("localhost"),
                candidate => WebServerConnection.HasRoute(candidate, VoicePort));

            Assert.That(chosen, Is.Not.Null);
            Assert.That(chosen.AddressFamily, Is.EqualTo(AddressFamily.InterNetwork));
            Assert.That(IPAddress.IsLoopback(chosen), Is.True);
        }

        /// <summary>
        /// On Wi-Fi with IPv4 only a device has no route to a global IPv6 address, and every send
        /// to one failed at once. Such an address is skipped, and with no other voice is off.
        /// </summary>
        [Test]
        public void AnIPv6AddressWithoutARouteIsSkipped()
        {
            var routed = IPAddress.Parse("2001:db8::2");

            Assert.That(VoiceServerConnection.SelectServerAddress(new[] { GlobalV6 }, NoRoute), Is.Null);
            Assert.That(VoiceServerConnection.SelectServerAddress(new[] { GlobalV6, routed }, candidate => candidate.Equals(routed)), Is.EqualTo(routed));
        }

        /// <summary>IPv4 is taken as before, route or not: a device still joining Wi-Fi starts sending once it has one.</summary>
        [Test]
        public void AnIPv4AddressIsTakenWithoutAskingForARoute()
        {
            var asked = new List<IPAddress>();
            Func<IPAddress, bool> noRouteAsked = candidate =>
            {
                asked.Add(candidate);
                return false;
            };

            Assert.That(VoiceServerConnection.SelectServerAddress(new[] { GlobalV6, V4 }, noRouteAsked), Is.EqualTo(V4));
            Assert.That(VoiceServerConnection.SelectServerAddress(new[] { V4.MapToIPv6() }, noRouteAsked), Is.EqualTo(V4));
            Assert.That(asked, Is.Empty);
        }

        [Test]
        public void TheLoopbacksHaveARoute()
        {
            Assert.That(WebServerConnection.HasRoute(IPAddress.Loopback, VoicePort), Is.True);

            using (OpenIPv6Server())
                Assert.That(WebServerConnection.HasRoute(IPAddress.IPv6Loopback, VoicePort), Is.True);
        }

        /// <summary>
        /// The route check against a real send from this machine: where a send to a global IPv6
        /// address fails at once, as on a network with IPv4 only, the check finds no route, and
        /// where the send goes out, it finds one.
        /// </summary>
        [Test]
        public void TheRouteCheckAgreesWithASend()
        {
            if (!Socket.OSSupportsIPv6)
                Assert.Ignore("This machine has no IPv6.");

            // The discard port of a documentation address: nothing there to answer, route or not.
            var to = new IPEndPoint(GlobalV6, 9);
            bool sent;
            using (var client = new UdpClient(AddressFamily.InterNetworkV6))
            {
                try
                {
                    client.Send(new byte[] { 0 }, 1, to);
                    sent = true;
                }
                catch (SocketException)
                {
                    sent = false;
                }
            }

            Assert.That(WebServerConnection.HasRoute(to.Address, to.Port), Is.EqualTo(sent));
        }

        /// <summary>
        /// A send the device refuses is dropped with one warning until a send works again, and not
        /// thrown: thrown, it left VoiceBroadcast before the frame was taken off the recording
        /// buffer, which then grew without end. A datagram over UDP's size limit stands in for a
        /// lost route, being refused at once on every machine.
        /// </summary>
        [Test]
        public void AFailedSendIsReportedOnceAndNotThrown()
        {
            var gameObject = new GameObject("voice-under-test");
            try
            {
                var voice = gameObject.AddComponent<VoiceServerConnection>();
                using (var server = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0)))
                using (var client = VoiceServerConnection.OpenSocket(IPAddress.Loopback))
                {
                    var to = (IPEndPoint)server.Client.LocalEndPoint;
                    var tooLarge = new byte[70000];
                    var failed = new Regex($@"^Colibri voice: sending to 127\.0\.0\.1:{to.Port} failed \(MessageSize\), dropping voice until a send works again$");

                    LogAssert.Expect(LogType.Warning, failed);
                    Assert.DoesNotThrow(() => voice.SendPacket(client, to, tooLarge));
                    Assert.DoesNotThrow(() => voice.SendPacket(client, to, tooLarge));
                    LogAssert.NoUnexpectedReceived();

                    voice.SendPacket(client, to, new byte[] { 1 });
                    LogAssert.Expect(LogType.Warning, failed);
                    voice.SendPacket(client, to, tooLarge);
                    LogAssert.NoUnexpectedReceived();
                }
            }
            finally
            {
                Object.DestroyImmediate(gameObject);
            }
        }

        /// <summary>The setup the route check is for, where this machine has it: no route to a global IPv6 address.</summary>
        [Test]
        public void ASendWithoutARouteIsNotThrown()
        {
            if (!Socket.OSSupportsIPv6)
                Assert.Ignore("This machine has no IPv6.");
            if (WebServerConnection.HasRoute(GlobalV6, 9))
                Assert.Ignore("This machine has an IPv6 route to a global address.");

            var gameObject = new GameObject("voice-under-test");
            try
            {
                var voice = gameObject.AddComponent<VoiceServerConnection>();
                using (var client = VoiceServerConnection.OpenSocket(IPAddress.IPv6Loopback))
                {
                    LogAssert.Expect(LogType.Warning, new Regex(@"^Colibri voice: sending to \[2001:db8::1\]:9 failed \(NetworkUnreachable\)"));
                    Assert.DoesNotThrow(() => voice.SendPacket(client, new IPEndPoint(GlobalV6, 9), new byte[] { 1 }));
                }
            }
            finally
            {
                Object.DestroyImmediate(gameObject);
            }
        }

        /// <summary>
        /// On the IPv6 loopback, standing in for the server: the socket for an IPv6 server address is
        /// an IPv6 socket, its packet arrives, and the receive thread takes the packet relayed back to
        /// the port it came from, as voice-server.ts relays.
        /// </summary>
        [Test]
        public void VoiceGoesOutAndComesBackOverIPv6()
        {
            var server = OpenIPv6Server();
            var gameObject = new GameObject("voice-under-test");
            try
            {
                var voice = gameObject.AddComponent<VoiceServerConnection>();
                voice.UseAppName("voice-over-ipv6");
                var received = new List<VoicePacket>();
                voice.AddVoicePacketListener(7, received.Add);

                using (var client = VoiceServerConnection.OpenSocket(IPAddress.IPv6Loopback))
                using (var stop = new CancellationTokenSource())
                {
                    Assert.That(client.Client.AddressFamily, Is.EqualTo(AddressFamily.InterNetworkV6));

                    Assert.That(voice.TryEncodeToSend(7, 1, 960, Codec.PCM, new byte[] { 1, 2 }, out var packet), Is.True);
                    client.Send(packet, packet.Length, (IPEndPoint)server.Client.LocalEndPoint);
                    var from = new IPEndPoint(IPAddress.IPv6Any, 0);
                    Assert.That(server.Receive(ref from), Is.EqualTo(packet));

                    var receiving = new Thread(() => voice.Receive(client, stop.Token)) { IsBackground = true };
                    receiving.Start();
                    server.Send(packet, packet.Length, from);

                    var deadline = DateTime.UtcNow.AddSeconds(5);
                    while (received.Count == 0 && DateTime.UtcNow < deadline)
                    {
                        Thread.Sleep(10);
                        voice.DeliverReceivedPackets();
                    }

                    stop.Cancel();
                    client.Close();
                    Assert.That(receiving.Join(2000), Is.True, "The receive thread did not end when its socket was closed");
                }

                Assert.That(received.Select(p => p.Sequence), Is.EqualTo(new short[] { 1 }), "The relayed packet was not received over IPv6");
            }
            finally
            {
                server.Close();
                Object.DestroyImmediate(gameObject);
            }
        }

        private static UdpClient OpenIPv6Server()
        {
            if (!Socket.OSSupportsIPv6)
                Assert.Ignore("This machine has no IPv6.");

            try
            {
                var server = new UdpClient(new IPEndPoint(IPAddress.IPv6Loopback, 0));
                server.Client.ReceiveTimeout = 5000;
                return server;
            }
            catch (SocketException e)
            {
                Assert.Ignore($"This machine has no IPv6 loopback ({e.SocketErrorCode}).");
                return null;
            }
        }
    }
}
