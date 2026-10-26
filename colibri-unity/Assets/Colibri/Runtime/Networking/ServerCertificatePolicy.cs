using System;
using System.Globalization;
using System.Net.Security;
using System.Security.Cryptography;
using System.Text;

namespace HCIKonstanz.Colibri.Networking
{
    /// <summary>
    /// Which server certificates a TLS connection accepts. By default the system decides: an
    /// authority this device trusts, issued for the configured server address. Two settings in
    /// <see cref="Setup.ColibriConfig"/> change that:
    /// <list type="bullet">
    /// <item><see cref="Setup.ColibriConfig.AllowSelfSignedCertificate"/> also accepts a certificate
    /// the system does not trust, or one issued for another name. The connection stays encrypted,
    /// but nothing checks that it reaches the right server.</item>
    /// <item><see cref="Setup.ColibriConfig.ServerCertificateSha256"/>, when set, accepts only the
    /// certificate with that fingerprint, whether the system trusts it or not. The server logs its
    /// fingerprint at startup.</item>
    /// </list>
    /// </summary>
    /// <remarks>
    /// Pure functions, testable without a TLS server. <see cref="ServerCertificateCheck"/> is the
    /// part that sees a real certificate.
    /// </remarks>
    internal static class ServerCertificatePolicy
    {
        internal enum Verdict
        {
            /// <summary>The system trusts it, under the configured server address.</summary>
            Trusted,

            /// <summary>Its fingerprint is the configured one.</summary>
            Pinned,

            /// <summary>The system does not trust it; accepted because self-signed certificates are allowed.</summary>
            AcceptedUntrusted,

            Rejected,
        }

        private const int Sha256HexDigits = 64;

        /// <summary>Decides about one certificate.</summary>
        /// <param name="errors">The system's own verdict; <see cref="SslPolicyErrors.None"/> if it trusts the certificate.</param>
        /// <param name="fingerprint">In any form <see cref="TryNormalizeFingerprint"/> reads; null if the server sent no certificate.</param>
        /// <param name="pin"><see cref="Setup.ColibriConfig.ServerCertificateSha256"/>, as entered.</param>
        internal static Verdict Decide(SslPolicyErrors errors, string fingerprint, bool allowSelfSigned, string pin)
        {
            // An unparsable pin rejects everything; falling back to the system check or to
            // allowSelfSigned would accept certificates the pin was meant to exclude.
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

            // The allowance covers certificate problems, not a missing certificate.
            if (allowSelfSigned && (errors & SslPolicyErrors.RemoteCertificateNotAvailable) == 0)
                return Verdict.AcceptedUntrusted;

            return Verdict.Rejected;
        }

        /// <summary>
        /// Decision for a UnityWebRequest certificate handler, which gets the certificate but not the
        /// system's verdict, so the system is assumed to have rejected it. Only used when
        /// <see cref="HasOwnRules"/> is true; otherwise the system decides alone.
        /// </summary>
        internal static bool AcceptsWithoutSystemCheck(string fingerprint, bool allowSelfSigned, string pin)
            => Decide(SslPolicyErrors.RemoteCertificateChainErrors, fingerprint, allowSelfSigned, pin) != Verdict.Rejected;

        /// <summary>Whether either setting replaces the system's own check.</summary>
        internal static bool HasOwnRules(bool allowSelfSigned, string pin)
            => allowSelfSigned || !string.IsNullOrWhiteSpace(pin);

        /// <summary>
        /// Reads a SHA-256 fingerprint as people copy it: any case, with or without colons, stray
        /// whitespace. <paramref name="normalized"/> is the 64 digits in upper case, or empty for an
        /// empty <paramref name="fingerprint"/>.
        /// </summary>
        /// <returns>False if it is not empty and not 64 hexadecimal digits (<paramref name="normalized"/> is then null).</returns>
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
        /// The SHA-256 fingerprint of a DER-encoded certificate, formatted as colibri-server logs it
        /// and <c>openssl x509 -fingerprint -sha256</c> prints it: upper-case hex, colons between bytes.
        /// </summary>
        internal static string Fingerprint(byte[] der)
        {
            // Not SHA256.Create(): it looks its implementation up by name, which IL2CPP stripping cannot see.
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
                // Dates are checked here because Unity's TLS backend does not say which part of the chain failed.
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

        /// <summary>Why <see cref="Decide"/> rejected a certificate and what to change, as one console line.</summary>
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
}
