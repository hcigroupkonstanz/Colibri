using System;
using System.Globalization;
using System.Net.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;

namespace HCIKonstanz.Colibri.Networking
{
    /// <summary>
    /// Which server certificates a TLS connection accepts. Two settings in
    /// <see cref="Setup.ColibriConfig"/> change the default, and nothing else does:
    /// <list type="bullet">
    /// <item>By default the system decides: a certificate from an authority this device trusts,
    /// issued for the configured server address. Let's Encrypt and institutional certificates work
    /// without any setting.</item>
    /// <item><see cref="Setup.ColibriConfig.AllowSelfSignedCertificate"/> also accepts a certificate
    /// the system does not trust, or one issued for another name. The connection is still
    /// encrypted; what is given up is the check that it goes to the right server.</item>
    /// <item><see cref="Setup.ColibriConfig.ServerCertificateSha256"/>, when set, accepts exactly one
    /// certificate, the one with that fingerprint, whether the system trusts it or not, and no
    /// other. The server logs its certificate's fingerprint when it starts.</item>
    /// </list>
    /// </summary>
    /// <remarks>
    /// Pure functions, so that every case can be tested without a TLS server; see
    /// <see cref="ServerCertificateCheck"/> for the part that sees a real certificate.
    /// </remarks>
    internal static class ServerCertificatePolicy
    {
        internal enum Verdict
        {
            /// <summary>The system trusts it, under the configured server address.</summary>
            Trusted,

            /// <summary>It is the certificate whose fingerprint is configured.</summary>
            Pinned,

            /// <summary>The system does not trust it; accepted because self-signed certificates are allowed.</summary>
            AcceptedUntrusted,

            Rejected,
        }

        private const int Sha256HexDigits = 64;

        /// <summary>
        /// Decides about one certificate.
        /// </summary>
        /// <param name="errors">What the system's own check found: <see cref="SslPolicyErrors.None"/> for a
        /// certificate it trusts under the configured name.</param>
        /// <param name="fingerprint">The certificate's SHA-256 fingerprint, in any form
        /// <see cref="TryNormalizeFingerprint"/> reads; null if the server sent no certificate.</param>
        /// <param name="allowSelfSigned"><see cref="Setup.ColibriConfig.AllowSelfSignedCertificate"/>.</param>
        /// <param name="pin"><see cref="Setup.ColibriConfig.ServerCertificateSha256"/>, as entered.</param>
        internal static Verdict Decide(SslPolicyErrors errors, string fingerprint, bool allowSelfSigned, string pin)
        {
            // A pin that cannot match anything rejects everything: quietly falling back to the
            // system's check, or to "allow self-signed", would accept certificates the person who
            // entered it meant to exclude.
            if (!TryNormalizeFingerprint(pin, out var pinned))
                return Verdict.Rejected;

            if (pinned.Length > 0)
            {
                return TryNormalizeFingerprint(fingerprint, out var presented) && presented == pinned
                    ? Verdict.Pinned
                    : Verdict.Rejected;
            }

            if (errors == SslPolicyErrors.None)
                return Verdict.Trusted;

            // Allowing self-signed certificates accepts what the system finds wrong with one, not
            // a server that sent none at all.
            if (allowSelfSigned && (errors & SslPolicyErrors.RemoteCertificateNotAvailable) == 0)
                return Verdict.AcceptedUntrusted;

            return Verdict.Rejected;
        }

        /// <summary>
        /// The decision for a request that cannot see the system's own verdict: a UnityWebRequest
        /// with a certificate handler gets the certificate and nothing else. Only ever asked when
        /// <see cref="HasOwnRules"/> is true; without either setting the system decides alone.
        /// </summary>
        internal static bool AcceptsWithoutSystemCheck(string fingerprint, bool allowSelfSigned, string pin)
            => Decide(SslPolicyErrors.RemoteCertificateChainErrors, fingerprint, allowSelfSigned, pin) != Verdict.Rejected;

        /// <summary>Whether either setting replaces the system's own check.</summary>
        internal static bool HasOwnRules(bool allowSelfSigned, string pin)
            => allowSelfSigned || !string.IsNullOrWhiteSpace(pin);

        /// <summary>
        /// Reads a SHA-256 fingerprint as people copy it: upper or lower case, with or without the
        /// colons between the bytes, with stray spaces. <paramref name="normalized"/> is the 64
        /// digits in upper case, or empty for an empty <paramref name="fingerprint"/>.
        /// </summary>
        /// <returns>False if it is not empty and not 64 hexadecimal digits.</returns>
        internal static bool TryNormalizeFingerprint(string fingerprint, out string normalized)
        {
            normalized = "";
            if (string.IsNullOrWhiteSpace(fingerprint))
                return true;

            var digits = new StringBuilder(Sha256HexDigits);
            foreach (var c in fingerprint)
            {
                if (c == ':' || char.IsWhiteSpace(c))
                    continue;

                if (!Uri.IsHexDigit(c))
                {
                    normalized = null;
                    return false;
                }

                digits.Append(char.ToUpperInvariant(c));
            }

            if (digits.Length != Sha256HexDigits)
            {
                normalized = null;
                return false;
            }

            normalized = digits.ToString();
            return true;
        }

        /// <summary>
        /// The SHA-256 fingerprint of a certificate, given its DER encoding, as colibri-server logs
        /// it and <c>openssl x509 -fingerprint -sha256</c> prints it: upper-case hex, colons between
        /// the bytes.
        /// </summary>
        internal static string Fingerprint(byte[] der)
        {
            // SHA256Managed rather than SHA256.Create(), which looks its implementation up by name
            // at runtime: a lookup that managed code stripping in an IL2CPP player cannot see.
            byte[] hash;
            using (var sha256 = new SHA256Managed())
                hash = sha256.ComputeHash(der);

            var text = new StringBuilder(hash.Length * 3);
            for (var i = 0; i < hash.Length; i++)
            {
                if (i > 0)
                    text.Append(':');
                text.Append(hash[i].ToString("X2", CultureInfo.InvariantCulture));
            }

            return text.ToString();
        }

        /// <summary>
        /// What the system found wrong with a certificate, in words: "it is self-signed", "it
        /// expired on 2026-01-31", "it is not issued for 'example.org'".
        /// </summary>
        internal static string DescribeProblems(SslPolicyErrors errors, ServerCertificate certificate, string host, DateTime utcNow)
        {
            if ((errors & SslPolicyErrors.RemoteCertificateNotAvailable) != 0)
                return "the server sent no certificate";

            var problems = new StringBuilder();
            void Add(string problem)
            {
                if (problems.Length > 0)
                    problems.Append(" and ");
                problems.Append(problem);
            }

            if ((errors & SslPolicyErrors.RemoteCertificateChainErrors) != 0)
            {
                // The dates are checked here rather than read off the chain: Unity's TLS backend
                // does not say which part of the chain failed.
                if (certificate.IsKnown && utcNow > certificate.NotAfterUtc)
                    Add($"it expired on {certificate.NotAfterUtc.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)}");
                else if (certificate.IsKnown && utcNow < certificate.NotBeforeUtc)
                    Add($"it is not valid until {certificate.NotBeforeUtc.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)}");

                if (certificate.IsSelfIssued)
                    Add("it is self-signed");
                else if (problems.Length == 0)
                    Add("it is not issued by a certificate authority this device trusts");
            }

            if ((errors & SslPolicyErrors.RemoteCertificateNameMismatch) != 0)
                Add($"it is not issued for '{host}'");

            return problems.Length > 0 ? problems.ToString() : $"the system did not accept it ({errors})";
        }

        /// <summary>
        /// Why a certificate <see cref="Decide"/> rejected was rejected, and what to change: the
        /// one line someone looking at the console has to go on.
        /// </summary>
        internal static string ExplainRejection(SslPolicyErrors errors, ServerCertificate certificate, string host, bool allowSelfSigned, string pin, DateTime utcNow)
        {
            if (!TryNormalizeFingerprint(pin, out var pinned))
            {
                return "the 'Server certificate SHA-256' in the Colibri configuration is not a SHA-256 fingerprint "
                    + "(64 hexadecimal digits, with or without colons), so no certificate can match it";
            }

            if (pinned.Length > 0)
            {
                if (certificate.Fingerprint == null)
                    return "the server sent no certificate";

                return $"its SHA-256 fingerprint is {certificate.Fingerprint}, not the one in 'Server certificate SHA-256' "
                    + "in the Colibri configuration. If the server's certificate was replaced or renewed, copy the new "
                    + "fingerprint from the server's log";
            }

            var problems = DescribeProblems(errors, certificate, host, utcNow);
            if (certificate.Fingerprint == null || allowSelfSigned)
                return problems;

            return $"{problems}. Use a certificate from a certificate authority this device trusts, or, for a self-signed "
                + "certificate, tick 'Allow self-signed certificate' or enter the certificate's fingerprint "
                + $"({certificate.Fingerprint}) as 'Server certificate SHA-256' in the Colibri configuration";
        }
    }

    /// <summary>
    /// What <see cref="ServerCertificatePolicy"/> needs to know about a certificate, read once.
    /// </summary>
    internal readonly struct ServerCertificate
    {
        /// <summary>SHA-256 fingerprint, as <see cref="ServerCertificatePolicy.Fingerprint"/> writes it; null for no certificate.</summary>
        public readonly string Fingerprint;

        /// <summary>Whether the dates below could be read.</summary>
        public readonly bool IsKnown;

        public readonly DateTime NotBeforeUtc;
        public readonly DateTime NotAfterUtc;

        /// <summary>Issued by itself, which is what a self-signed certificate is.</summary>
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
        /// Reads a certificate as the TLS stack hands it over. Never throws: a certificate whose
        /// dates or names cannot be read is still identified by its fingerprint.
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

    /// <summary>
    /// The certificate check of one TLS handshake: hands <see cref="ServerCertificatePolicy"/> what
    /// the system found, and keeps what it decided for the log afterwards.
    /// </summary>
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

        /// <summary>What was decided; <see cref="ServerCertificatePolicy.Verdict.Rejected"/> until the server's certificate was seen.</summary>
        internal ServerCertificatePolicy.Verdict Verdict { get; private set; } = ServerCertificatePolicy.Verdict.Rejected;

        /// <summary>The fingerprint of the certificate the server presented, or null.</summary>
        internal string Fingerprint { get; private set; }

        /// <summary>For <see cref="ServerCertificatePolicy.Verdict.AcceptedUntrusted"/>: what the system found wrong with it.</summary>
        internal string Problems { get; private set; }

        /// <summary>Why the certificate was rejected, or null if it was not (or not seen at all).</summary>
        internal string Rejection { get; private set; }

        /// <summary>The <see cref="RemoteCertificateValidationCallback"/> of the handshake.</summary>
        internal bool Validate(object sender, X509Certificate certificate, X509Chain chain, SslPolicyErrors errors)
        {
            // An exception thrown out of here would end the handshake with an error that says
            // nothing about the certificate.
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
