using System;

namespace HCIKonstanz.Colibri.Networking
{
    /// <summary>
    /// The TLS handshake on the TCP connection failed. Not terminal: the server may be switched to
    /// TLS, or given another certificate, at any time, so the connection keeps being retried with
    /// the usual backoff.
    /// </summary>
    internal sealed class TlsHandshakeException : Exception
    {
        internal enum Failure
        {
            /// <summary>
            /// The server did not take part in the handshake: it hung up, answered with something
            /// that is not TLS, or said nothing in time. Almost always a server without TLS.
            /// </summary>
            NoTlsAnswer,

            /// <summary>The server's certificate was rejected; the message says why.</summary>
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
