using HCIKonstanz.Colibri.Setup;
using HCIKonstanz.Colibri.Store;
using NUnit.Framework;
using UnityEngine;
using static HCIKonstanz.Colibri.Tests.ServerCertificatePolicyTests;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// The Store's https requests check the server's certificate with the same two settings as the
    /// TCP connection, so that a server with a self-signed certificate works for both. Without
    /// either, the system checks it, as it always did.
    /// </summary>
    public class ServerCertificateHandlerTests
    {
        /// <summary>Without TLS, or with neither setting, the Store's requests are left to the system's own check.</summary>
        [TestCase(false, true, TestCertificateSha256)]
        [TestCase(true, false, "")]
        [TestCase(true, false, "  ")]
        public void TheStoreAddsNoCheckOfItsOwnUnlessASettingAsksForIt(bool isSsl, bool allowSelfSigned, string pin)
        {
            var config = Config(isSsl, allowSelfSigned, pin);
            try
            {
                Assert.That(ServerCertificateHandler.For(config), Is.Null);
            }
            finally
            {
                Object.DestroyImmediate(config);
            }
        }

        [Test]
        public void TheStoreAcceptsTheServersSelfSignedCertificateWhenAllowed()
        {
            AssertHandler(Config(true, true, ""), Der(TestCertificatePem), accepts: true);
        }

        [Test]
        public void TheStoreAcceptsOnlyThePinnedCertificate()
        {
            AssertHandler(Config(true, true, TestCertificateSha256), Der(TestCertificatePem), accepts: true);
            AssertHandler(Config(true, true, OtherSha256), Der(TestCertificatePem), accepts: false);
        }

        private static void AssertHandler(ColibriConfig config, byte[] certificate, bool accepts)
        {
            try
            {
                using (var handler = ServerCertificateHandler.For(config))
                {
                    Assert.That(handler, Is.Not.Null, "TLS with a certificate setting should give the Store's requests their own check");
                    Assert.That(handler.Accepts(certificate), Is.EqualTo(accepts));
                }
            }
            finally
            {
                Object.DestroyImmediate(config);
            }
        }

        private static ColibriConfig Config(bool isSsl, bool allowSelfSigned, string pin)
        {
            var config = ScriptableObject.CreateInstance<ColibriConfig>();
            config.IsSSL = isSsl;
            config.AllowSelfSignedCertificate = allowSelfSigned;
            config.ServerCertificateSha256 = pin;
            return config;
        }
    }
}
