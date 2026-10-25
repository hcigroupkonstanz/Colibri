using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using UnityEngine;

namespace HCIKonstanz.Colibri.Networking
{
    /// <summary>
    /// Chooses the address voice is sent to and opens the UDP socket for it. Main thread only, except
    /// <see cref="AnyAddress"/>, which the receive thread also calls.
    /// </summary>
    internal static class VoiceServerAddress
    {
        /// <summary>
        /// The address to send voice to, out of what the server address resolved to, or null,
        /// with the reason in <paramref name="failure"/>, when there is none.
        /// </summary>
        internal static IPAddress ResolveServerAddress(string host, int port, IReadOnlyList<IPAddress> resolved, out string failure)
        {
            var candidates = new IPAddress[resolved.Count];
            for (var i = 0; i < resolved.Count; i++)
                candidates[i] = resolved[i];

            failure = null;
            var address = SelectServerAddress(candidates, candidate => AddressResolver.HasRoute(candidate, port));
            if (address == null)
            {
                var found = candidates.Length == 0 ? "no addresses at all" : string.Join<IPAddress>(", ", candidates);
                failure = Array.Exists(candidates, IsSendableIPv6)
                    ? $"the server address '{host}' has only IPv6 addresses ({found}), and this device has no route to them, as on a network with IPv4 only"
                    : $"the server address '{host}' resolved to {found}, none of which voice can be sent to";
            }

            return address;
        }

        /// <summary>
        /// Picks the address voice goes to, out of everything a name resolved to: IPv4 when the
        /// name has an IPv4 address, otherwise IPv6 that <paramref name="hasRoute"/> says the
        /// device has a route to.
        /// </summary>
        /// <remarks>
        /// IPv4 first because every server takes voice over IPv4, but not every one over IPv6: not
        /// with VOICE_HOST 0.0.0.0, nor behind a proxy on IPv4 only (voice-server.ts). Taking the
        /// first address regardless broke on Windows, where "localhost" commonly resolves to ::1
        /// before 127.0.0.1: every packet went to an IPv6 address that nothing listened on, and no
        /// voice ever reached the server. An IPv4-mapped IPv6 address is as good as the IPv4
        /// address inside it. IPv6 is for a name with no IPv4 address at all, such as a server
        /// whose IPv4 address is behind carrier-grade NAT. A link-local IPv6 address without a
        /// scope (an interface) cannot be sent to, and is skipped. So is an IPv6 address without a
        /// route: on Wi-Fi with IPv4 only, which gives a device a link-local IPv6 address and
        /// nothing more, every send to it failed at once. IPv4 is taken without asking, as before
        /// IPv6 was an option: a device still joining Wi-Fi has no route yet, and starts sending
        /// once it has one.
        /// </remarks>
        /// <param name="hasRoute">Whether the device has a route to an IPv6 address; see <see cref="AddressResolver.HasRoute"/>.</param>
        /// <returns>An IPv4 or IPv6 address, or null when there is none voice can be sent to.</returns>
        internal static IPAddress SelectServerAddress(IPAddress[] candidates, Func<IPAddress, bool> hasRoute)
        {
            if (candidates == null)
                return null;

            foreach (var candidate in candidates)
            {
                if (candidate.AddressFamily == AddressFamily.InterNetwork)
                    return candidate;
            }

            foreach (var candidate in candidates)
            {
                if (candidate.AddressFamily == AddressFamily.InterNetworkV6 && candidate.IsIPv4MappedToIPv6)
                    return candidate.MapToIPv4();
            }

            foreach (var candidate in candidates)
            {
                if (IsSendableIPv6(candidate) && hasRoute(candidate))
                    return candidate;
            }

            return null;
        }

        private static bool IsSendableIPv6(IPAddress address)
            => address.AddressFamily == AddressFamily.InterNetworkV6 && !(address.IsIPv6LinkLocal && address.ScopeId == 0);

        /// <summary>
        /// The voice socket for <paramref name="address"/>: of its family, on a port of the
        /// operating system's choosing. Null, having said why, when the device cannot open one,
        /// such as an IPv6 socket on a device without IPv6.
        /// </summary>
        /// <remarks>Internal for the EditMode tests.</remarks>
        internal static UdpClient OpenSocket(IPAddress address)
        {
            var family = address.AddressFamily;
            UdpClient client = null;
            try
            {
                client = new UdpClient(family);
                // Port 0 lets the OS pick an ephemeral port. The server replies to whatever
                // source port the datagram came from (voice-server.ts), so the hardcoded 9014
                // this used to bind bought nothing and capped a machine at one Unity client.
                client.Client.Bind(new IPEndPoint(AnyAddress(family), 0));
                return client;
            }
            catch (Exception e)
            {
                client?.Close();
                var reason = e is SocketException socketError ? socketError.SocketErrorCode.ToString() : e.Message;
                Debug.LogError($"Colibri voice: could not open a socket to send voice to {address} ({reason}). Voice chat is off.");
                return null;
            }
        }

        internal static IPAddress AnyAddress(AddressFamily family)
            => family == AddressFamily.InterNetworkV6 ? IPAddress.IPv6Any : IPAddress.Any;
    }
}
