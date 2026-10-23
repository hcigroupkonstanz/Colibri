using Newtonsoft.Json.Linq;

namespace HCIKonstanz.Colibri.Networking
{
    /// <summary>A received message waiting in the <see cref="ReceiveQueue"/> for delivery on the main thread.</summary>
    internal struct InPacket
    {
        public string Channel;
        public string Command;
        public JToken Payload;

        // Dropped before any model message when the queue is over its bound; false for model commands, as in the outbox.
        public bool CanDrop;
    }
}
