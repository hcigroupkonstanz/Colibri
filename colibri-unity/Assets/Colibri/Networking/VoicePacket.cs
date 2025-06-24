public struct VoicePacket
{
    public short Id;
    public short Sequence;
    public short FrameSize;
    public Codec Codec;
    public byte[] Data;
}