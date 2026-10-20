using System;

namespace HCIKonstanz.Colibri.Networking.Protocol
{
    /// <summary>
    /// Thrown when a frame cannot be encoded, or when a received frame is malformed or oversized.
    /// </summary>
    // A malformed or oversized received frame is fatal for the connection: the stream is
    // desynchronized and there is no delimiter to resynchronize on.
    public class FrameException : Exception
    {
        public FrameException(string message) : base(message) { }
    }
}
