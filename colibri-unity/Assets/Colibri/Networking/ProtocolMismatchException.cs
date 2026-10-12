using System;

namespace HCIKonstanz.Colibri.Networking
{
    /// <summary>
    /// Thrown when the server refuses this client because the two speak different wire
    /// protocol versions. Unlike a dropped socket this is terminal: there is no negotiation
    /// and no subset both sides can speak, so the connection loop stops rather than
    /// reconnecting. The fix is always to align the colibri-unity and colibri-server versions.
    /// </summary>
    public class ProtocolMismatchException : Exception
    {
        /// <summary>
        /// Protocol version the server reported - a wire version like "1" or "2", never a release
        /// version, so it is comparable with <see cref="ClientVersion"/>. "unknown" if the server
        /// refused this client without saying what it speaks.
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
