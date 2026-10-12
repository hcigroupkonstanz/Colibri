namespace HCIKonstanz.Colibri.Networking.Protocol
{
    /// <summary>
    /// Frame discriminator of the v3 TCP wire protocol.
    /// Mirrors <c>colibri-server/src/server/modules/networking/protocol.ts</c>.
    /// </summary>
    public enum FrameType : byte
    {
        Heartbeat = 0x00,
        Handshake = 0x01,
        Message = 0x02,
    }
}
