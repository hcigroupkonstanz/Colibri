using System;

namespace HCIKonstanz.Colibri.Networking
{
    /// <summary>
    /// Thrown when the server refuses this client because the two sides speak different wire
    /// protocol versions, and the connection loop then stops instead of reconnecting.
    /// </summary>
    public class ProtocolMismatchException : Exception
    {
        /// <summary>
        /// Wire protocol version the server reported (not a release version), comparable with
        /// <see cref="ClientVersion"/>; "unknown" if the server refused without saying what it speaks.
        /// </summary>
        public string ServerVersion { get; }

        /// <summary>Protocol version this client announced in its handshake.</summary>
        public string ClientVersion { get; }

        public ProtocolMismatchException(string message, string serverVersion, string clientVersion)
            : base(message)
        {
            ServerVersion = serverVersion;
            ClientVersion = clientVersion;
        }
    }
}
