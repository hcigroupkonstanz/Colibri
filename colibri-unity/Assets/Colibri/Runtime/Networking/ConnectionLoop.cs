using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;

namespace HCIKonstanz.Colibri.Networking
{
    /// <summary>
    /// State of one run of the connection loop: its lifetime token, socket and session flags, set on the loop's
    /// thread and read by the watchdog in Update and by OnDisable.
    /// </summary>
    // One run of the connection loop, from the OnEnable that starts it to the OnDisable that ends it.
    // A disable and enable in one frame start the next run while the last still unwinds on a worker
    // thread, so a run keeps its own socket and watchdog here. The state the component shares (Status,
    // the outbox, what is reported about the connection) a run changes only while its token is not
    // cancelled, checked under the lock that guards it; OnDisable cancels the token before it sets all
    // of that itself.
    internal sealed class ConnectionLoop
    {
        public readonly CancellationTokenSource Lifetime = new CancellationTokenSource();

        // Taken once: Lifetime.Token throws after OnDisable has disposed the source, and the run may still unwind.
        public readonly CancellationToken Token;

        // Socket of the attempt or session in progress, null between two. Closing it ends a session, TLS or
        // not. Set and cleared by the run, read by the watchdog in Update and by OnDisable; the send path
        // uses _outboxSession.
        public volatile Socket Socket;

        // Set when the TCP connection is accepted, cleared when the session ends or the watchdog fires.
        // Covers the stretch before the first frame, so a server that accepts and then says nothing cannot
        // hold a session in Connecting.
        public volatile bool IsWatchdogArmed;

        // Session-scoped: the TCP connection is up and the handshake sent. Without it, a refused connection
        // (server not running) would count towards the framing hint.
        public volatile bool ReachedHandshake;

        // Session-scoped: the session has decoded a frame. Only sessions that end before this count towards
        // the framing hint.
        public volatile bool DecodedAnyFrame;

        // Session-scoped: the watchdog dropped the session before the server sent a frame. Counts towards the
        // unanswered-session hint, not the framing hint (see CountSessionWithoutAFrame).
        public volatile bool EndedSilent;

        // Session-scoped: the watchdog closed the socket, connected or not, and has said why, so the read or
        // write that fails on it is not logged as well.
        public volatile bool DroppedByWatchdog;

        // Session-scoped: ended on a frame that could not be decoded, as sessions with a 1.x server do. With
        // TLS, the only frameless session that counts towards the framing hint.
        public volatile bool EndedOnBadFrame;

        // Completes once the run has ended and cleaned up after its last session.
        public Task Run;

        public ConnectionLoop()
        {
            Token = Lifetime.Token;
        }
    }
}
