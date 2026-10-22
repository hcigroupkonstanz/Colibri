using System;
using System.Security.Cryptography.X509Certificates;

namespace HCIKonstanz.Colibri.Networking
{
    /// <summary>What <see cref="ServerCertificatePolicy"/> needs to know about a certificate, read once.</summary>
    internal readonly struct ServerCertificate
    {
        /// <summary>As <see cref="ServerCertificatePolicy.Fingerprint"/> writes it; null for no certificate.</summary>
        public readonly string Fingerprint;

        /// <summary>Whether the dates and <see cref="IsSelfIssued"/> could be read.</summary>
        public readonly bool IsKnown;

        public readonly DateTime NotBeforeUtc;
        public readonly DateTime NotAfterUtc;

        /// <summary>Subject equals issuer.</summary>
        public readonly bool IsSelfIssued;

        public ServerCertificate(string fingerprint, DateTime notBeforeUtc, DateTime notAfterUtc, bool isSelfIssued)
        {
            Fingerprint = fingerprint;
            IsKnown = true;
            NotBeforeUtc = notBeforeUtc;
            NotAfterUtc = notAfterUtc;
            IsSelfIssued = isSelfIssued;
        }

        private ServerCertificate(string fingerprint)
        {
            Fingerprint = fingerprint;
            IsKnown = false;
            NotBeforeUtc = default;
            NotAfterUtc = default;
            IsSelfIssued = false;
        }

        /// <summary>
        /// Reads a certificate as the TLS stack hands it over. If its dates or names cannot be read,
        /// only the fingerprint is set.
        /// </summary>
        public static ServerCertificate From(X509Certificate certificate)
        {
            if (certificate == null)
                return new ServerCertificate(null);

            var fingerprint = ServerCertificatePolicy.Fingerprint(certificate.GetRawCertData());
            try
            {
                var full = certificate as X509Certificate2 ?? new X509Certificate2(certificate);
                return new ServerCertificate(fingerprint, full.NotBefore.ToUniversalTime(), full.NotAfter.ToUniversalTime(),
                    full.Subject == full.Issuer);
            }
            catch (Exception)
            {
                return new ServerCertificate(fingerprint);
            }
        }
    }
}
