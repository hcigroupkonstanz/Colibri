using System;
using System.Globalization;
using UnityEngine;

namespace HCIKonstanz.Colibri.Synchronization
{
    internal sealed class ServerAbsence
    {
        // Since when this client has had no server, on SyncTicker's clock: from taking up the connection or
        // noticing it gone. Positive infinity while connected; NaN from the session start until a connection is taken
        // up or StopsWaitingForServer is first asked.
        private double _withoutServerSince = double.NaN;

        private bool _hasWarnedAboutNoServer;

        internal void Begin(double now) => _withoutServerSince = now;

        internal void End() => _withoutServerSince = double.PositiveInfinity;

        internal void Reset()
        {
            _withoutServerSince = double.NaN;
            _hasWarnedAboutNoServer = false;
        }

        internal bool StopsWaitingForServer(double now, double timeout, Func<bool> isConnectedOrConnecting)
        {
            if (double.IsNaN(_withoutServerSince))
                _withoutServerSince = now;

            if (now - _withoutServerSince < timeout)
                return false;

            // Not while connected or connecting. The connection comes up on a worker thread but OnConnected only
            // follows in the next Update, and an attempt can start later than _withoutServerSince (seconds later in a
            // frame that loads a scene) and gives up after the connect timeout itself.
            if (isConnectedOrConnecting())
                return false;

            if (!_hasWarnedAboutNoServer)
            {
                _hasWarnedAboutNoServer = true;
                Debug.LogWarning($"Colibri: no connection to a server for {timeout.ToString("0.#", CultureInfo.InvariantCulture)} s, "
                    + "so placed SyncTransforms with a Rigidbody and PhysicsAuthority ticked are simulated without the server's state; "
                    + "once a server answers, the positions they reached replace the shared ones. Start colibri-server, or check the "
                    + "server address in the Colibri configuration. Said once per session.");
            }
            return true;
        }
    }
}
