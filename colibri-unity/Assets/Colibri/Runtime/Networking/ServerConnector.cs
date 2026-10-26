using System;
using System.Globalization;
using System.IO;
using System.Net.Security;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;

namespace HCIKonstanz.Colibri.Networking
{
    /// <summary>Opens a <see cref="ServerSession"/>: name lookup, TCP connect and, with TLS, the handshake.</summary>
    internal static class ServerConnector
    {
        /// <summary>
        /// Opens the TCP connection to <paramref name="host"/> and, with <paramref name="tls"/>, a TLS session
        /// over it, all within <paramref name="timeoutMs"/>: name lookup, every address tried and the
        /// handshake. The session's stream carries the v3 frames, encrypted or not.
        /// </summary>
        /// <param name="host">
        /// A name, an IPv4 address, or an IPv6 address with or without brackets. TLS uses it as it is, for SNI
        /// and the certificate check.
        /// </param>
        /// <param name="tls">The certificate check of the handshake, or null for no TLS.</param>
        /// <param name="attempting">
        /// Called with the socket for each address, before it is tried. The sockets stay this method's: it
        /// closes every one but the one it returns, and that one too if it throws.
        /// </param>
        /// <exception cref="TimeoutException">The name did not resolve, or nothing answered the connection, in time, and nothing refused it.</exception>
        /// <exception cref="TlsHandshakeException">The TLS handshake failed or did not finish in time.</exception>
        /// <exception cref="OperationCanceledException"><paramref name="token"/> was cancelled first.</exception>
        /// <exception cref="ObjectDisposedException">A socket was closed while connecting.</exception>
        /// <exception cref="SocketException">The name does not resolve, or every address failed. See <see cref="ConnectRace.ConnectAnyAsync"/> for which error.</exception>
        internal static async Task<ServerSession> OpenSessionAsync(string host, int port, ServerCertificateCheck tls, int timeoutMs,
            Action<Socket> attempting, CancellationToken token)
        {
            var clock = System.Diagnostics.Stopwatch.StartNew();
            var addresses = await AddressResolver.ResolveAsync(host, timeoutMs, token).ConfigureAwait(false);

            var remaining = (int)Math.Max(0, timeoutMs - clock.ElapsedMilliseconds);
            var (socket, address) = await ConnectRace.ConnectAnyAsync(addresses, host, port, remaining, timeoutMs, attempting, token)
                .ConfigureAwait(false);

            try
            {
                // Does not own the socket: closing it is the one way to end a session, and whoever ends the session does that.
                var plain = new NetworkStream(socket, false);
                if (tls == null)
                    return new ServerSession(socket, plain, address);

                remaining = (int)Math.Max(0, timeoutMs - clock.ElapsedMilliseconds);
                var encrypted = await AuthenticateAsync(socket, plain, host, port, tls, remaining, timeoutMs, token).ConfigureAwait(false);
                return new ServerSession(socket, encrypted, address);
            }
            catch (Exception)
            {
                ConnectRace.CloseSocket(socket);
                throw;
            }
        }

        /// <summary>
        /// The TLS handshake as a client: SNI and the certificate's name are the configured server address,
        /// and <paramref name="check"/> decides about the certificate. The TLS versions are the runtime's
        /// default: TLS 1.2 on Unity's TLS backend, 1.2 or 1.3 elsewhere. colibri-server accepts nothing
        /// older than 1.2.
        /// </summary>
        private static async Task<Stream> AuthenticateAsync(Socket socket, NetworkStream plain, string host, int port,
            ServerCertificateCheck check, int timeoutMs, int totalTimeoutMs, CancellationToken token)
        {
            var tls = new SslStream(plain, false, check.Validate);
            var handshake = tls.AuthenticateAsClientAsync(host);

            using (var timer = CancellationTokenSource.CreateLinkedTokenSource(token))
            {
                if (await Task.WhenAny(handshake, Task.Delay(timeoutMs, timer.Token)).ConfigureAwait(false) == handshake)
                {
                    timer.Cancel();
                    try
                    {
                        await handshake.ConfigureAwait(false);
                        return tls;
                    }
                    catch (Exception e)
                    {
                        // Nothing else uses the stream yet, so it can go at once.
                        tls.Dispose();
                        token.ThrowIfCancellationRequested();

                        if (check.Rejection != null)
                        {
                            throw new TlsHandshakeException(TlsHandshakeException.Failure.CertificateRejected,
                                $"rejected the certificate of {host}:{port}: {check.Rejection}", e);
                        }

                        throw new TlsHandshakeException(TlsHandshakeException.Failure.NoTlsAnswer,
                            $"{host}:{port} did not answer the TLS handshake ({e.Message})", e);
                    }
                }
            }

            // Closing the socket abandons the handshake, as with a connect. The stream is disposed and its
            // exception observed once the handshake has failed, on the thread pool rather than inline in the
            // stream's own completion of the handshake.
            ConnectRace.CloseSocket(socket);
            _ = handshake.ContinueWith(attempt =>
            {
                _ = attempt.Exception;
                tls.Dispose();
            }, CancellationToken.None, TaskContinuationOptions.None, TaskScheduler.Default);

            token.ThrowIfCancellationRequested();
            throw new TlsHandshakeException(TlsHandshakeException.Failure.NoTlsAnswer,
                $"{host}:{port} accepted the connection but did not answer the TLS handshake within "
                + $"{(totalTimeoutMs / 1000f).ToString("0.#", CultureInfo.InvariantCulture)} s");
        }

        internal static T FindCause<T>(Exception e) where T : Exception
        {
            for (var cause = e; cause != null; cause = cause.InnerException)
            {
                if (cause is T found)
                    return found;
            }

            return null;
        }
    }
}
