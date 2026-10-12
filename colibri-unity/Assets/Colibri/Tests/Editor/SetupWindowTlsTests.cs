#if UNITY_EDITOR
using HCIKonstanz.Colibri.Setup;
using NUnit.Framework;
using UnityEngine;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// The Setup window's check of the certificate settings: a pinned fingerprint that cannot match
    /// any certificate is not saved, since every connection would then be rejected.
    /// </summary>
    public class SetupWindowTlsTests
    {
        private ColibriConfig _config;

        [SetUp]
        public void CreateConfig() => _config = ScriptableObject.CreateInstance<ColibriConfig>();

        [TearDown]
        public void DestroyConfig() => Object.DestroyImmediate(_config);

        [TestCase("57:71:4b:56")]
        [TestCase("not a fingerprint")]
        public void AFingerprintThatCannotMatchIsAnError(string pin)
        {
            _config.IsSSL = true;
            _config.ServerCertificateSha256 = pin;

            Assert.That(SetupWindow.CertificateSettingsError(_config), Does.StartWith("Server certificate SHA-256 invalid"));
        }

        [TestCase("")]
        [TestCase("57:71:4B:56:18:11:5B:4C:C8:FD:92:AD:AF:DD:07:65:8F:EF:8B:23:B5:79:A2:E8:57:60:F4:25:A2:3C:89:F7")]
        [TestCase("57714b5618115b4cc8fd92adafdd07658fef8b23b579a2e85760f425a23c89f7")]
        public void AnEmptyOrWellFormedFingerprintIsFine(string pin)
        {
            _config.IsSSL = true;
            _config.ServerCertificateSha256 = pin;

            Assert.That(SetupWindow.CertificateSettingsError(_config), Is.Null);
        }

        /// <summary>Without TLS the settings are not used, so a half-typed fingerprint does not stop the configuration being saved.</summary>
        [Test]
        public void WithoutTlsTheFingerprintIsNotChecked()
        {
            _config.IsSSL = false;
            _config.ServerCertificateSha256 = "57:71";

            Assert.That(SetupWindow.CertificateSettingsError(_config), Is.Null);
        }
    }
}
#endif
