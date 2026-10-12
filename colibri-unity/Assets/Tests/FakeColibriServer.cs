using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using HCIKonstanz.Colibri.Networking.Protocol;

namespace HCIKonstanz.Colibri.E2E
{
    /// <summary>
    /// A stand-in for colibri-server that a test can script, for the connection behaviour a real
    /// server will not produce on demand: hanging up, saying nothing, refusing this client, or
    /// speaking the 1.x framing.
    ///
    /// What happens to a connection is decided when it is accepted, by <see cref="Mode"/>, so a
    /// test walks the client through a sequence of sessions by changing it between attempts - the
    /// reconnect backoff leaves at least half a second for that. It speaks the v3 framing through
    /// the package's own <see cref="FrameCodec"/>, like <see cref="TcpPeer"/> does, over plain TCP
    /// or, started with TLS, inside TLS with the certificate of <see cref="TestTls"/>.
    /// </summary>
    public sealed class FakeColibriServer : IDisposable
    {
        public enum Behaviour
        {
            /// <summary>
            /// Reads the client's handshake and then hangs up cleanly, without a word. Waiting for
            /// the handshake keeps it deterministic: hanging up first races the client's write, and
            /// a session that ends before the handshake is sent is not a statement about the server.
            /// </summary>
            HangUpAfterHandshake,

            /// <summary>Accepts and keeps the connection open, but never sends a byte.</summary>
            Silent,

            /// <summary>
            /// What a live server looks like from the client: it reads the handshake, accepts it,
            /// and from then on heartbeats every 100 ms. Nothing before the handshake: colibri-server
            /// only heartbeats the clients it has accepted, so the first frame a client sees is a
            /// heartbeat after acceptance - or, from <see cref="Refuse"/>, the refusal.
            /// </summary>
            Heartbeat,

            /// <summary>
            /// What a newer server does with this client: refuses its protocol version as the very
            /// first frame, then hangs up - the way colibri-server's <c>rejectProtocolVersion</c>
            /// does it, with the refusal and the FIN queued together.
            /// </summary>
            Refuse,

            /// <summary>
            /// What colibri-server did before it stopped heartbeating clients it had not accepted:
            /// a heartbeat from the moment the connection is accepted, handshake or not, and only
            /// then - having read the handshake - the refusal. To the client that is a session that
            /// already counts as connected when it is refused. No current server does this; it is
            /// here for the test that keeps the client correct against one that does.
            /// </summary>
            HeartbeatThenRefuse,

            /// <summary>
            /// What a 1.x server sends: its heartbeat, <c>"\0\0\0h\0"</c>, every 100 ms from the
            /// moment it accepts, handshake or not, and nothing else. Started with TLS, it is a 1.x
            /// server behind a TLS-terminating proxy.
            /// </summary>
            SpeakV1,
        }

        private static readonly byte[] V1Heartbeat = { 0, 0, 0, (byte)'h', 0 };

        private readonly TcpListener _listener;
        private readonly CancellationTokenSource _lifetime = new CancellationTokenSource();
        private readonly Stopwatch _clock = Stopwatch.StartNew();
        private readonly List<double> _acceptTimes = new List<double>();
        private readonly List<TcpClient> _open = new List<TcpClient>();
        private readonly List<(int Session, DecodedFrame Frame)> _received = new List<(int, DecodedFrame)>();
        private int _accepted;
        private int _echoes;
        private volatile Behaviour _mode;
        private readonly int _readBytesPerSecond;
        private readonly bool _useTls;

        public int Port { get; }

        /// <summary>Applies to the next connection accepted, not to the ones already open.</summary>
        public Behaviour Mode
        {
            get => _mode;
            set => _mode = value;
        }

        /// <summary>The protocol version a <see cref="Behaviour.Refuse"/> session says it speaks.</summary>
        public string RefusingServerVersion { get; set; } = "3";

        public int Accepted => Volatile.Read(ref _accepted);

        /// <summary>When each connection was accepted, in milliseconds since the server started.</summary>
        public double[] AcceptTimes
        {
            get
            {
                lock (_acceptTimes)
                    return _acceptTimes.ToArray();
            }
        }

        /// <summary>How many heartbeat echoes <see cref="Behaviour.Heartbeat"/> sessions have read.</summary>
        public int Echoes => Volatile.Read(ref _echoes);

        /// <summary>
        /// Every message frame a client sent, with the 1-based number of the connection it came on.
        /// Only recorded by <see cref="Behaviour.Heartbeat"/> sessions; heartbeat echoes are left out.
        /// </summary>
        public (int Session, DecodedFrame Frame)[] Received
        {
            get
            {
                lock (_received)
                    return _received.ToArray();
            }
        }

        private FakeColibriServer(TcpListener listener, Behaviour mode, int readBytesPerSecond, bool useTls)
        {
            _listener = listener;
            _mode = mode;
            _readBytesPerSecond = readBytesPerSecond;
            _useTls = useTls;
            Port = ((IPEndPoint)listener.LocalEndpoint).Port;
        }

        /// <param name="readBytesPerSecond">
        /// For a slow link: <see cref="Behaviour.Heartbeat"/> sessions read no faster than this, and
        /// the operating system buffers only a little on the way in, so a client writing more than
        /// that waits for the link. 0 reads as fast as the client writes.
        /// </param>
        /// <param name="useTls">
        /// Whether each connection is TLS, with <see cref="TestTls.Certificate"/>: what a client
        /// with "Server supports SSL/TLS" ticked and that certificate pinned can connect to.
        /// </param>
        public static FakeColibriServer Start(Behaviour mode, int readBytesPerSecond = 0, bool useTls = false)
        {
            // Here rather than at the first connection, so that a certificate that cannot be loaded
            // fails the test that asked for it, saying why.
            if (useTls)
                _ = TestTls.Certificate;

            var listener = new TcpListener(IPAddress.Loopback, 0);

            // Before Start: the accepted connections inherit it, and the receive window is agreed
            // when they open.
            if (readBytesPerSecond > 0)
                listener.Server.ReceiveBufferSize = 64 * 1024;

            listener.Start();

            var server = new FakeColibriServer(listener, mode, readBytesPerSecond, useTls);
            _ = server.AcceptLoop();
            return server;
        }

        /// <summary>
        /// Resets every open connection (RST rather than FIN), which the client sees as a
        /// SocketException - the way a dropped Wi-Fi link or a killed server usually ends.
        /// </summary>
        public void ResetConnections()
        {
            TcpClient[] open;
            lock (_open)
            {
                open = _open.ToArray();
                _open.Clear();
            }

            foreach (var client in open)
            {
                try
                {
                    client.Client.LingerState = new LingerOption(true, 0);
                    client.Close();
                }
                catch (Exception)
                {
                    // Already gone, which is what was asked for.
                }
            }
        }

        public void Dispose()
        {
            _lifetime.Cancel();
            _listener.Stop();
            ResetConnections();
            _lifetime.Dispose();
        }


        /*
         *  Sessions
         */

        private async Task AcceptLoop()
        {
            while (!_lifetime.IsCancellationRequested)
            {
                TcpClient client;
                try
                {
                    client = await _listener.AcceptTcpClientAsync().ConfigureAwait(false);
                }
                catch (Exception)
                {
                    return; // listener stopped
                }

                int session;
                lock (_acceptTimes)
                {
                    _acceptTimes.Add(_clock.Elapsed.TotalMilliseconds);
                    session = _acceptTimes.Count;
                }

                lock (_open)
                    _open.Add(client);

                Interlocked.Increment(ref _accepted);
                _ = Serve(client, session, _mode);
            }
        }

        private async Task Serve(TcpClient client, int session, Behaviour mode)
        {
            var token = _lifetime.Token;
            Stream stream = null;
            try
            {
                client.NoDelay = true;
                stream = client.GetStream();
                if (_useTls)
                    stream = await TestTls.AcceptAsync(stream).ConfigureAwait(false);

                switch (mode)
                {
                    case Behaviour.HangUpAfterHandshake:
                        await ReadHandshake(stream, token).ConfigureAwait(false);
                        await HangUp(client, stream, token).ConfigureAwait(false);
                        break;

                    case Behaviour.Silent:
                        await Drain(stream, token).ConfigureAwait(false);
                        break;

                    case Behaviour.Heartbeat:
                        var handshakeRead = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
                        var reading = Record(stream, session, handshakeRead, token);

                        // Not a word until the handshake is in. A client that hangs up before
                        // sending one is never sent anything.
                        if (await Task.WhenAny(handshakeRead.Task, reading).ConfigureAwait(false) == handshakeRead.Task)
                            await Heartbeat(stream, token).ConfigureAwait(false);

                        await reading.ConfigureAwait(false);
                        break;

                    case Behaviour.Refuse:
                        await Refuse(client, stream, await ReadHandshake(stream, token).ConfigureAwait(false), token)
                            .ConfigureAwait(false);
                        break;

                    case Behaviour.SpeakV1:
                        // Until a write fails: the client hangs up on the first beat it reads.
                        while (true)
                        {
                            await stream.WriteAsync(V1Heartbeat, 0, V1Heartbeat.Length, token).ConfigureAwait(false);
                            await Task.Delay(100, token).ConfigureAwait(false);
                        }

                    case Behaviour.HeartbeatThenRefuse:
                        // A beat before the handshake has even been read. The client reads it before
                        // the refusal behind it, so it is connected by the time it is refused.
                        var beat = FrameCodec.EncodeHeartbeat(1);
                        await stream.WriteAsync(beat, 0, beat.Length, token).ConfigureAwait(false);

                        await Refuse(client, stream, await ReadHandshake(stream, token).ConfigureAwait(false), token)
                            .ConfigureAwait(false);
                        break;
                }
            }
            catch (Exception)
            {
                // The client went away, or the test is over; either way this session is done.
            }
            finally
            {
                lock (_open)
                    _open.Remove(client);
                client.Close();
                CloseQuietly(stream);
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

        private static async Task<DecodedFrame?> ReadHandshake(Stream stream, CancellationToken token)
        {
            var reader = new FrameReader();
            var buffer = new byte[4096];
            while (true)
            {
                var read = await stream.ReadAsync(buffer, 0, buffer.Length, token).ConfigureAwait(false);
                if (read <= 0)
                    return null;

                foreach (var frame in Decode(reader, buffer, read))
                {
                    if (frame.Type == FrameType.Handshake)
                        return frame;
                }
            }
        }

        private async Task Refuse(TcpClient client, Stream stream, DecodedFrame? handshake, CancellationToken token)
        {
            var refusal = FrameCodec.EncodeMessage("colibri", "protocol::rejected", Encoding.UTF8.GetBytes(
                $"{{\"serverVersion\":\"{RefusingServerVersion}\",\"clientVersion\":\"{handshake?.Version}\","
                + $"\"reason\":\"Unsupported protocol version {handshake?.Version}; this server speaks {RefusingServerVersion}\"}}"));
            await stream.WriteAsync(refusal, 0, refusal.Length, token).ConfigureAwait(false);
            await HangUp(client, stream, token).ConfigureAwait(false);
        }

        /// <summary>
        /// FIN first, then wait for the client to close its side. Closing outright with the client's
        /// bytes still unread would send an RST instead, and an RST can overtake data still in flight.
        /// </summary>
        private static async Task HangUp(TcpClient client, Stream stream, CancellationToken token)
        {
            client.Client.Shutdown(SocketShutdown.Send);
            using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(token))
            {
                timeout.CancelAfter(5000);
                await Drain(stream, timeout.Token).ConfigureAwait(false);
            }
        }

        private static async Task Drain(Stream stream, CancellationToken token)
        {
            var buffer = new byte[4096];
            while (await stream.ReadAsync(buffer, 0, buffer.Length, token).ConfigureAwait(false) > 0)
            {
            }
        }

        private async Task Heartbeat(Stream stream, CancellationToken token)
        {
            for (ulong beat = 1; !token.IsCancellationRequested; beat++)
            {
                var frame = FrameCodec.EncodeHeartbeat(beat);
                await stream.WriteAsync(frame, 0, frame.Length, token).ConfigureAwait(false);
                await Task.Delay(100, token).ConfigureAwait(false);
            }
        }

        private async Task Record(Stream stream, int session, TaskCompletionSource<bool> handshakeRead, CancellationToken token)
        {
            var reader = new FrameReader();
            var buffer = new byte[16 * 1024];
            var clock = Stopwatch.StartNew();
            long total = 0;
            while (true)
            {
                var read = await stream.ReadAsync(buffer, 0, buffer.Length, token).ConfigureAwait(false);
                if (read <= 0)
                    return;

                // A slow link: no further read until this many bytes would have taken that long.
                total += read;
                if (_readBytesPerSecond > 0)
                {
                    var ahead = total * 1000.0 / _readBytesPerSecond - clock.Elapsed.TotalMilliseconds;
                    if (ahead >= 1)
                        await Task.Delay((int)ahead, token).ConfigureAwait(false);
                }

                foreach (var frame in Decode(reader, buffer, read))
                {
                    if (frame.Type == FrameType.Handshake)
                        handshakeRead.TrySetResult(true);

                    if (frame.Type == FrameType.Heartbeat)
                        Interlocked.Increment(ref _echoes);

                    if (frame.Type != FrameType.Message)
                        continue;

                    lock (_received)
                        _received.Add((session, frame));
                }
            }
        }

        /// <summary>Out of the async methods because a ReadOnlySpan cannot live in one.</summary>
        private static List<DecodedFrame> Decode(FrameReader reader, byte[] buffer, int count)
            => new List<DecodedFrame>(reader.Append(new ReadOnlySpan<byte>(buffer, 0, count)));
    }
}
