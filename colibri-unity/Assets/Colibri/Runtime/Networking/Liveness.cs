using System;
using System.Threading;

namespace HCIKonstanz.Colibri.Networking
{
    internal sealed class Liveness
    {
        private long _lastHeartbeatTime;
        private long _stamps;

        internal long Stamps => Interlocked.Read(ref _stamps);

        internal void Stamp(long millisAgo = 0)
        {
            Interlocked.Exchange(ref _lastHeartbeatTime, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - millisAgo);
            Interlocked.Increment(ref _stamps);
        }

        internal long MillisSinceLastHeartbeat() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - Interlocked.Read(ref _lastHeartbeatTime);
    }
}
