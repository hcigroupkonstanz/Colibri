namespace HCIKonstanz.Colibri.Networking.Protocol
{
    /// <summary>
    /// Frame type byte of the v3 TCP wire protocol. The values must match
    /// <c>colibri-server/src/server/modules/networking/protocol.ts</c>.
    /// </summary>
    public enum FrameType : byte
    {
        Heartbeat = 0x00,
        Handshake = 0x01,
        Message = 0x02,
    }
}
