namespace HCIKonstanz.Colibri.Networking
{
    /// <summary>
    /// <see cref="ConnectionStatus.ProtocolMismatch"/> is terminal: unlike
    /// <see cref="ConnectionStatus.Disconnected"/> it is not followed by another attempt, since retrying
    /// cannot fix a version mismatch.
    /// </summary>
    public enum ConnectionStatus { Connected, Disconnected, Connecting, Reconnecting, ProtocolMismatch };
}
