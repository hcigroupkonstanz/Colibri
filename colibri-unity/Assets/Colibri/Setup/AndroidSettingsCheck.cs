#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.Net;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEngine;

namespace HCIKonstanz.Colibri.Setup
{
    // Both settings fail in the built player, where there is no console to say why. The editor and
    // the build warn instead.
    internal static class AndroidSettingsCheck
    {
        internal enum Setting
        {
            InternetAccess,
            AllowDownloadsOverHttp
        }

        internal sealed class Issue
        {
            public readonly Setting Setting;
            public readonly string Message;
            public readonly string FixLabel;
            public readonly Action Fix;

            public Issue(Setting setting, string message, string fixLabel, Action fix)
            {
                Setting = setting;
                Message = message;
                FixLabel = fixLabel;
                Fix = fix;
            }
        }

        // Also used by the Setup window, with its unsaved edits.
        internal static List<Issue> FindIssues(ColibriConfig config)
        {
            return FindIssues(
                EditorUserBuildSettings.activeBuildTarget,
                config.Host,
                config.IsSSL,
                PlayerSettings.insecureHttpOption,
                EditorUserBuildSettings.development,
                PlayerSettings.Android.forceInternetPermission);
        }

        internal static List<Issue> FindIssues(BuildTarget target, string serverAddress, bool isSsl,
            InsecureHttpOption httpOption, bool developmentBuild, bool forceInternetPermission)
        {
            var issues = new List<Issue>();

            if (target == BuildTarget.Android && !forceInternetPermission)
            {
                issues.Add(new Issue(
                    Setting.InternetAccess,
                    "Internet Access is set to Auto. Colibri connects to the server with plain sockets, and an Android app "
                    + "may only open one with the INTERNET permission - which Auto only adds when Unity detects a networking "
                    + "API it knows about. A release build without it starts normally and never connects, and only logcat "
                    + "says why. Set Project Settings > Player > Android > Other Settings > Internet Access to Require.",
                    "Set Internet Access to Require",
                    () => PlayerSettings.Android.forceInternetPermission = true));
            }

            // Not only Android: the setting applies to every player platform.
            if (!isSsl && !string.IsNullOrWhiteSpace(serverAddress) && !IsLoopback(serverAddress)
                && !AllowsHttp(httpOption, developmentBuild))
            {
                issues.Add(new Issue(
                    Setting.AllowDownloadsOverHttp,
                    $"Allow downloads over HTTP is '{Describe(httpOption)}', but the Colibri server is reached over plain "
                    + $"http://{serverAddress.Trim()} (SSL is off in the Colibri configuration). Unity refuses every such request "
                    + "with \"Insecure connection not allowed\", so Store calls fail in the built app. Set Project Settings > "
                    + "Player > Other Settings > Allow downloads over HTTP to Always allowed - or turn SSL on if the server "
                    + "supports it.",
                    "Allow downloads over HTTP",
                    () => PlayerSettings.insecureHttpOption = InsecureHttpOption.AlwaysAllowed));
            }

            return issues;
        }

        private static bool AllowsHttp(InsecureHttpOption option, bool developmentBuild)
        {
            switch (option)
            {
                case InsecureHttpOption.AlwaysAllowed:
                    return true;
                case InsecureHttpOption.DevelopmentOnly:
                    return developmentBuild;
                default:
                    return false;
            }
        }

        // Unity lets plain HTTP through to localhost whatever the setting says.
        private static bool IsLoopback(string serverAddress)
        {
            var host = serverAddress.Trim();
            if (string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase))
                return true;

            return IPAddress.TryParse(host, out var address) && IPAddress.IsLoopback(address);
        }

        private static string Describe(InsecureHttpOption option)
        {
            switch (option)
            {
                case InsecureHttpOption.NotAllowed:
                    return "Not allowed";
                case InsecureHttpOption.DevelopmentOnly:
                    return "Allowed in development builds";
                default:
                    return option.ToString();
            }
        }


        [InitializeOnLoadMethod]
        private static void CheckAfterReload()
        {
            // Deferred: ColibriConfig loads through Resources, which is not reliably available during
            // domain setup. Not EditorApplication.delayCall, since Unity holds that while the editor
            // is in the background.
            EditorApplication.update += CheckOnFirstUpdate;
        }

        private static void CheckOnFirstUpdate()
        {
            EditorApplication.update -= CheckOnFirstUpdate;
            LogIssues();
        }

        internal static void LogIssues()
        {
            var config = ColibriConfig.Load();
            if (config != null)
                LogIssues(FindIssues(config));
        }

        internal static void LogIssues(IEnumerable<Issue> issues)
        {
            foreach (var issue in issues)
            {
                var scope = issue.Setting == Setting.InternetAccess ? "Android build" : "build";
                Debug.LogWarning($"Colibri ({scope}): {issue.Message}\nWindow -> Colibri Configuration can fix this with one click.");
            }
        }
    }

    // Warns only: the build goes ahead regardless.
    internal sealed class AndroidSettingsBuildCheck : IPreprocessBuildWithReport
    {
        public int callbackOrder => 0;

        public void OnPreprocessBuild(BuildReport report)
        {
            // The build's own Development flag, not the Build Settings window's: a scripted build
            // passes its options directly.
            var development = (report.summary.options & BuildOptions.Development) != 0;
            Check(report.summary.platform, development, ColibriConfig.Load(),
                PlayerSettings.insecureHttpOption, PlayerSettings.Android.forceInternetPermission);
        }

        // Every input is a parameter so the tests can call it without a build.
        internal static void Check(BuildTarget target, bool development, ColibriConfig config,
            InsecureHttpOption httpOption, bool forceInternetPermission)
        {
            if (config == null)
                return;

            AndroidSettingsCheck.LogIssues(AndroidSettingsCheck.FindIssues(
                target, config.Host, config.IsSSL, httpOption, development, forceInternetPermission));
        }
    }
}
#endif
