using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;

namespace HCIKonstanz.Colibri.Setup
{
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
