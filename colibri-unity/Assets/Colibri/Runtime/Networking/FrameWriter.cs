using System;
using System.IO;
using System.Net.Security;
using System.Threading;
using System.Threading.Tasks;
using HCIKonstanz.Colibri.Networking.Protocol;

namespace HCIKonstanz.Colibri.Networking
{
    /// <summary>
    /// Writes frames to a session's socket one at a time under <c>_sendLock</c>: the handshake and the outbox
    /// drainer's messages, and the receive loop's heartbeat echoes, which never wait for the lock.
    /// </summary>
    internal sealed class FrameWriter
    {
        // Serializes every socket write, outbox messages and heartbeat echoes alike: concurrent writes would
        // interleave bytes and corrupt the framing, and an SslStream takes one write at a time. The receive
        // loop never waits for it (see EchoHeartbeat).
        private readonly SemaphoreSlim _sendLock = new SemaphoreSlim(1, 1);

        // The newest heartbeat echo not written yet, with the session it answers, or null. Set by the receive
        // loop, taken by whoever holds _sendLock (see EchoHeartbeat).
        private PendingEcho _pendingEcho;

        internal SemaphoreSlim SendLock => _sendLock;

        private sealed class PendingEcho
        {
            public ServerSession Session;
            public byte[] Frame;
        }

        // All writes hold _sendLock, so a frame is never interleaved with another frame's bytes. Heartbeat
        // echoes come through EchoHeartbeat, which never waits for the lock, and are written between two frames.
        internal async Task SendFrame(ServerSession session, byte[] frame, CancellationToken token)
        {
            await _sendLock.WaitAsync(token).ConfigureAwait(false);
            try
            {
                // An echo that came in while someone else had the socket goes first; one that came in while this
                // frame was being written (seconds, for a large frame on a slow link) goes straight after it.
                await WritePendingEcho(session).ConfigureAwait(false);
                await WriteAll(session, frame).ConfigureAwait(false);
                await WritePendingEcho(session).ConfigureAwait(false);
            }
            finally
            {
                ReleaseSendLock();
            }
        }

        // Under _sendLock. A stream write completes only once the whole frame has been handed to
        // the socket (encrypted first, with TLS), so a frame is never cut short.
        private static Task WriteAll(ServerSession session, byte[] frame)
            => session.Stream.WriteAsync(frame, 0, frame.Length);

        /// <summary>
        /// Answers a server heartbeat without waiting for the socket. The receive loop calls this and must
        /// never wait for a write: a large message on a slow link holds the socket, and a receive loop stuck
        /// behind it stops reading the server's heartbeats, so the watchdog in <see cref="WebServerConnection.Update"/> would
        /// drop a healthy connection after 2 s.
        /// </summary>
        /// <remarks>
        /// The echo is left in a slot and written by whoever has the socket: at once if nobody does, otherwise
        /// by the write in progress as soon as its frame is complete, so a frame is never split by another
        /// frame's bytes. Only the newest echo is kept. While a long write holds the socket the server is
        /// still receiving its bytes, which is what its idle timeout looks at; a skipped echo only costs it one
        /// latency sample.
        /// </remarks>
        internal void EchoHeartbeat(ServerSession session, ulong pingTimestamp)
        {
            Volatile.Write(ref _pendingEcho, new PendingEcho { Session = session, Frame = FrameCodec.EncodeHeartbeat(pingTimestamp) });

            if (_sendLock.Wait(0))
                _ = WritePendingEchoAndRelease();
        }

        // Called holding _sendLock, which it releases.
        private async Task WritePendingEchoAndRelease()
        {
            try
            {
                await WritePendingEcho(null).ConfigureAwait(false);
            }
            finally
            {
                ReleaseSendLock();
            }
        }

        /// <summary>
        /// Under _sendLock: writes the pending echo, if there is one. With <paramref name="session"/>, only an
        /// echo that belongs to that session; one left over from an earlier session answers nothing any more,
        /// and is dropped.
        /// </summary>
        /// <remarks>Never throws: a write that fails closes the socket, which ends the session.</remarks>
        private async Task WritePendingEcho(ServerSession session)
        {
            var echo = Interlocked.Exchange(ref _pendingEcho, null);
            if (echo == null || (session != null && !ReferenceEquals(echo.Session, session)))
                return;

            try
            {
                await WriteAll(echo.Session, echo.Frame).ConfigureAwait(false);
            }
            catch (Exception)
            {
                // The connection is gone. Closing the socket makes the receive loop notice now,
                // and a message written next fails and stays queued for the next session.
                echo.Session.Close();
            }
        }

        /// <summary>
        /// Lets go of the socket. An echo that arrived after the holder last looked would otherwise
        /// wait for the next write or the next heartbeat, so it is written now, unless another
        /// write has taken the socket in the meantime, which then writes it.
        /// </summary>
        private void ReleaseSendLock()
        {
            _sendLock.Release();

            if (Volatile.Read(ref _pendingEcho) != null && _sendLock.Wait(0))
                _ = WritePendingEchoAndRelease();
        }

        /// <summary>
        /// Disposes a session's stream once it has ended: an SslStream holds TLS state that closing the socket
        /// does not free. Waits for the send lock first, since a write of this session may still be on its way
        /// out of the outbox or the heartbeat echo. Not awaited, so the end of a session never waits for a write.
        /// </summary>
        internal void ReleaseStream(Stream stream)
        {
            if (!(stream is SslStream))
                return;

            _ = Task.Run(async () =>
            {
                await _sendLock.WaitAsync().ConfigureAwait(false);
                try
                {
                    stream.Dispose();
                }
                catch (Exception)
                {
                    // The socket under it is closed already; there is nothing left to tidy.
                }
                finally
                {
                    ReleaseSendLock();
                }
            });
        }
    }
}
