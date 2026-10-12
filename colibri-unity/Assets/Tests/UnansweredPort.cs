using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;

namespace HCIKonstanz.Colibri.E2E
{
    /// <summary>
    /// A loopback port that never answers a connection attempt, for what an unreachable server
    /// looks like from the client: no refusal, no reply, just nothing. Made without root or a
    /// firewall rule out of a listener that never accepts, with its backlog already full. Linux -
    /// and so Android - and macOS then drop further SYNs rather than refuse them, and a connect
    /// to the port hangs until it is given up.
    ///
    /// Windows refuses a connection to a full backlog instead, and only after retrying the SYN for
    /// a second or so - long enough to look like no answer to a short probe - so it is not even
    /// tried there. <see cref="Hangs"/> says whether this machine produced a port that really
    /// never answers; a test should be skipped when not.
    /// </summary>
    public sealed class UnansweredPort : IDisposable
    {
        private readonly Socket _listener;
        private readonly List<Socket> _queued = new List<Socket>();

        public int Port { get; }

        /// <summary>Whether a connection attempt to <see cref="Port"/> really goes unanswered here.</summary>
        public bool Hangs { get; }

        /// <summary>
        /// How long a probe may go unanswered before the port counts as never answering. A loopback
        /// connection that is answered at all is answered within a millisecond; this leaves room
        /// for a busy machine and for a refusal that comes late.
        /// </summary>
        private const int ProbeMs = 1000;

        public UnansweredPort()
        {
            _listener = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
            _listener.Bind(new IPEndPoint(IPAddress.Loopback, 0));
            _listener.Listen(0);
            Port = ((IPEndPoint)_listener.LocalEndPoint).Port;

            if (Environment.OSVersion.Platform == PlatformID.Win32NT)
                return;

            // Queue connections nobody accepts until one is no longer answered. A backlog of 0 is
            // one connection on Linux; the bound is for systems that round it up.
            for (var i = 0; i < 16; i++)
            {
                var probe = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
                var connecting = probe.ConnectAsync(IPAddress.Loopback, Port);

                bool answered;
                try
                {
                    answered = connecting.Wait(ProbeMs);
                }
                catch (AggregateException)
                {
                    // Refused: this system answers a full backlog after all.
                    probe.Close();
                    return;
                }

                if (answered)
                {
                    _queued.Add(probe);
                    continue;
                }

                probe.Close();
                _ = connecting.ContinueWith(attempt => { _ = attempt.Exception; }, CancellationToken.None,
                    TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
                Hangs = true;
                return;
            }
        }

        public void Dispose()
        {
            foreach (var socket in _queued)
                socket.Close();
            _queued.Clear();

            _listener.Close();
        }
    }
}
