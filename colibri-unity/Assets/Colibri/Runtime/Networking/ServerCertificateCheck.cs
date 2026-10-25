using System;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;

namespace HCIKonstanz.Colibri.Networking
{
    /// <summary>The certificate check of one TLS handshake. Keeps the outcome for the log.</summary>
    internal sealed class ServerCertificateCheck
    {
        private readonly string _host;
        private readonly bool _allowSelfSigned;
        private readonly string _pin;

        internal ServerCertificateCheck(string host, bool allowSelfSigned, string pin)
        {
            _host = host;
            _allowSelfSigned = allowSelfSigned;
            _pin = pin;
        }

        /// <summary><see cref="ServerCertificatePolicy.Verdict.Rejected"/> until the server's certificate was seen.</summary>
        internal ServerCertificatePolicy.Verdict Verdict { get; private set; } = ServerCertificatePolicy.Verdict.Rejected;

        /// <summary>Fingerprint of the certificate the server presented, or null.</summary>
        internal string Fingerprint { get; private set; }

        /// <summary>For <see cref="ServerCertificatePolicy.Verdict.AcceptedUntrusted"/>: what the system found wrong.</summary>
        internal string Problems { get; private set; }

        /// <summary>Why the certificate was rejected, or null if it was not (or not seen at all).</summary>
        internal string Rejection { get; private set; }

        /// <summary>The <see cref="RemoteCertificateValidationCallback"/> of the handshake.</summary>
        internal bool Validate(object sender, X509Certificate certificate, X509Chain chain, SslPolicyErrors errors)
        {
            // An exception escaping here would fail the handshake with an error that does not mention the certificate.
            try
            {
                var seen = ServerCertificate.From(certificate);
                var now = DateTime.UtcNow;

                Fingerprint = seen.Fingerprint;
                Verdict = ServerCertificatePolicy.Decide(errors, seen.Fingerprint, _allowSelfSigned, _pin);

                if (Verdict == ServerCertificatePolicy.Verdict.Rejected)
                    Rejection = ServerCertificatePolicy.ExplainRejection(errors, seen, _host, _allowSelfSigned, _pin, now);
                else if (Verdict == ServerCertificatePolicy.Verdict.AcceptedUntrusted)
                    Problems = ServerCertificatePolicy.DescribeProblems(errors, seen, _host, now);

                return Verdict != ServerCertificatePolicy.Verdict.Rejected;
            }
            catch (Exception e)
            {
                Verdict = ServerCertificatePolicy.Verdict.Rejected;
                Rejection = $"it could not be checked ({e.GetType().Name}: {e.Message})";
                return false;
            }
        }
    }
}
