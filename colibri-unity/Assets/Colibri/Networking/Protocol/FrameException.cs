using System;

namespace HCIKonstanz.Colibri.Networking.Protocol
{
    /// <summary>
    /// Thrown for a frame that cannot be represented on the wire (encoding) or that is
    /// malformed / oversized (decoding). The counterpart of the server's <c>FrameError</c>.
    /// A decode-side <see cref="FrameException"/> is fatal for the connection: the stream is
    /// desynchronized and there is no delimiter to resynchronize on.
    /// </summary>
    public class FrameException : Exception
    {
        public FrameException(string message) : base(message) { }
    }
}
