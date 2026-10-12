#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.Reflection;
using HCIKonstanz.Colibri.Setup;
using NUnit.Framework;
using UnityEngine;
using Object = UnityEngine.Object;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// The Setup window edits a copy of the configuration, and a change reaches the configuration in
    /// use only if Save would accept it. Writing the fields straight into the configuration put a
    /// fingerprint Save refused into Play mode all the same, where every certificate was rejected
    /// for it, and onto disk with the next save of the project's assets.
    /// </summary>
    /// <remarks>
    /// <see cref="Show"/> and <see cref="Apply"/> are what the window does before and after it draws
    /// the fields, on every OnGUI; a test sets a field of <see cref="_edited"/> between them, as
    /// typing does.
    /// </remarks>
    public class SetupWindowTests
    {
        private const string Sha256 = "57:71:4B:56:18:11:5B:4C:C8:FD:92:AD:AF:DD:07:65:8F:EF:8B:23:B5:79:A2:E8:57:60:F4:25:A2:3C:89:F7";

        /// <summary>The configuration in use: the asset, in the editor.</summary>
        private ColibriConfig _config;

        /// <summary>The window's copy, which its fields change.</summary>
        private ColibriConfig _edited;

        /// <summary>The settings the window holds back, with their value in <see cref="_edited"/>.</summary>
        private List<string> _refused;

        [SetUp]
        public void CreateConfigs()
        {
            _config = ScriptableObject.CreateInstance<ColibriConfig>();
            _config.name = "ColibriConfig";
            _config.AppName = "setup-window-tests";
            _config.IsSSL = true;

            _edited = ScriptableObject.CreateInstance<ColibriConfig>();
            _refused = new List<string>();
            Show();
        }

        [TearDown]
        public void DestroyConfigs()
        {
            Object.DestroyImmediate(_config);
            Object.DestroyImmediate(_edited);
        }

        private void Show() => SetupWindow.ShowSettings(_config, _edited, _refused);

        private void Apply() => _refused = SetupWindow.ApplyValidSettings(_edited, _config);

        [Test]
        public void AMalformedFingerprintDoesNotReachTheConfigurationInUse()
        {
            _edited.ServerCertificateSha256 = "AB:CD:XY";
            Apply();

            Assert.That(_refused, Is.EqualTo(new[] { nameof(ColibriConfig.ServerCertificateSha256) }));
            Assert.That(_config.ServerCertificateSha256, Is.Empty);
        }

        /// <summary>The configuration in use keeps the last valid value until the input is valid again.</summary>
        [Test]
        public void AFingerprintIsAppliedOnceItIsComplete()
        {
            _edited.ServerCertificateSha256 = Sha256.Substring(0, 20);
            Apply();
            Assert.That(_config.ServerCertificateSha256, Is.Empty, "Half a fingerprint was applied");

            Show();
            Assert.That(_edited.ServerCertificateSha256, Is.EqualTo(Sha256.Substring(0, 20)), "The window no longer shows what was typed");

            _edited.ServerCertificateSha256 = Sha256;
            Apply();
            Assert.That(_refused, Is.Empty);
            Assert.That(_config.ServerCertificateSha256, Is.EqualTo(Sha256));
        }

        /// <summary>Every check Save makes, not only the fingerprint's.</summary>
        [Test]
        public void NoValueThatSaveRefusesIsApplied()
        {
            var refused = new (string What, Action<ColibriConfig> Edit)[]
            {
                ("an empty App Name", config => config.AppName = " "),
                ("an address with a protocol", config => config.ServerAddress = "http://colibri.example.org"),
                ("TCP port 0", config => config.TcpServerPort = 0),
                ("two equal ports", config => config.VoiceServerPort = config.WebServerPort),
                ("a sampling rate of 8000", config => config.VoiceServerSamplingRate = 8000),
                ("a negative send rate", config => config.MaxSendRate = -1),
            };

            var before = JsonUtility.ToJson(_config);
            foreach (var (what, edit) in refused)
            {
                _refused.Clear();
                Show();
                edit(_edited);
                Apply();

                Assert.That(_refused, Is.Not.Empty, what);
                Assert.That(JsonUtility.ToJson(_config), Is.EqualTo(before), $"{what} was applied");
            }
        }

        /// <summary>As before: what the window shows is what Play mode uses, without pressing Save.</summary>
        [Test]
        public void AValidChangeIsAppliedAtOnce()
        {
            _edited.ServerAddress = "192.168.0.10";
            Apply();

            Assert.That(_refused, Is.Empty);
            Assert.That(_config.ServerAddress, Is.EqualTo("192.168.0.10"));
        }

        /// <summary>
        /// One refused value used to hold back every other change: the window applied all of its
        /// settings or none.
        /// </summary>
        [Test]
        public void AValidChangeIsAppliedWhileAnotherIsRefused()
        {
            _edited.ServerCertificateSha256 = "AB:CD:XY";
            _edited.WebServerPort = 9111;
            Apply();

            Assert.That(_refused, Is.EqualTo(new[] { nameof(ColibriConfig.ServerCertificateSha256) }));
            Assert.That(_config.WebServerPort, Is.EqualTo(9111));
            Assert.That(_config.ServerCertificateSha256, Is.Empty);
        }

        /// <summary>The voice port shares the check for equal ports with the refused web port, which is not its concern.</summary>
        [Test]
        public void APortIsAppliedWhileAnotherHasTheSameNumberAsAThird()
        {
            var webPort = _config.WebServerPort;
            _edited.WebServerPort = _config.TcpServerPort;
            Apply();

            Show();
            _edited.VoiceServerPort = 9113;
            Apply();

            Assert.That(_refused, Is.EqualTo(new[] { nameof(ColibriConfig.WebServerPort) }));
            Assert.That(_config.VoiceServerPort, Is.EqualTo(9113));
            Assert.That(_config.WebServerPort, Is.EqualTo(webPort));
        }

        /// <summary>Each half of a swap is refused on its own, as the two ports are then equal.</summary>
        [Test]
        public void TwoPortsCanBeSwappedWhileAnotherValueIsRefused()
        {
            var (webPort, tcpPort) = (_config.WebServerPort, _config.TcpServerPort);
            _edited.ServerCertificateSha256 = "AB:CD:XY";
            _edited.WebServerPort = tcpPort;
            Apply();
            Assert.That(_config.WebServerPort, Is.EqualTo(webPort), "Two equal ports were applied");

            Show();
            _edited.TcpServerPort = webPort;
            Apply();

            Assert.That(_refused, Is.EqualTo(new[] { nameof(ColibriConfig.ServerCertificateSha256) }));
            Assert.That((_config.WebServerPort, _config.TcpServerPort), Is.EqualTo((tcpPort, webPort)));
        }

        /// <summary>
        /// Such as in the asset's Inspector while the window is open. The window copied the
        /// configuration only when it opened, and its next change wrote all of that copy back.
        /// </summary>
        [Test]
        public void AChangeMadeElsewhereShowsAndIsKept()
        {
            _config.MaxSendRate = 60;
            Show();
            Assert.That(_edited.MaxSendRate, Is.EqualTo(60), "The window does not show the change");

            _edited.ServerAddress = "192.168.0.10";
            Apply();

            Assert.That(_config.MaxSendRate, Is.EqualTo(60), "The change made elsewhere was undone");
            Assert.That(_config.ServerAddress, Is.EqualTo("192.168.0.10"));
        }

        /// <summary>The value typed in stays in the window, while the other settings follow the change.</summary>
        [Test]
        public void ARefusedValueStaysThroughAChangeMadeElsewhere()
        {
            _edited.ServerCertificateSha256 = "AB:CD:XY";
            Apply();

            _config.ServerAddress = "192.168.0.10";
            Show();
            Apply();

            Assert.That(_edited.ServerCertificateSha256, Is.EqualTo("AB:CD:XY"));
            Assert.That(_edited.ServerAddress, Is.EqualTo("192.168.0.10"));
            Assert.That(_config.ServerCertificateSha256, Is.Empty);
        }

        /// <summary>The window applies on every OnGUI, not only when one of its fields changed.</summary>
        [Test]
        public void ARefusedValueIsAppliedOnceAChangeElsewhereMakesItValid()
        {
            _edited.WebServerPort = _config.TcpServerPort;
            Apply();
            Assert.That(_refused, Is.EqualTo(new[] { nameof(ColibriConfig.WebServerPort) }), "Two equal ports were applied");

            var port = _config.TcpServerPort;
            _config.TcpServerPort = 9112;
            Show();
            Apply();

            Assert.That(_refused, Is.Empty);
            Assert.That(_config.WebServerPort, Is.EqualTo(port));
        }

        [Test]
        public void EverySettingIsAppliedButNotTheAssetsName()
        {
            _edited.name = "edited";
            _edited.AppName = "another-app";
            _edited.ServerAddress = "192.168.0.10";
            _edited.WebServerPort = 9111;
            _edited.TcpServerPort = 9112;
            _edited.VoiceServerPort = 9113;
            _edited.IsSSL = true;
            _edited.AllowSelfSignedCertificate = true;
            _edited.ServerCertificateSha256 = Sha256;
            _edited.VoiceServerSamplingRate = 16000;
            _edited.MaxSendRate = 0;
            Apply();

            Assert.That(_refused, Is.Empty);
            foreach (var field in typeof(ColibriConfig).GetFields(BindingFlags.Public | BindingFlags.Instance))
                Assert.That(field.GetValue(_config), Is.EqualTo(field.GetValue(_edited)), field.Name);
            Assert.That(_config.name, Is.EqualTo("ColibriConfig"), "The asset's name has to stay the file's");
        }
    }
}
#endif
