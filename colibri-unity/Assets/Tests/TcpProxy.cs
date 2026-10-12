using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;
using HCIKonstanz.Colibri.Networking.Protocol;

namespace HCIKonstanz.Colibri.E2E
{
    /// <summary>
    /// A pass-through between the Unity client and the real server that a test can cut, for the
    /// outage a real network produces and a test cannot: the client loses its connection while the
    /// server, and every other client on the app, carries on. A C# port of the idea in
    /// <c>colibri-server/test/tcp-wire-tap.ts</c>.
    ///
    /// It also records every message the client sends, by connection, which is what lets a test
    /// see what went out on the session after a reconnect and in which order. Over TLS it either
    /// passes the encrypted bytes on as they are, recording nothing, or ends the client's TLS
    /// itself, with the certificate of <see cref="TestTls"/>, and speaks TLS on to the server.
    /// </summary>
    public sealed class TcpProxy : IDisposable
    {
        private readonly TcpListener _listener;
        private readonly string _upstreamHost;
        private readonly int _upstreamPort;
        private readonly bool _recordMessages;
        private readonly bool _terminateTls;
        private readonly CancellationTokenSource _lifetime = new CancellationTokenSource();
        private readonly List<TcpClient> _open = new List<TcpClient>();
        private readonly List<(int Session, DecodedFrame Frame)> _fromClient = new List<(int, DecodedFrame)>();
        private readonly List<(int Session, DecodedFrame Frame)> _swallowed = new List<(int, DecodedFrame)>();
        private int _sessions;
        private int _unpluggedUpTo;
        private volatile bool _isHolding;

        public int Port { get; }

        /// <summary>
        /// While set, a new connection is accepted but not passed on until this is cleared: the
        /// client's handshake waits in the socket, and nothing reaches it, so it stays reconnecting.
        /// Lets a test finish something on the server before the client is back - within the 2 s
        /// the client's watchdog gives a silent server.
        /// </summary>
        public bool HoldNewConnections
        {
            get => _isHolding;
            set => _isHolding = value;
        }

        /// <summary>How many connections the client has made through the proxy.</summary>
        public int Sessions => Volatile.Read(ref _sessions);

        /// <summary>
        /// Every message frame the client sent that was passed on to the server, with the 1-based
        /// connection it came on.
        /// </summary>
        public (int Session, DecodedFrame Frame)[] FromClient
        {
            get
            {
                lock (_fromClient)
                    return _fromClient.ToArray();
            }
        }

        /// <summary>The message frames the client wrote into a connection after <see cref="Unplug"/>, which never reached the server.</summary>
        public (int Session, DecodedFrame Frame)[] Swallowed
        {
            get
            {
                lock (_fromClient)
                    return _swallowed.ToArray();
            }
        }

        private TcpProxy(TcpListener listener, string upstreamHost, int upstreamPort, bool recordMessages, bool terminateTls)
        {
            _listener = listener;
            _upstreamHost = upstreamHost;
            _upstreamPort = upstreamPort;
            _recordMessages = recordMessages;
            _terminateTls = terminateTls;
            Port = ((IPEndPoint)listener.LocalEndpoint).Port;
        }

        /// <param name="recordMessages">
        /// False for a TLS connection passed through, whose bytes cannot be read here: they are
        /// passed on as they are, and <see cref="FromClient"/> stays empty.
        /// </param>
        /// <param name="terminateTls">
        /// True for a client that speaks TLS to a server that does too: the proxy is the TLS server
        /// for the client, with <see cref="TestTls.Certificate"/>, which the client then has to
        /// accept, and a TLS client to the server. What it passes on in between, it can record.
        /// </param>
        public static TcpProxy Start(string upstreamHost, int upstreamPort, bool recordMessages = true, bool terminateTls = false)
        {
            // Here rather than at the first connection, so that a certificate that cannot be loaded
            // fails the test that asked for it, saying why.
            if (terminateTls)
                _ = TestTls.Certificate;

            // The loopback of the server's address family: the client is pointed at the proxy by the
            // server's host name (E2EServer.ConfigureInProcess), so for "::1" it has to be the IPv6 one.
            var host = upstreamHost.Length > 2 && upstreamHost[0] == '[' && upstreamHost[upstreamHost.Length - 1] == ']'
                ? upstreamHost.Substring(1, upstreamHost.Length - 2)
                : upstreamHost;
            var loopback = IPAddress.TryParse(host, out var address) && address.AddressFamily == AddressFamily.InterNetworkV6
                ? IPAddress.IPv6Loopback
                : IPAddress.Loopback;
            var listener = new TcpListener(loopback, 0);
            listener.Start();

            var proxy = new TcpProxy(listener, upstreamHost, upstreamPort, recordMessages, terminateTls);
            _ = proxy.AcceptLoop();
            return proxy;
        }

        /// <summary>
        /// Resets both halves of every open connection. The client sees a connection reset, as
        /// from a dropped link; the server sees the client go, and keeps serving everyone else.
        /// </summary>
        public void Cut()
        {
            TcpClient[] open;
            lock (_open)
            {
                open = _open.ToArray();
                _open.Clear();
            }

            foreach (var client in open)
                Reset(client);
        }

        /// <summary>
        /// The link goes dead without either end being told, as when a headset's Wi-Fi drops: from
        /// now on what the client writes into the open connection is swallowed, and nothing more
        /// reaches it. Its writes still succeed, so it only finds out once its heartbeat watchdog
        /// gives up on the silent server, about 2 s later. The server keeps the session until the
        /// client closes it; the connection the client makes next is passed on as usual.
        /// </summary>
        /// <remarks>
        /// <see cref="Cut"/> resets the connection instead, which the client notices at once: a
        /// write after that fails, and the client sends it again on the next connection. Only a link
        /// that dies silently loses what is written into it.
        /// </remarks>
        public void Unplug() => Volatile.Write(ref _unpluggedUpTo, Sessions);

        public void Dispose()
        {
            _lifetime.Cancel();
            _listener.Stop();
            Cut();
            _lifetime.Dispose();
        }

        private async Task AcceptLoop()
        {
            while (!_lifetime.IsCancellationRequested)
            {
                TcpClient downstream;
                try
                {
                    downstream = await _listener.AcceptTcpClientAsync().ConfigureAwait(false);
                }
                catch (Exception)
                {
                    return; // listener stopped
                }

                var session = Interlocked.Increment(ref _sessions);
                _ = Relay(downstream, session);
            }
        }

        private async Task Relay(TcpClient downstream, int session)
        {
            TcpClient upstream = null;
            downstream.NoDelay = true;

            lock (_open)
                _open.Add(downstream);

            Stream client = null;
            Stream server = null;
            try
            {
                client = downstream.GetStream();
                if (_terminateTls)
                    client = await TestTls.AcceptAsync(client).ConfigureAwait(false);

                // Held after the client's TLS, if any: what the client sees while it is held is a
                // connection that has been accepted and says nothing, with or without TLS.
                while (_isHolding)
                    await Task.Delay(10, _lifetime.Token).ConfigureAwait(false);

                upstream = await E2EServer.ConnectTcpAsync(_upstreamHost, _upstreamPort, noDelay: true).ConfigureAwait(false);
                lock (_open)
                    _open.Add(upstream);
                server = upstream.GetStream();
                if (_terminateTls)
                    server = await TestTls.ConnectAsync(server, _upstreamHost).ConfigureAwait(false);

                var toServer = Pump(client, server, session, fromClient: true);
                var toClient = Pump(server, client, session, fromClient: false);

                // Either direction ending ends the session, as a broken link would.
                await Task.WhenAny(toServer, toClient).ConfigureAwait(false);
            }
            catch (Exception)
            {
                // Cut, or the server went away; the session is over either way.
            }
            finally
            {
                lock (_open)
                {
                    _open.Remove(downstream);
                    if (upstream != null)
                        _open.Remove(upstream);
                }

                Reset(downstream);
                if (upstream != null)
                    Reset(upstream);
                CloseQuietly(client);
                CloseQuietly(server);
            }
        }

        /// <param name="fromClient">Whether this is the client's direction, whose messages are recorded.</param>
        private async Task Pump(Stream from, Stream to, int session, bool fromClient)
        {
            var reader = fromClient && _recordMessages ? new FrameReader() : null;
            var buffer = new byte[16 * 1024];

            while (true)
            {
                var read = await from.ReadAsync(buffer, 0, buffer.Length, _lifetime.Token).ConfigureAwait(false);
                if (read <= 0)
                    return;

                // Still read after Unplug, in both directions, so the session ends as soon as
                // either end closes it.
                var unplugged = session <= Volatile.Read(ref _unpluggedUpTo);

                if (reader != null)
                    Record(reader, buffer, read, session, unplugged);

                if (!unplugged)
                    await to.WriteAsync(buffer, 0, read, _lifetime.Token).ConfigureAwait(false);
            }
        }

        /// <summary>Out of the async method because a ReadOnlySpan cannot live in one.</summary>
        private void Record(FrameReader reader, byte[] buffer, int count, int session, bool swallowed)
        {
            foreach (var frame in reader.Append(new ReadOnlySpan<byte>(buffer, 0, count)))
            {
                if (frame.Type != FrameType.Message)
                    continue;

                lock (_fromClient)
                    (swallowed ? _swallowed : _fromClient).Add((session, frame));
            }
        }

        private static void CloseQuietly(Stream stream)
        {
            try
            {
                stream?.Dispose();
            }
            catch (Exception)
            {
                // The connection under it is gone already.
            }
        }

        private static void Reset(TcpClient client)
        {
            try
            {
                client.Client.LingerState = new LingerOption(true, 0);
                client.Close();
            }
            catch (Exception)
            {
                // Already closed.
            }
        }
    }
}
