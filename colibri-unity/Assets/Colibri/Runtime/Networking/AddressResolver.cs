using System;
using System.Collections.Generic;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;

namespace HCIKonstanz.Colibri.Networking
{
    /// <summary>Resolves the server host to the IP addresses to try, in order, and divides the connect time among them.</summary>
    internal static class AddressResolver
    {
        // Least time one address gets when several are tried in turn (see AttemptTimeoutMs), so a name with
        // many addresses does not get shares too short to answer in. A working path answers within a second.
        private const int MIN_ADDRESS_ATTEMPT_MS = 1000;

        // Most time a loopback address gets while others are left to try. Windows reports a refused loopback
        // connect only after a second or more, which would delay "localhost" (127.0.0.1, then ::1) every time
        // against a server on ::1 only (TCP_HOST ::1).
        private const int LOOPBACK_ATTEMPT_MS = 250;

        /*
         *  Finding the server
         *
         *  The name is looked up here and each of its addresses is tried with a socket of its own family,
         *  so a name with only IPv6 addresses, or an IPv6 address, can be reached.
         */

        /// <summary>
        /// The addresses to try for <paramref name="host"/>, in order. An IP address is taken as it is. A name
        /// is looked up, and its IPv4 addresses come first, then its IPv6 addresses, each family in the order
        /// the platform's resolver gives it (RFC 6724). See <see cref="AddressesToTry"/> for why.
        /// </summary>
        /// <exception cref="SocketException">The name does not resolve, or resolves to no address.</exception>
        /// <exception cref="TimeoutException">The lookup did not finish within <paramref name="timeoutMs"/>.</exception>
        /// <exception cref="OperationCanceledException"><paramref name="token"/> was cancelled first.</exception>
        internal static Task<IReadOnlyList<IPAddress>> ResolveAsync(string host, int timeoutMs, CancellationToken token)
        {
            if (TryParseAddress(host, out var address))
                return Task.FromResult(AddressesToTry(new[] { address }));

            // The blocking lookup on the thread pool rather than GetHostAddressesAsync: neither can be cancelled
            // on Unity's .NET profile, and this one works the same on Mono and IL2CPP. An abandoned lookup holds
            // its pool thread until the resolver gives up as well.
            return WaitForLookupAsync(Task.Run(() => Dns.GetHostAddresses(host)), host, timeoutMs, token);
        }

        /// <summary>
        /// The rest of <see cref="ResolveAsync"/> for a name: waits for <paramref name="lookup"/> until it
        /// completes, the time is up or <paramref name="token"/> is cancelled.
        /// </summary>
        /// <remarks>Separate so the EditMode tests can stand in for a slow resolver with a lookup that never completes.</remarks>
        internal static async Task<IReadOnlyList<IPAddress>> WaitForLookupAsync(Task<IPAddress[]> lookup, string host, int timeoutMs, CancellationToken token)
        {
            using (var timer = CancellationTokenSource.CreateLinkedTokenSource(token))
            {
                if (await Task.WhenAny(lookup, Task.Delay(Math.Max(0, timeoutMs), timer.Token)).ConfigureAwait(false) == lookup)
                {
                    timer.Cancel();

                    // Rethrows a lookup that failed by itself: HostNotFound, say.
                    var addresses = AddressesToTry(await lookup.ConfigureAwait(false));
                    if (addresses.Count == 0)
                        throw new SocketException((int)SocketError.HostNotFound);

                    return addresses;
                }
            }

            // Nothing waits for the abandoned lookup any more, so its exception is observed here
            // rather than surfacing as unobserved later.
            _ = lookup.ContinueWith(attempt => { _ = attempt.Exception; }, CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);

            token.ThrowIfCancellationRequested();
            throw new TimeoutException(
                $"{host} could not be resolved within {(timeoutMs / 1000f).ToString("0.#", CultureInfo.InvariantCulture)} s");
        }

        /// <summary>
        /// Whether <paramref name="host"/> is an IP address rather than a name: an IPv4 address, or an IPv6
        /// address with or without the brackets a URL puts around one ("[2001:db8::1]").
        /// </summary>
        internal static bool TryParseAddress(string host, out IPAddress address)
        {
            address = null;
            if (string.IsNullOrEmpty(host))
                return false;

            if (host.Length > 2 && host[0] == '[' && host[host.Length - 1] == ']')
            {
                // As in a URL, brackets hold an IPv6 address and nothing else.
                if (IPAddress.TryParse(host.Substring(1, host.Length - 2), out var bracketed)
                    && bracketed.AddressFamily == AddressFamily.InterNetworkV6)
                {
                    address = bracketed;
                    return true;
                }

                return false;
            }

            return IPAddress.TryParse(host, out address);
        }

        /// <summary>
        /// Whether the device has a route to <paramref name="address"/>. Connecting a UDP socket sends
        /// nothing: it only looks the route up, and fails at once without one.
        /// </summary>
        /// <remarks>Also used by VoiceServerConnection.</remarks>
        internal static bool HasRoute(IPAddress address, int port)
        {
            try
            {
                using (var probe = new Socket(address.AddressFamily, SocketType.Dgram, ProtocolType.Udp))
                {
                    probe.Connect(new IPEndPoint(address, port));
                    return true;
                }
            }
            catch (Exception)
            {
                // NetworkUnreachable, or no sockets of that family on this device or runtime, which
                // a connection or a voice socket would fail on as well.
                return false;
            }
        }

        /// <summary>
        /// What a lookup found, ready to be tried in order: each address once, the IPv4 addresses first and
        /// then the IPv6 addresses, each family in the order found, and an IPv4-mapped IPv6 address as the IPv4
        /// address it stands for, which an IPv4 socket reaches on every platform.
        /// </summary>
        /// <remarks>
        /// IPv4 first because voice goes to an IPv4 address whenever the name has one
        /// (VoiceServerAddress.SelectServerAddress), and colibri-server relays voice only from the source
        /// address of a TCP connection of the same app (voice-admission.ts, admit). With TCP on IPv6 and voice on
        /// IPv4 the addresses differ and every voice packet is dropped, e.g. "localhost" on Windows against a
        /// server on TCP_HOST ::. A name with only IPv6 addresses still connects over IPv6, and voice follows.
        /// </remarks>
        internal static IReadOnlyList<IPAddress> AddressesToTry(IPAddress[] found)
        {
            var addresses = new List<IPAddress>();
            if (found == null)
                return addresses;

            var ipv6 = new List<IPAddress>();
            foreach (var candidate in found)
            {
                var address = candidate.IsIPv4MappedToIPv6 ? candidate.MapToIPv4() : candidate;
                var family = address.AddressFamily == AddressFamily.InterNetwork ? addresses : ipv6;
                if (!family.Contains(address))
                    family.Add(address);
            }

            addresses.AddRange(ipv6);
            return addresses;
        }

        /// <summary>
        /// How long the attempt on one of several addresses may take: an equal share of
        /// <paramref name="remainingMs"/> among <paramref name="attemptsLeft"/> addresses, this one and those
        /// after it that the device has a route to, but at least <see cref="MIN_ADDRESS_ATTEMPT_MS"/>, and for
        /// a loopback address at most <see cref="LOOPBACK_ATTEMPT_MS"/>. The last address gets all the time
        /// left, and no attempt more than that.
        /// </summary>
        internal static int AttemptTimeoutMs(int remainingMs, int attemptsLeft, bool isLoopback)
        {
            if (attemptsLeft <= 1)
                return remainingMs;

            var share = Math.Max(remainingMs / attemptsLeft, MIN_ADDRESS_ATTEMPT_MS);
            if (isLoopback)
                share = Math.Min(share, LOOPBACK_ATTEMPT_MS);

            return Math.Min(share, remainingMs);
        }

        /// <summary>An address as a URL writes it: IPv6 in brackets.</summary>
        internal static string HostOf(IPAddress address)
            => address.AddressFamily == AddressFamily.InterNetworkV6 ? $"[{address}]" : address.ToString();

        internal static string Endpoint(IPAddress address, int port) => $"{HostOf(address)}:{port}";
    }
}
