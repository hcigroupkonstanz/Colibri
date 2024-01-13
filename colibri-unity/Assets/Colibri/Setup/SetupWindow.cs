#if UNITY_EDITOR
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Callbacks;
using UnityEngine;

namespace HCIKonstanz.Colibri.Setup
{
    [InitializeOnLoad]
    public class SetupWindow : EditorWindow
    {
        private static SetupWindow Instance;
        private static bool IsOpen => Instance != null;
        private static bool _waitingToLoad;

        private ColibriConfig Config;

        [DidReloadScripts]
        static void OnReload()
        {
            Init();
        }

        // TODO: this is rather inflexible. Maybe there's a better way to detect the configuration (Resources.Load is not allowed in static methods)?
        private static bool ConfigExists() => File.Exists(Path.Combine(Application.dataPath, "Resources", ColibriConfig.CONFIG_NAME));

        static void Init()
        {
            if (!ConfigExists())
            {
                if (EditorApplication.isCompiling && !_waitingToLoad)
                {
                    _waitingToLoad = true;
                    EditorApplication.update += Init;
                    return;
                }

                if (!EditorApplication.isCompiling)
                {
                    if (_waitingToLoad)
                    {
                        EditorApplication.update -= Init;
                        _waitingToLoad = false;
                    }

                    ShowConfigurationWindow();
                }
            }
        }


        [MenuItem("Window/Colibri Configuration")]
        private static void ShowConfigurationWindow()
        {
            // There should be only one configurator window open as a "pop-up". If already open, then just force focus on our instance
            if (IsOpen)
            {
                Instance.Focus();
            }
            else
            {
                var window = CreateInstance<SetupWindow>();
                window.titleContent = new GUIContent("Colibri Setup", EditorGUIUtility.IconContent("_Popup").image);
                window.position = new Rect(Screen.width / 2.0f, Screen.height / 2.0f, 500, 550);
                window.ShowUtility();
            }
        }

        private void OnEnable()
        {
            Instance = this;

            Config = ColibriConfig.Load();
            if (Config == null)
            {
                Config = CreateInstance<ColibriConfig>();
                SaveConfig();
            }
        }

        private void SaveConfig()
        {
            Directory.CreateDirectory(Path.Combine(Application.dataPath, "Resources"));
            string path = Path.Combine("Assets", "Resources", ColibriConfig.CONFIG_NAME);
            if (!ConfigExists())
                AssetDatabase.CreateAsset(Config, path);
            else
            {
                AssetDatabase.SaveAssets();
                AssetDatabase.Refresh();
            }
        }

        private void OnGUI()
        {
            GUILayout.Label("Colibri Setup", new GUIStyle(EditorStyles.largeLabel)
            {
                fontSize = 22,
                fontStyle = FontStyle.Bold,
                fixedWidth = 500
            });

            GUILayout.Space(15f);

            var logo = AssetDatabase.LoadAssetAtPath<Texture2D>(AssetDatabase.GUIDToAssetPath("997fb65d771f4694f8335970ea4e3916"));
            GUILayout.BeginHorizontal();
            GUILayout.FlexibleSpace();
            GUILayout.Label(logo, GUILayout.MaxHeight(128f));
            GUILayout.FlexibleSpace();
            GUILayout.EndHorizontal();

            GUILayout.Space(15f);
            EditorGUILayout.LabelField("", GUI.skin.horizontalSlider);


            GUILayout.Label("Please choose a unique application name. Each client *must* have the same app name!", new GUIStyle(EditorStyles.helpBox));
            Config.AppName = EditorGUILayout.TextField("App Name: ", Config.AppName);
            Config.ServerAddress = EditorGUILayout.TextField("Server Address: ", Config.ServerAddress);
            GUILayout.Space(16);
            GUILayout.Label("Optional Config (only modify if you know what you are doing!)", new GUIStyle(EditorStyles.helpBox));
            Config.WebServerPort = EditorGUILayout.IntField("Web server Port: ", Config.WebServerPort);
            Config.TcpServerPort = EditorGUILayout.IntField("TCP server Port: ", Config.TcpServerPort);
            Config.VoiceServerPort = EditorGUILayout.IntField("Voice server Port: ", Config.VoiceServerPort);

            var errors = new List<string>();

            if (string.IsNullOrEmpty(Config.AppName))
                errors.Add("App Name must not be empty!");
            if (Config.ServerAddress.Contains("://"))
                errors.Add("Server address should not contain a protocol (only IP or domain name)");
            if (Config.WebServerPort <= 0 || Config.WebServerPort > 65535)
                errors.Add("Web server port invalid (must be a number between 1 - 65535, default 9011)");
            if (Config.TcpServerPort <= 0 || Config.TcpServerPort > 65535)
                errors.Add("TCP server port invalid (must be a number between 1 - 65535, default 9012)");
            if (Config.VoiceServerPort <= 0 || Config.VoiceServerPort > 65535)
                errors.Add("Voice server port invalid (must be a number between 1 - 65535, default 9013)");
            if ((new int[] { Config.WebServerPort, Config.TcpServerPort, Config.VoiceServerPort }).Distinct().Count() != 3)
                errors.Add("Two ports may not have the same value!");

            GUILayout.Space(15f);

            EditorGUI.BeginDisabledGroup(errors.Count != 0);
            if (GUILayout.Button("Save Config"))
            {
                EditorUtility.SetDirty(Config);
                SaveConfig();
                Close();
            }
            EditorGUI.EndDisabledGroup();

            foreach (var error in errors)
                GUILayout.Label(error, new GUIStyle(EditorStyles.helpBox)
                {
                    fontStyle = FontStyle.Italic
                });
        }
    }
}
#endif
