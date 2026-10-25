namespace HCIKonstanz.Colibri.Networking
{
    /// <summary>Where the connection to colibri-server stands, as <see cref="WebServerConnection.Status"/> reports it.</summary>
    public enum ConnectionStatus
    {
        Connected,
        Disconnected,
        Connecting,
        Reconnecting,

        /// <summary>
        /// The server refused this client's protocol version. Terminal: unlike <see cref="Disconnected"/> it is not
        /// followed by another attempt, since retrying cannot fix a version mismatch.
        /// </summary>
        ProtocolMismatch
    };
}
