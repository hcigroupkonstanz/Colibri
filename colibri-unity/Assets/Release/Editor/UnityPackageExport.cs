using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace HCIKonstanz.Colibri.Release.Editor
{
    /// <summary>
    /// Exports Colibri as a .unitypackage for the releases page, with the samples included.
    ///
    /// The samples live in Assets/Colibri/Samples~, which Unity does not import, so ExportPackage
    /// would leave them out. They are copied with their .meta files to
    /// Assets/Samples/Colibri/{version}/{displayName}, where the Package Manager's Import puts them
    /// too, exported with the package and deleted again afterwards. Copying the .meta files keeps
    /// the GUIDs, so the scenes keep their references.
    ///
    /// Colibri's own tests (Assets/Colibri/Tests) are left out: in a project with the Test
    /// Framework, they would show up in the user's Test Runner.
    ///
    /// Run from the menu (Tools → Colibri → Export .unitypackage), or as: Unity -batchmode -projectPath
    /// colibri-unity -executeMethod HCIKonstanz.Colibri.Release.Editor.UnityPackageExport.Export
    /// with COLIBRI_UNITYPACKAGE set to the output path. Exits 0 if the export succeeded.
    /// </summary>
    public static class UnityPackageExport
    {
        [Serializable]
        private class PackageJson
        {
            public string version;
            public Sample[] samples;
        }

        [Serializable]
        private class Sample
        {
            public string displayName;
            public string path;
        }

        private const string PackageRoot = "Assets/Colibri";
        private const string SamplesRoot = "Assets/Samples";
        private const string TestsRoot = PackageRoot + "/Tests";

        [MenuItem("Tools/Colibri/Export .unitypackage")]
        private static void ExportFromMenu()
        {
            var output = EditorUtility.SaveFilePanel("Export Colibri", "", $"Colibri-{ReadPackage().version}", "unitypackage");
            if (string.IsNullOrEmpty(output))
            {
                return;
            }

            if (TryExport(output))
            {
                EditorUtility.RevealInFinder(output);
            }
        }

        public static void Export()
        {
            var output = Environment.GetEnvironmentVariable("COLIBRI_UNITYPACKAGE");
            if (string.IsNullOrEmpty(output))
            {
                Debug.LogError("[UnityPackageExport] COLIBRI_UNITYPACKAGE is not set");
                EditorApplication.Exit(2);
                return;
            }

            EditorApplication.Exit(TryExport(output) ? 0 : 1);
        }

        private static bool TryExport(string output)
        {
            // Deleting the copies afterwards would also delete samples someone imported here.
            if (Directory.Exists(SamplesRoot))
            {
                Debug.LogError($"[UnityPackageExport] {SamplesRoot} already exists. Move it out of the project and export again.");
                return false;
            }

            var package = ReadPackage();
            var version = package.version;
            try
            {
                foreach (var sample in package.samples)
                {
                    var source = Path.Combine(PackageRoot, sample.path);
                    var target = Path.Combine(SamplesRoot, "Colibri", version, sample.displayName);
                    CopyDirectory(source, target);
                }

                AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
                // Listed one by one instead of with ExportPackageOptions.Recurse, which cannot leave out the tests.
                var assets = AssetDatabase.GetAllAssetPaths()
                    .Where(path => IsBelow(path, PackageRoot) || IsBelow(path, SamplesRoot))
                    .Where(path => !IsBelow(path, TestsRoot))
                    .ToArray();
                AssetDatabase.ExportPackage(assets, output);
                Debug.Log($"[UnityPackageExport] Exported Colibri {version} with samples, without tests, to {output}");
                return true;
            }
            catch (Exception e)
            {
                Debug.LogError($"[UnityPackageExport] Export failed: {e}");
                return false;
            }
            finally
            {
                FileUtil.DeleteFileOrDirectory(SamplesRoot);
                FileUtil.DeleteFileOrDirectory(SamplesRoot + ".meta");
                AssetDatabase.Refresh();
            }
        }

        private static bool IsBelow(string path, string folder)
        {
            return path == folder || path.StartsWith(folder + "/", StringComparison.Ordinal);
        }

        private static PackageJson ReadPackage()
        {
            return JsonUtility.FromJson<PackageJson>(File.ReadAllText(Path.Combine(PackageRoot, "package.json")));
        }

        private static void CopyDirectory(string source, string target)
        {
            if (!Directory.Exists(source))
            {
                throw new DirectoryNotFoundException($"Sample folder {source} from package.json does not exist");
            }

            Directory.CreateDirectory(target);
            foreach (var file in Directory.GetFiles(source))
            {
                File.Copy(file, Path.Combine(target, Path.GetFileName(file)));
            }
            foreach (var directory in Directory.GetDirectories(source))
            {
                CopyDirectory(directory, Path.Combine(target, Path.GetFileName(directory)));
            }
        }
    }
}
