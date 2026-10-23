using System;

namespace HCIKonstanz.Colibri.Synchronization
{
    internal sealed class ServerHeardClock
    {
        // When the server was last heard from (SyncTicker's clock), the connection's liveness stamp count then,
        // and when LastHeardAt was last asked.
        private double _heardAt = double.NegativeInfinity;
        private long _heardStamps;
        private double _heardAskedAt = double.NegativeInfinity;

        // Freezes LastHeardAt from an outage until the requests go out again. The next connection hears from the
        // server a frame before those requests, and a value sent in that frame would count as sent after the server
        // was last heard from, pushing out the values SentValues keeps for the answers.
        private bool _heardAtHeld;

        internal void Hold() => _heardAtHeld = true;

        internal void Release() => _heardAtHeld = false;

        internal bool TakesStamps(long stamps) => stamps != _heardStamps && !_heardAtHeld;

        internal void Hear(double now, long stamps, long millisSinceLastHeartbeat)
        {
            // Asked once a frame (SyncTicker). The age of the last heartbeat is taken off now, but not past the previous
            // ask: the connection times heartbeats on the system clock, which is set now and then and runs on while a
            // headset sleeps, so it need not follow Unity's clock. now alone is too late after a long frame, such as a
            // synchronous scene load.
            _heardStamps = stamps;
            var heardAt = now - millisSinceLastHeartbeat / 1000.0;
            _heardAt = Math.Min(now, Math.Max(_heardAskedAt, heardAt));
        }

        internal double LastHeardAt(double now)
        {
            _heardAskedAt = now;
            return _heardAt;
        }

        internal void ForgetConnection()
        {
            _heardStamps = 0;
            _heardAt = double.NegativeInfinity;
            _heardAtHeld = false;
        }

        internal void Reset()
        {
            _heardStamps = 0;
            _heardAt = double.NegativeInfinity;
            _heardAskedAt = double.NegativeInfinity;
            _heardAtHeld = false;
        }
    }
}
