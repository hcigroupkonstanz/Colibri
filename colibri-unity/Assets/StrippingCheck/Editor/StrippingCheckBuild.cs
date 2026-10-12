using System;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace HCIKonstanz.Colibri.StrippingCheck.Editor
{
    /// <summary>
    /// Builds the player for run-tests.mjs --stripping: Release, IL2CPP, Managed Stripping High,
    /// for the desktop platform the Editor runs on, from a scene generated for the build and
    /// deleted after it. The project's own Player settings are put back afterwards.
    ///
    /// Run as: Unity -batchmode -projectPath colibri-unity -executeMethod
    ///   HCIKonstanz.Colibri.StrippingCheck.Editor.StrippingCheckBuild.Build
    /// with COLIBRI_STRIPPING_PLAYER set to the player's path. Exits 0 if the build succeeded.
    /// </summary>
    public static class StrippingCheckBuild
    {
        private const string ScenePath = "Assets/StrippingCheck/StrippingCheckScene.unity";

        public static void Build()
        {
            var output = Environment.GetEnvironmentVariable("COLIBRI_STRIPPING_PLAYER");
            if (string.IsNullOrEmpty(output))
            {
                Debug.LogError("[StrippingCheck] COLIBRI_STRIPPING_PLAYER is not set");
                EditorApplication.Exit(2);
                return;
            }

            var target = Application.platform switch
            {
                RuntimePlatform.WindowsEditor => BuildTarget.StandaloneWindows64,
                RuntimePlatform.OSXEditor => BuildTarget.StandaloneOSX,
                _ => BuildTarget.StandaloneLinux64,
            };

            var standalone = NamedBuildTarget.Standalone;
            var previousBackend = PlayerSettings.GetScriptingBackend(standalone);
            var previousStripping = PlayerSettings.GetManagedStrippingLevel(standalone);
            var succeeded = false;
            try
            {
                // The model types the player checks live in the scripts; the scene only has to exist.
                var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                EditorSceneManager.SaveScene(scene, ScenePath);

                PlayerSettings.SetScriptingBackend(standalone, ScriptingImplementation.IL2CPP);
                PlayerSettings.SetManagedStrippingLevel(standalone, ManagedStrippingLevel.High);

                var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
                {
                    scenes = new[] { ScenePath },
                    locationPathName = output,
                    target = target,
                    options = BuildOptions.None,
                });
                succeeded = report.summary.result == BuildResult.Succeeded;
                Debug.Log($"[StrippingCheck] build {report.summary.result} for {target}: {report.summary.totalErrors} errors, {report.summary.totalTime}");
            }
            finally
            {
                PlayerSettings.SetScriptingBackend(standalone, previousBackend);
                PlayerSettings.SetManagedStrippingLevel(standalone, previousStripping);
                AssetDatabase.DeleteAsset(ScenePath);
            }

            EditorApplication.Exit(succeeded ? 0 : 1);
        }
    }
}
