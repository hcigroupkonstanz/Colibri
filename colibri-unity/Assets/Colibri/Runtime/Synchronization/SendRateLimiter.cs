using System;

namespace HCIKonstanz.Colibri.Synchronization
{
    /// <summary>Decides whether a SyncBehaviour may send now under its rate limit, keeping the interval steady across frames.</summary>
    internal sealed class SendRateLimiter
    {
        private double _nextSendTime = double.NegativeInfinity;
        private double _lastSendTime = double.NegativeInfinity;

        internal bool TryTake(double now, double interval, bool sendAtOnce)
        {
            // _nextSendTime was set with the previous interval. A raised MaxSendRate (set from code) shortens
            // the wait for what is held now; a lowered one applies from the next slot.
            var due = Math.Min(_nextSendTime, _lastSendTime + interval);

            if (interval > 0 && now < due && !sendAtOnce)
                return false;

            // The next slot is one interval after the previous slot, not after now: counting from now rounds every
            // interval up to whole frames (30 Hz at 72 fps becomes 24 Hz). The lateness is carried over only while
            // the object keeps sending; after a pause or an early send it starts afresh, so no backlog builds up.
            var late = now - due;
            _nextSendTime = late >= 0 && late < interval ? due + interval : now + interval;
            _lastSendTime = now;
            return true;
        }
    }
}
