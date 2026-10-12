using System.Linq;
using System.Text.RegularExpressions;
using HCIKonstanz.Colibri.Setup;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;
using UnityEngine.TestTools;
using Object = UnityEngine.Object;
using Setting = HCIKonstanz.Colibri.Setup.AndroidSettingsCheck.Setting;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// The two Player settings that break a Meta Quest build without a word: no INTERNET
    /// permission means no socket, and plain HTTP to a remote server means no Store. Only the
    /// detection is tested here - the fixes write the project's real Player settings.
    /// </summary>
    public class AndroidSettingsCheckTests
    {
        private const string RemoteServer = "192.168.1.20";

        private static Setting[] Issues(BuildTarget target = BuildTarget.Android, string server = RemoteServer, bool ssl = false,
            InsecureHttpOption http = InsecureHttpOption.NotAllowed, bool development = false, bool internet = false)
            => AndroidSettingsCheck.FindIssues(target, server, ssl, http, development, internet).Select(i => i.Setting).ToArray();

        [Test]
        public void AnAndroidBuildWithBothSettingsWrongReportsBoth()
        {
            Assert.That(Issues(), Is.EquivalentTo(new[] { Setting.InternetAccess, Setting.AllowDownloadsOverHttp }));
        }

        [Test]
        public void AnAndroidBuildWithBothSettingsRightReportsNothing()
        {
            Assert.That(Issues(http: InsecureHttpOption.AlwaysAllowed, internet: true), Is.Empty);
        }

        /// <summary>
        /// Internet Access is an Android setting; Allow downloads over HTTP is enforced by every
        /// player, as a Windows IL2CPP player refusing Store's plain HTTP showed.
        /// </summary>
        [TestCase(BuildTarget.StandaloneWindows64)]
        [TestCase(BuildTarget.StandaloneLinux64)]
        [TestCase(BuildTarget.iOS)]
        public void OtherBuildTargetsAreCheckedForHttpOnly(BuildTarget target)
        {
            Assert.That(Issues(target: target), Is.EqualTo(new[] { Setting.AllowDownloadsOverHttp }));
            Assert.That(Issues(target: target, http: InsecureHttpOption.AlwaysAllowed), Is.Empty);
        }

        [Test]
        public void InternetAccessAutoIsReported()
        {
            Assert.That(Issues(http: InsecureHttpOption.AlwaysAllowed, internet: false), Is.EqualTo(new[] { Setting.InternetAccess }));
        }

        [Test]
        public void PlainHttpIsNotAProblemWhenTheServerUsesSsl()
        {
            Assert.That(Issues(ssl: true, internet: true), Is.Empty);
        }

        [TestCase("localhost")]
        [TestCase("LOCALHOST")]
        [TestCase("127.0.0.1")]
        [TestCase("::1")]
        public void PlainHttpToLoopbackIsNotAProblem(string server)
        {
            // Unity lets plain HTTP through to localhost whatever the setting says.
            Assert.That(Issues(server: server, internet: true), Is.Empty);
        }

        [Test]
        public void HttpAllowedInDevelopmentBuildsCoversDevelopmentBuildsOnly()
        {
            Assert.That(Issues(http: InsecureHttpOption.DevelopmentOnly, development: true, internet: true), Is.Empty);
            Assert.That(Issues(http: InsecureHttpOption.DevelopmentOnly, development: false, internet: true),
                Is.EqualTo(new[] { Setting.AllowDownloadsOverHttp }));
        }

        /// <summary>
        /// The build hook. Unity cannot be made to build from a test, so it is driven through the
        /// method the hook calls, with the settings passed in.
        /// </summary>
        [Test]
        public void AnAndroidBuildWithBothSettingsWrongLogsBothWarnings()
        {
            var config = RemoteConfig();
            try
            {
                LogAssert.Expect(LogType.Warning, new Regex(@"^Colibri \(Android build\): Internet Access is set to Auto"));
                LogAssert.Expect(LogType.Warning, new Regex(@"^Colibri \(build\): Allow downloads over HTTP is 'Not allowed'"));

                AndroidSettingsBuildCheck.Check(BuildTarget.Android, false, config, InsecureHttpOption.NotAllowed, false);

                LogAssert.NoUnexpectedReceived();
            }
            finally
            {
                Object.DestroyImmediate(config);
            }
        }

        [Test]
        public void AWindowsBuildWithHttpNotAllowedLogsOnlyTheHttpWarning()
        {
            var config = RemoteConfig();
            try
            {
                LogAssert.Expect(LogType.Warning, new Regex(@"^Colibri \(build\): Allow downloads over HTTP is 'Not allowed'"));

                // Internet Access is Android's alone: false here must not add a warning.
                AndroidSettingsBuildCheck.Check(BuildTarget.StandaloneWindows64, false, config, InsecureHttpOption.NotAllowed, false);

                LogAssert.NoUnexpectedReceived();
            }
            finally
            {
                Object.DestroyImmediate(config);
            }
        }

        [Test]
        public void ABuildWithNothingToReportLogsNothing()
        {
            var config = RemoteConfig();
            try
            {
                AndroidSettingsBuildCheck.Check(BuildTarget.Android, false, config, InsecureHttpOption.AlwaysAllowed, true);
                AndroidSettingsBuildCheck.Check(BuildTarget.StandaloneWindows64, false, config, InsecureHttpOption.AlwaysAllowed, false);
                // HTTP allowed in development builds, and this is one.
                AndroidSettingsBuildCheck.Check(BuildTarget.Android, true, config, InsecureHttpOption.DevelopmentOnly, true);
                // A project without a Colibri configuration has no server address to judge.
                AndroidSettingsBuildCheck.Check(BuildTarget.Android, false, null, InsecureHttpOption.NotAllowed, false);

                LogAssert.NoUnexpectedReceived();
            }
            finally
            {
                Object.DestroyImmediate(config);
            }
        }

        private static ColibriConfig RemoteConfig()
        {
            var config = ScriptableObject.CreateInstance<ColibriConfig>();
            config.ServerAddress = RemoteServer;
            config.IsSSL = false;
            return config;
        }

        [Test]
        public void EveryIssueOffersAFix()
        {
            foreach (var issue in AndroidSettingsCheck.FindIssues(BuildTarget.Android, RemoteServer, false, InsecureHttpOption.NotAllowed, false, false))
            {
                Assert.That(issue.Fix, Is.Not.Null, issue.Message);
                Assert.That(issue.FixLabel, Is.Not.Empty, issue.Message);
            }
        }
    }
}
