using Newtonsoft.Json.Linq;

namespace HCIKonstanz.Colibri.Networking
{
    internal struct InPacket
    {
        public string Channel;
        public string Command;
        public JToken Payload;

        // Dropped before any model message when the queue is over its bound; false for model commands, as in the outbox.
        public bool CanDrop;
    }
}
