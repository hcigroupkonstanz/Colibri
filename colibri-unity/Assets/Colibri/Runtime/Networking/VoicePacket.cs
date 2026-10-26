using HCIKonstanz.Colibri.Communication.Codecs;

namespace HCIKonstanz.Colibri.Networking
{
    public struct VoicePacket
    {
        public short Id;
        public short Sequence;
        public short FrameSize;
        public Codec Codec;
        public byte[] Data;
    }
}
