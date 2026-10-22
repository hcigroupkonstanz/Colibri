using System;
using System.Collections.Generic;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Runtime.ExceptionServices;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;

namespace HCIKonstanz.Colibri.Networking
{
    internal static class ConnectRace
    {
        // How often WaitForConnectAsync checks whether the socket was closed, which Mono does not report by itself.
        private const int CLOSED_SOCKET_CHECK_MS = 100;

        /// <summary>
        /// Connects to the first of <paramref name="addresses"/> that answers. They are tried in order, each
        /// with a socket of its own family and the time <see cref="AddressResolver.AttemptTimeoutMs"/> gives it, and the next
        /// is tried at once when one is refused or unreachable. When every address fails, the error that says
        /// the most about the server is reported (see <see cref="FailureRank"/>), the first of equals.
        /// </summary>
        /// <param name="host">The server address as configured, for the messages.</param>
        /// <param name="timeoutMs">The time all attempts together may take.</param>
        /// <param name="totalTimeoutMs">The time the whole connection had, lookup included, which a timeout names.</param>
        /// <param name="attempting">See <see cref="ServerConnector.OpenSessionAsync"/>.</param>
        /// <returns>The connected socket, and the address it is connected to.</returns>
        /// <exception cref="TimeoutException">No address refused, and one did not answer within its time, or no time was left to try one.</exception>
        /// <exception cref="SocketException">Every address failed, and one refused or none went unanswered: the first refusal, or else the first address's error.</exception>
        /// <exception cref="OperationCanceledException"><paramref name="token"/> was cancelled first.</exception>
        /// <exception cref="ObjectDisposedException">A socket was closed while connecting.</exception>
        /// <remarks>Asks <see cref="AddressResolver.HasRoute"/> which addresses the device has a route to.</remarks>
        internal static Task<(Socket Socket, IPAddress Address)> ConnectAnyAsync(IReadOnlyList<IPAddress> addresses, string host,
            int port, int timeoutMs, int totalTimeoutMs, Action<Socket> attempting, CancellationToken token)
            => ConnectAnyAsync(addresses, host, port, timeoutMs, totalTimeoutMs, address => AddressResolver.HasRoute(address, port), attempting, token);

        /// <summary>
        /// The overload that asks <paramref name="hasRoute"/> instead of <see cref="AddressResolver.HasRoute"/> whether the
        /// device has a route to an address, so the EditMode tests can decide.
        /// </summary>
        internal static async Task<(Socket Socket, IPAddress Address)> ConnectAnyAsync(IReadOnlyList<IPAddress> addresses, string host,
            int port, int timeoutMs, int totalTimeoutMs, Func<IPAddress, bool> hasRoute, Action<Socket> attempting, CancellationToken token)
        {
            var clock = System.Diagnostics.Stopwatch.StartNew();
            var routedAfter = CountRoutedAfter(addresses, hasRoute);
            Exception failure = null;

            for (var i = 0; i < addresses.Count; i++)
            {
                token.ThrowIfCancellationRequested();

                var remaining = timeoutMs - clock.ElapsedMilliseconds;
                if (remaining <= 0)
                    break;

                // Shared only with the addresses after this one that the device has a route to. One without fails at
                // once, as an IPv6 address does on Wi-Fi without IPv6, and counting it would leave the IPv4 address
                // before it half of the 5 s, too short for a connection that needs a third SYN.
                var address = addresses[i];
                var attemptMs = AddressResolver.AttemptTimeoutMs((int)remaining, 1 + routedAfter[i], IPAddress.IsLoopback(address));

                Socket socket = null;
                var connected = false;
                try
                {
                    socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
                    attempting?.Invoke(socket);

                    // Closes the socket at once if the token is cancelled already.
                    using (token.Register(() => CloseSocket(socket)))
                        await ConnectAsync(socket, address, port, attemptMs, token).ConfigureAwait(false);

                    connected = true;
                    return (socket, address);
                }
                catch (Exception e) when (!(e is ObjectDisposedException) && !token.IsCancellationRequested)
                {
                    // Refused, unreachable, an address family this device has no sockets for, no answer within this
                    // address's share, or anything else a runtime throws for one address family and not the other: the
                    // next address may still answer.
                    if (failure == null || FailureRank(e) > FailureRank(failure))
                        failure = e;

                    if (i + 1 < addresses.Count && clock.ElapsedMilliseconds < timeoutMs)
                    {
                        var next = AddressResolver.Endpoint(addresses[i + 1], port);
                        // Two decimals, so a loopback address's 250 ms does not read as 0.3 s. "No connection", not "no
                        // answer": Windows reports a refused loopback connect only after about a second, so an address given
                        // up on after 250 ms may have refused.
                        Debug.Log(e is TimeoutException
                            ? $"Colibri: no connection to {AddressResolver.Endpoint(address, port)} within "
                                + $"{(attemptMs / 1000f).ToString("0.##", CultureInfo.InvariantCulture)} s, trying {next}"
                            : $"Colibri: no connection to {AddressResolver.Endpoint(address, port)} "
                                + $"({(e is SocketException refused ? refused.SocketErrorCode.ToString() : e.Message)}), trying {next}");
                    }
                }
                finally
                {
                    if (!connected)
                        CloseSocket(socket);
                }
            }

            token.ThrowIfCancellationRequested();

            // Whether the server refused or did not answer is what tells what is wrong.
            if (failure != null && !(failure is TimeoutException))
                ExceptionDispatchInfo.Capture(failure).Throw();

            // Invariant culture: this ends up in the log and on screen, and should read the same in every locale.
            throw new TimeoutException(
                $"{host}:{port} did not answer within {(totalTimeoutMs / 1000f).ToString("0.#", CultureInfo.InvariantCulture)} s", failure);
        }

        /// <summary>
        /// For each of <paramref name="addresses"/>, how many of those after it the device has a
        /// route to. Asks <paramref name="hasRoute"/> once about each address but the first, which
        /// comes after none, before any is tried: an address without a route stays in the list, so
        /// that it is still tried and its error can be reported.
        /// </summary>
        private static int[] CountRoutedAfter(IReadOnlyList<IPAddress> addresses, Func<IPAddress, bool> hasRoute)
        {
            var counts = new int[addresses.Count];
            for (var i = addresses.Count - 1; i > 0; i--)
                counts[i - 1] = counts[i] + (hasRoute(addresses[i]) ? 1 : 0);

            return counts;
        }

        /// <summary>
        /// How much a failed attempt says about the server, to choose the error reported when every address
        /// failed. A refusal says the most (the machine is there, nothing listens on the port), then no
        /// answer, then anything else, which is about the path to the server.
        /// </summary>
        /// <remarks>
        /// An IPv6 address tried after IPv4 on a network without IPv6 fails as unreachable, which would hide a
        /// refused IPv4 address and make a stopped server read as no route. A refusal beats no answer because
        /// Windows reports a refused loopback connect only after a second or more: with no server running,
        /// "localhost" gives up on 127.0.0.1 after 0.25 s, ::1 then refuses, and the timeout would point to
        /// the address and the network rather than to starting the server.
        /// </remarks>
        private static int FailureRank(Exception failure)
        {
            if (failure is SocketException refused && refused.SocketErrorCode == SocketError.ConnectionRefused)
                return 2;

            return failure is TimeoutException ? 1 : 0;
        }

        /// <summary>
        /// Opens the TCP connection to one address, or gives up after <paramref name="timeoutMs"/>. Giving up
        /// closes the socket, the only way to abandon a pending connect on this API surface, so the socket
        /// cannot be used again.
        /// </summary>
        /// <exception cref="TimeoutException">Nothing answered in time.</exception>
        /// <exception cref="OperationCanceledException"><paramref name="token"/> was cancelled first.</exception>
        /// <exception cref="ObjectDisposedException">The socket was closed first.</exception>
        /// <exception cref="SocketException">The attempt failed before the time was up, refused, say.</exception>
        internal static async Task ConnectAsync(Socket socket, IPAddress address, int port, int timeoutMs, CancellationToken token)
        {
            var connecting = socket.ConnectAsync(address, port);
            await WaitForConnectAsync(socket, connecting, AddressResolver.HostOf(address), port, timeoutMs, token).ConfigureAwait(false);
        }

        /// <summary>
        /// The rest of <see cref="ConnectAsync"/>: waits for <paramref name="connecting"/>, the connect in
        /// progress on <paramref name="socket"/>, until it completes, the time is up,
        /// <paramref name="token"/> is cancelled or the socket is closed.
        /// </summary>
        /// <remarks>
        /// Looks at the socket every <see cref="CLOSED_SOCKET_CHECK_MS"/> because on Mono a connect whose
        /// socket is closed neither completes nor fails, so it would wait out the whole timeout and report a
        /// server that may well have answered as not answering. The EditMode tests stand in for that with a
        /// connect that never completes.
        /// </remarks>
        internal static async Task WaitForConnectAsync(Socket socket, Task connecting, string host, int port, int timeoutMs, CancellationToken token)
        {
            var clock = System.Diagnostics.Stopwatch.StartNew();
            var closed = false;

            using (var timer = CancellationTokenSource.CreateLinkedTokenSource(token))
            {
                while (true)
                {
                    var remaining = timeoutMs - clock.ElapsedMilliseconds;
                    if (remaining <= 0)
                        break;

                    await Task.WhenAny(connecting, Task.Delay((int)Math.Min(remaining, CLOSED_SOCKET_CHECK_MS), timer.Token))
                        .ConfigureAwait(false);

                    if (token.IsCancellationRequested)
                        break;

                    if (IsClosed(socket))
                    {
                        closed = true;
                        break;
                    }

                    if (connecting.IsCompleted)
                    {
                        timer.Cancel();

                        // Rethrows a connect that failed by itself.
                        await connecting.ConfigureAwait(false);
                        return;
                    }
                }
            }

            CloseSocket(socket);

            // Nothing waits for the abandoned connect any more. On .NET it now fails with the closed socket, and
            // its exception is observed here rather than surfacing as unobserved later; on Mono it may never complete.
            _ = connecting.ContinueWith(attempt => { _ = attempt.Exception; }, CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);

            token.ThrowIfCancellationRequested();
            if (closed)
                throw new ObjectDisposedException(typeof(Socket).FullName, $"The socket was closed while connecting to {host}:{port}.");

            // Invariant culture: this ends up in the log and on screen, and should read the same in every locale.
            throw new TimeoutException(
                $"{host}:{port} did not answer within {(timeoutMs / 1000f).ToString("0.#", CultureInfo.InvariantCulture)} s");
        }

        private static bool IsClosed(Socket socket)
        {
            try
            {
                // Looks without waiting, and throws ObjectDisposedException on a closed socket, on
                // .NET, Mono and IL2CPP alike.
                socket.Poll(0, SelectMode.SelectError);
                return false;
            }
            catch (ObjectDisposedException)
            {
                return true;
            }
            catch (SocketException)
            {
                // Open, but in a state the connect will report itself.
                return false;
            }
        }

        internal static void CloseSocket(Socket socket)
        {
            if (socket == null)
                return;

            try
            {
                socket.Close();
            }
            catch (ObjectDisposedException)
            {
                // Already closed: closing is idempotent here, since OnDisable, the heartbeat watchdog and the
                // session's own teardown can race.
            }
            catch (Exception e)
            {
                Debug.LogWarning($"Colibri: error while closing socket: {e.Message}");
            }
        }
    }
}
