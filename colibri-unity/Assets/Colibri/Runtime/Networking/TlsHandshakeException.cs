using System;

namespace HCIKonstanz.Colibri.Networking
{
    /// <summary>
    /// The TLS handshake on the TCP connection failed. Not terminal: the connection retries with the
    /// usual backoff, so a server switched to TLS or given a new certificate is picked up without a restart.
    /// </summary>
    internal sealed class TlsHandshakeException : Exception
    {
        internal enum Failure
        {
            /// <summary>
            /// Hung up, sent something that is not TLS, or timed out. Almost always a server without TLS.
            /// </summary>
            NoTlsAnswer,
            CertificateRejected,
        }

        internal Failure Kind { get; }

        internal TlsHandshakeException(Failure kind, string message, Exception inner = null)
            : base(message, inner)
        {
            Kind = kind;
        }
    }
}
