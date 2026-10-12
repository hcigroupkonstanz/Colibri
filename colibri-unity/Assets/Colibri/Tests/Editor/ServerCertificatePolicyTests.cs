using System;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Setup;
using NUnit.Framework;
using UnityEngine;
using Verdict = HCIKonstanz.Colibri.Networking.ServerCertificatePolicy.Verdict;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// Which server certificates a TLS connection accepts, case by case, without a server: by
    /// default what the system trusts; with "Allow self-signed certificate" also what it does not;
    /// with a pinned fingerprint exactly that one certificate, and nothing else, trusted or not.
    /// </summary>
    public class ServerCertificatePolicyTests
    {
        /// <summary>
        /// The TLS test server's certificate, <c>colibri-unity/tls-test-server/cert.pem</c>:
        /// self-signed, for localhost, 127.0.0.1 and ::1.
        /// </summary>
        internal const string TestCertificatePem =
            "-----BEGIN CERTIFICATE-----\n" +
            "MIIDXTCCAkWgAwIBAgIUcyigc2td5cDEvtBdulEeA8nVpE0wDQYJKoZIhvcNAQEL\n" +
            "BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAwODE2MjYyMFoYDzIxMjYw\n" +
            "OTE0MTYyNjIwWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB\n" +
            "AQUAA4IBDwAwggEKAoIBAQCZZfKlAih1jbu5XnmSsIQxjb8eVo+n+a0toCINARSt\n" +
            "Vhj9r7Wmsc5o1MwBrTWKvXWyjDl0lhfcxMogQ2RHd71nSXjcqJl00fWrwHj66L/+\n" +
            "dN0P53RgscUdd8hiEE1pwp5Xvm1+5ilWEbIn08jIerigpS+eJWgW32aOsUet/DAA\n" +
            "kdWB4usu0i3O4cqbFh32EuapXbeI7UlMqZFFPLdc8fRziZlxmujmPudAskx1gClx\n" +
            "2bcWcM0/i+jFsISoAuxPU4azcV6tDOgv5qNNPppWxTE3i61vhakH5o+5JC2HcuKP\n" +
            "9O2Xsd0RxWg8Gut445C0Fm8FT4LaDWRXFujer0lqi1XXAgMBAAGjgaQwgaEwHQYD\n" +
            "VR0OBBYEFLSgxa61kAlN/dMYDkhWIFrkhWStMB8GA1UdIwQYMBaAFLSgxa61kAlN\n" +
            "/dMYDkhWIFrkhWStMCwGA1UdEQQlMCOCCWxvY2FsaG9zdIcEfwAAAYcQAAAAAAAA\n" +
            "AAAAAAAAAAAAATAOBgNVHQ8BAf8EBAMCBaAwEwYDVR0lBAwwCgYIKwYBBQUHAwEw\n" +
            "DAYDVR0TAQH/BAIwADANBgkqhkiG9w0BAQsFAAOCAQEAdGHSuSN+1LMqfO5nGvIl\n" +
            "Xlo0h6pdMT+YB2VJg8nxDHo9pRr01T6gD3miP70r/1I1pHeuTtLPqc2PHzekkkfi\n" +
            "Tlzfw9qzXJeUt7z1Iz22lT+/bKjL5wsGr7NJ8rf2THZ77ohLtpFSpo6BTHTWVHQQ\n" +
            "m4YgCuqIN14GBnYVr5T6j9zvxFihPYLqdoVaVl8HU7K3hHeuoq/syieyOCECQpiy\n" +
            "wIsSDvV4/mN6eOG9UxHxmm4gFsuDy80qIE5tDYYj9gJxUoqbwAXer5a0fdhPQZ/y\n" +
            "wvn4sqL7licWZiOlalod7b7zijnjrDNq/HrQ/TbJBakxnWyXlvVyC3nwoXKSMcxL\n" +
            "XA==\n" +
            "-----END CERTIFICATE-----\n";

        /// <summary>What <c>openssl x509 -fingerprint -sha256</c> prints for it.</summary>
        internal const string TestCertificateSha256 =
            "57:71:4B:56:18:11:5B:4C:C8:FD:92:AD:AF:DD:07:65:8F:EF:8B:23:B5:79:A2:E8:57:60:F4:25:A2:3C:89:F7";

        /// <summary>Some other certificate's fingerprint: the SHA-256 of "abc".</summary>
        internal const string OtherSha256 =
            "BA:78:16:BF:8F:01:CF:EA:41:41:40:DE:5D:AE:22:23:B0:03:61:A3:96:17:7A:9C:B4:10:FF:61:F2:00:15:AD";

        private const SslPolicyErrors Untrusted = SslPolicyErrors.RemoteCertificateChainErrors;
        private const SslPolicyErrors WrongName = SslPolicyErrors.RemoteCertificateNameMismatch;
        private const SslPolicyErrors NoCertificate = SslPolicyErrors.RemoteCertificateNotAvailable;

        private static readonly DateTime Now = new DateTime(2026, 10, 8, 12, 0, 0, DateTimeKind.Utc);


        /*
         *  Without a pin
         */

        [Test]
        public void ACertificateTheSystemTrustsIsAccepted()
        {
            Assert.That(ServerCertificatePolicy.Decide(SslPolicyErrors.None, OtherSha256, false, ""), Is.EqualTo(Verdict.Trusted));
            Assert.That(ServerCertificatePolicy.Decide(SslPolicyErrors.None, OtherSha256, true, ""), Is.EqualTo(Verdict.Trusted),
                "Allowing self-signed certificates should not change how a trusted one is accepted");
        }

        [TestCase(Untrusted)]
        [TestCase(WrongName)]
        [TestCase(Untrusted | WrongName)]
        public void ACertificateTheSystemDoesNotAcceptIsRejectedByDefault(SslPolicyErrors errors)
        {
            Assert.That(ServerCertificatePolicy.Decide(errors, TestCertificateSha256, false, ""), Is.EqualTo(Verdict.Rejected));
        }

        [TestCase(Untrusted)]
        [TestCase(WrongName)]
        [TestCase(Untrusted | WrongName)]
        public void ACertificateTheSystemDoesNotAcceptIsAcceptedWhenSelfSignedCertificatesAreAllowed(SslPolicyErrors errors)
        {
            Assert.That(ServerCertificatePolicy.Decide(errors, TestCertificateSha256, true, ""), Is.EqualTo(Verdict.AcceptedUntrusted));
        }

        /// <summary>The setting forgives what is wrong with a certificate, not the lack of one.</summary>
        [Test]
        public void AServerWithoutACertificateIsRejectedEvenWhenSelfSignedCertificatesAreAllowed()
        {
            Assert.That(ServerCertificatePolicy.Decide(NoCertificate, null, true, ""), Is.EqualTo(Verdict.Rejected));
        }

        [TestCase(null)]
        [TestCase("")]
        [TestCase("   ")]
        public void AnEmptyPinIsNoPin(string pin)
        {
            Assert.That(ServerCertificatePolicy.Decide(SslPolicyErrors.None, OtherSha256, false, pin), Is.EqualTo(Verdict.Trusted));
            Assert.That(ServerCertificatePolicy.Decide(Untrusted, OtherSha256, false, pin), Is.EqualTo(Verdict.Rejected));
        }


        /*
         *  With a pin
         */

        [TestCase(SslPolicyErrors.None, false)]
        [TestCase(Untrusted, false)]
        [TestCase(WrongName, false)]
        [TestCase(Untrusted | WrongName, false)]
        [TestCase(Untrusted | WrongName, true)]
        public void ThePinnedCertificateIsAcceptedWhateverTheSystemThinksOfIt(SslPolicyErrors errors, bool allowSelfSigned)
        {
            Assert.That(ServerCertificatePolicy.Decide(errors, TestCertificateSha256, allowSelfSigned, TestCertificateSha256),
                Is.EqualTo(Verdict.Pinned));
        }

        [TestCase(SslPolicyErrors.None, false)]
        [TestCase(SslPolicyErrors.None, true)]
        [TestCase(Untrusted, true)]
        [TestCase(Untrusted | WrongName, true)]
        public void EveryOtherCertificateIsRejectedWhenOneIsPinnedEvenATrustedOne(SslPolicyErrors errors, bool allowSelfSigned)
        {
            Assert.That(ServerCertificatePolicy.Decide(errors, OtherSha256, allowSelfSigned, TestCertificateSha256),
                Is.EqualTo(Verdict.Rejected));
        }

        [Test]
        public void APinRejectsAServerWithoutACertificate()
        {
            Assert.That(ServerCertificatePolicy.Decide(NoCertificate, null, true, TestCertificateSha256), Is.EqualTo(Verdict.Rejected));
        }

        /// <summary>A fingerprint is copied from wherever it was shown, in whatever form it was shown in.</summary>
        [TestCase("57:71:4B:56:18:11:5B:4C:C8:FD:92:AD:AF:DD:07:65:8F:EF:8B:23:B5:79:A2:E8:57:60:F4:25:A2:3C:89:F7")]
        [TestCase("57:71:4b:56:18:11:5b:4c:c8:fd:92:ad:af:dd:07:65:8f:ef:8b:23:b5:79:a2:e8:57:60:f4:25:a2:3c:89:f7")]
        [TestCase("57714B5618115B4CC8FD92ADAFDD07658FEF8B23B579A2E85760F425A23C89F7")]
        [TestCase("57714b5618115b4cc8fd92adafdd07658fef8b23b579a2e85760f425a23c89f7")]
        [TestCase("  57:71:4B:56:18:11:5B:4C:C8:FD:92:AD:AF:DD:07:65 8F:EF:8B:23:B5:79:A2:E8:57:60:F4:25:A2:3C:89:F7\n")]
        public void APinIsReadWithOrWithoutColonsInEitherCase(string pin)
        {
            Assert.That(ServerCertificatePolicy.Decide(Untrusted, TestCertificateSha256, false, pin), Is.EqualTo(Verdict.Pinned));
        }

        /// <summary>
        /// A pin that cannot match anything must not quietly fall back to the system's check: that
        /// would accept certificates whoever entered it meant to exclude.
        /// </summary>
        [TestCase("57:71:4B:56")]
        [TestCase("57714B5618115B4CC8FD92ADAFDD07658FEF8B23B579A2E85760F425A23C89F")]
        [TestCase("57714B5618115B4CC8FD92ADAFDD07658FEF8B23B579A2E85760F425A23C89F70")]
        [TestCase("57714B5618115B4CC8FD92ADAFDD07658FEF8B23B579A2E85760F425A23C89FG")]
        [TestCase("57-71-4B-56-18-11-5B-4C-C8-FD-92-AD-AF-DD-07-65-8F-EF-8B-23-B5-79-A2-E8-57-60-F4-25-A2-3C-89-F7")]
        public void AMalformedPinRejectsEveryCertificate(string pin)
        {
            Assert.That(ServerCertificatePolicy.Decide(SslPolicyErrors.None, TestCertificateSha256, false, pin), Is.EqualTo(Verdict.Rejected));
            Assert.That(ServerCertificatePolicy.Decide(Untrusted, TestCertificateSha256, true, pin), Is.EqualTo(Verdict.Rejected));
        }


        /*
         *  Fingerprints
         */

        [Test]
        public void TheFingerprintIsTheSha256OfTheDerEncodingInUpperCaseHexWithColons()
        {
            Assert.That(ServerCertificatePolicy.Fingerprint(Encoding.ASCII.GetBytes("abc")), Is.EqualTo(OtherSha256));
        }

        /// <summary>The same fingerprint colibri-server logs and openssl prints, so either can be pasted as the pin.</summary>
        [Test]
        public void ACertificatesFingerprintIsTheOneOpensslPrints()
        {
            Assert.That(ServerCertificatePolicy.Fingerprint(Der(TestCertificatePem)), Is.EqualTo(TestCertificateSha256));
        }


        /*
         *  What is said about a rejected certificate
         */

        [Test]
        public void ARejectedSelfSignedCertificateIsCalledThatWithBothWaysToAcceptIt()
        {
            var check = new ServerCertificateCheck("127.0.0.1", false, "");

            Assert.That(check.Validate(null, TestCertificate(), null, Untrusted), Is.False);
            Assert.That(check.Verdict, Is.EqualTo(Verdict.Rejected));
            Assert.That(check.Rejection, Does.StartWith("it is self-signed."));
            Assert.That(check.Rejection, Does.Contain("'Allow self-signed certificate'"));
            Assert.That(check.Rejection, Does.Contain($"({TestCertificateSha256}) as 'Server certificate SHA-256'"));
        }

        [Test]
        public void ARejectionSaysWhenTheCertificateExpired()
        {
            var expired = new ServerCertificate(OtherSha256, new DateTime(2024, 1, 1, 0, 0, 0, DateTimeKind.Utc),
                new DateTime(2026, 1, 31, 0, 0, 0, DateTimeKind.Utc), false);

            Assert.That(ServerCertificatePolicy.DescribeProblems(Untrusted, expired, "example.org", Now), Is.EqualTo("it expired on 2026-01-31"));
        }

        [Test]
        public void ARejectionSaysWhenTheCertificateIsNotValidYet()
        {
            var early = new ServerCertificate(OtherSha256, new DateTime(2027, 3, 1, 0, 0, 0, DateTimeKind.Utc),
                new DateTime(2028, 3, 1, 0, 0, 0, DateTimeKind.Utc), false);

            Assert.That(ServerCertificatePolicy.DescribeProblems(Untrusted, early, "example.org", Now), Is.EqualTo("it is not valid until 2027-03-01"));
        }

        [Test]
        public void ARejectionNamesTheServerAddressTheCertificateIsNotIssuedFor()
        {
            Assert.That(ServerCertificatePolicy.DescribeProblems(WrongName, Current(isSelfIssued: false), "192.168.0.10", Now),
                Is.EqualTo("it is not issued for '192.168.0.10'"));
            Assert.That(ServerCertificatePolicy.DescribeProblems(Untrusted | WrongName, Current(isSelfIssued: true), "192.168.0.10", Now),
                Is.EqualTo("it is self-signed and it is not issued for '192.168.0.10'"));
        }

        [Test]
        public void ARejectionOfACertificateFromAnUnknownAuthoritySaysSo()
        {
            Assert.That(ServerCertificatePolicy.DescribeProblems(Untrusted, Current(isSelfIssued: false), "example.org", Now),
                Is.EqualTo("it is not issued by a certificate authority this device trusts"));
        }

        [Test]
        public void ARejectionByThePinNamesTheFingerprintThatWasPresented()
        {
            var reason = ServerCertificatePolicy.ExplainRejection(SslPolicyErrors.None, Current(isSelfIssued: false), "example.org", false, TestCertificateSha256, Now);

            Assert.That(reason, Does.StartWith($"its SHA-256 fingerprint is {OtherSha256}, not the one in 'Server certificate SHA-256'"));
        }

        [Test]
        public void AMalformedPinIsNamedAsTheReason()
        {
            var reason = ServerCertificatePolicy.ExplainRejection(SslPolicyErrors.None, Current(isSelfIssued: false), "example.org", false, "57:71", Now);

            Assert.That(reason, Does.Contain("'Server certificate SHA-256' in the Colibri configuration is not a SHA-256 fingerprint"));
        }


        /*
         *  The check of a real certificate
         */

        [Test]
        public void TheCheckAcceptsThePinnedCertificate()
        {
            var check = new ServerCertificateCheck("127.0.0.1", false, TestCertificateSha256.Replace(":", "").ToLowerInvariant());

            Assert.That(check.Validate(null, TestCertificate(), null, Untrusted), Is.True);
            Assert.That(check.Verdict, Is.EqualTo(Verdict.Pinned));
            Assert.That(check.Fingerprint, Is.EqualTo(TestCertificateSha256));
            Assert.That(check.Rejection, Is.Null);
        }

        [Test]
        public void TheCheckAcceptsASelfSignedCertificateWhenAllowedAndSaysWhatIsWrongWithIt()
        {
            var check = new ServerCertificateCheck("127.0.0.1", true, "");

            Assert.That(check.Validate(null, TestCertificate(), null, Untrusted), Is.True);
            Assert.That(check.Verdict, Is.EqualTo(Verdict.AcceptedUntrusted));
            Assert.That(check.Problems, Is.EqualTo("it is self-signed"));
        }

        [Test]
        public void TheCheckRejectsAServerWithoutACertificate()
        {
            var check = new ServerCertificateCheck("127.0.0.1", true, "");

            Assert.That(check.Validate(null, null, null, NoCertificate), Is.False);
            Assert.That(check.Rejection, Is.EqualTo("the server sent no certificate"));
        }


        /*
         *  The Store's requests, which see the certificate but not the system's verdict
         */

        [Test]
        public void WebRequestsOnlyGetTheirOwnCheckWhenASettingAsksForIt()
        {
            Assert.That(ServerCertificatePolicy.HasOwnRules(false, ""), Is.False);
            Assert.That(ServerCertificatePolicy.HasOwnRules(false, "  "), Is.False);
            Assert.That(ServerCertificatePolicy.HasOwnRules(true, ""), Is.True);
            Assert.That(ServerCertificatePolicy.HasOwnRules(false, TestCertificateSha256), Is.True);
        }

        [Test]
        public void AWebRequestAcceptsAnyCertificateWhenSelfSignedCertificatesAreAllowed()
        {
            Assert.That(ServerCertificatePolicy.AcceptsWithoutSystemCheck(OtherSha256, true, ""), Is.True);
        }

        [Test]
        public void AWebRequestAcceptsOnlyThePinnedCertificateWhenOneIsPinned()
        {
            Assert.That(ServerCertificatePolicy.AcceptsWithoutSystemCheck(TestCertificateSha256, true, TestCertificateSha256), Is.True);
            Assert.That(ServerCertificatePolicy.AcceptsWithoutSystemCheck(OtherSha256, true, TestCertificateSha256), Is.False);
            Assert.That(ServerCertificatePolicy.AcceptsWithoutSystemCheck(OtherSha256, false, TestCertificateSha256), Is.False);
        }


        /*
         *  The configuration
         */

        /// <summary>
        /// A configuration saved before these settings existed has no values for them, and Unity
        /// leaves such fields at their initializers: so these are what every existing project gets.
        /// </summary>
        [Test]
        public void ANewConfigurationLeavesTheCertificateToTheSystem()
        {
            var config = ScriptableObject.CreateInstance<ColibriConfig>();
            try
            {
                Assert.That(config.IsSSL, Is.False);
                Assert.That(config.AllowSelfSignedCertificate, Is.False);
                Assert.That(config.ServerCertificateSha256, Is.Empty);
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(config);
            }
        }


        /*
         *  Helpers
         */

        private static ServerCertificate Current(bool isSelfIssued)
            => new ServerCertificate(OtherSha256, Now.AddYears(-1), Now.AddYears(1), isSelfIssued);

        private static X509Certificate2 TestCertificate() => new X509Certificate2(Der(TestCertificatePem));

        internal static byte[] Der(string pem)
        {
            var body = pem.Replace("-----BEGIN CERTIFICATE-----", "").Replace("-----END CERTIFICATE-----", "").Replace("\n", "");
            return Convert.FromBase64String(body);
        }
    }
}
