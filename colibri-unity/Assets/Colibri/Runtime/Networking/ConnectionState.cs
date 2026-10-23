using System;
using System.Collections.Concurrent;
using System.Threading;
using System.Threading.Tasks;

namespace HCIKonstanz.Colibri.Networking
{
    /// <summary>
    /// The connection status with the <c>await Connected</c> gate and the connect and disconnect events that follow
    /// it. The connection loop and the watchdog in Update both change it, so transitions run under <c>_statusLock</c>.
    /// </summary>
    internal sealed class ConnectionState
    {
        internal const int RECONNECT_DELAY_MIN_MS = 500;
        private const int RECONNECT_DELAY_MAX_MS = 10 * 1000;

        // Both touched by the connection loop and, via Set, by Update: every access is under
        // _statusLock.
        private int _connectAttempts;
        private int _connectedSessions;

        // Gate behind `await Connected`, awaited by user code only (sends queue in the outbox instead).
        // A TaskCompletionSource because several callers may await it at once, which UniTaskCompletionSource
        // rejects. volatile: re-armed on the connection loop's thread, read on any.
        private volatile TaskCompletionSource<bool> _connectedGate = NewGate();
        private volatile bool _isGateOpen;

        // OnConnected (true) and OnDisconnected (false) still to be raised on the main thread, in the order
        // the transitions happened. Queued by Set under _statusLock.
        private readonly ConcurrentQueue<bool> _connectionEvents = new ConcurrentQueue<bool>();

        private volatile ConnectionStatus _status = ConnectionStatus.Disconnected;

        // Whether the current session uses TLS, read from the configuration when it started. Written by the
        // connection loop under _statusLock, read by UsesTls on any thread.
        private volatile bool _sessionUsesTls;

        // Set is a read-modify-write over several fields, and both the connection loop and the
        // watchdog in Update reach it. Unguarded, a transition can be lost: a watchdog Disconnected landing
        // between the loop's compare and assignment leaves the gate open on a closed socket. A loop sets it
        // through TrySetStatus, which also checks under this lock that the loop has not been ended.
        private readonly object _statusLock = new object();

        internal ConnectionStatus Status => _status;

        internal Task Connected => _connectedGate.Task;

        internal bool UsesTls => _sessionUsesTls;

        internal int ConnectedSessions
        {
            get
            {
                lock (_statusLock)
                    return _connectedSessions;
            }
        }

        private static TaskCompletionSource<bool> NewGate()
            => new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

        internal void ResetGate()
        {
            _connectedGate = NewGate();
            _isGateOpen = false;
        }

        internal void CancelGate() => _connectedGate.TrySetCanceled();

        internal bool TryDequeueConnectionEvent(out bool connected) => _connectionEvents.TryDequeue(out connected);

        internal void Set(ConnectionStatus value)
        {
            lock (_statusLock)
            {
                if (_status == value)
                    return;

                var wasConnected = _status == ConnectionStatus.Connected;
                _status = value;

                if (_status == ConnectionStatus.Connected)
                {
                    _connectAttempts = 0;
                    _connectedSessions++;
                    _connectionEvents.Enqueue(true);
                    _isGateOpen = true;

                    // Continuations run asynchronously (see NewGate), so no awaiter resumes inline under the lock.
                    _connectedGate.TrySetResult(true);
                }
                else if (_isGateOpen)
                {
                    // Re-arm, so `await Connected` while disconnected waits for the next connection.
                    _isGateOpen = false;
                    _connectedGate = NewGate();
                }

                // Final: there is no next connection to wait for.
                if (_status == ConnectionStatus.ProtocolMismatch)
                    _connectedGate.TrySetCanceled();

                // One OnDisconnected per OnConnected, whatever ended the connection, a refusal included.
                if (wasConnected)
                    _connectionEvents.Enqueue(false);
            }
        }

        /// <summary>
        /// Sets <see cref="Status"/> for the connection loop that <paramref name="token"/> belongs to, unless
        /// OnDisable has ended that loop: the status is then OnDisable's and the next loop's. Checked under the
        /// lock Set takes, so OnDisable, which cancels the token before it sets Disconnected, has the
        /// last word.
        /// </summary>
        /// <returns>False if the loop has been ended.</returns>
        internal bool TrySetStatus(ConnectionStatus value, CancellationToken token)
        {
            lock (_statusLock)
            {
                if (token.IsCancellationRequested)
                    return false;

                Set(value);
                return true;
            }
        }

        internal void BeginAttempt(bool useTls, CancellationToken token)
        {
            lock (_statusLock)
            {
                // A loop that OnDisable has ended starts nothing: the status, and the connection
                // UsesTls describes, may already be the next loop's.
                token.ThrowIfCancellationRequested();

                _sessionUsesTls = useTls;
                Set(_connectAttempts == 0 ? ConnectionStatus.Connecting : ConnectionStatus.Reconnecting);
            }
        }

        internal int NextBackoffDelay()
        {
            // Same lock as Set, which resets the counter on a successful connect.
            lock (_statusLock)
            {
                var shift = Math.Min(_connectAttempts, 5);
                _connectAttempts++;
                return Math.Min(RECONNECT_DELAY_MAX_MS, RECONNECT_DELAY_MIN_MS << shift);
            }
        }
    }
}
