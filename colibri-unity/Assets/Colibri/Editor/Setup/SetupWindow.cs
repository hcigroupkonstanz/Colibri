using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEditor.Callbacks;
using UnityEngine;
using UnityEngine.UIElements;

namespace HCIKonstanz.Colibri.Setup
{
    [InitializeOnLoad]
    public class SetupWindow : EditorWindow
    {
        private static SetupWindow Instance;
        private static bool IsOpen => Instance != null;
        private static bool _waitingToLoad;
        private static bool _portSettings = false;

        // The two longest labels, both indented under "Server supports SSL/TLS?". TlsLabelWidth sizes the column for them.
        private const string AllowSelfSignedLabel = "Allow self-signed certificate";
        private const string CertificateSha256Label = "Server certificate SHA-256";

        /// <summary>EditorGUI's indent per indentLevel. Unity does not expose it.</summary>
        private const float IndentPerLevel = 15f;

        /// <summary>The configuration asset, which Play mode and builds use.</summary>
        private ColibriConfig Config;

        // Serialized like _refused, so a refused value survives a domain reload, such as entering
        // Play mode. The unsaved object outlives the reload, and Unity restores the reference to it.
        /// <summary>
        /// What the fields show and change: <see cref="Config"/>'s settings, except those in
        /// <see cref="_refused"/>. Changes reach Config through <see cref="ConfigValidation.ApplyValidSettings"/>.
        /// </summary>
        [SerializeField] private ColibriConfig _edited;

        /// <summary>Settings whose value in <see cref="_edited"/> failed the checks, so Config keeps its own.</summary>
        [SerializeField] private List<string> _refused = new List<string>();

        private Vector2 _scroll;

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
            if (!ConfigExists())
            {
                // Load() returns a shared, hidden defaults object when there is no asset. Saving that
                // object would make it the asset, so create a new one.
                Config = CreateInstance<ColibriConfig>();
                SaveConfig();
            }

            // Survives a domain reload, so only a new window creates it. OnGUI copies Config into it.
            if (_edited == null)
            {
                _edited = CreateInstance<ColibriConfig>();
                _edited.hideFlags = HideFlags.HideAndDontSave;

                // Names left over from the old copy would keep the new one from taking Config's values.
                _refused.Clear();
            }
        }

        // Only when the window closes. OnDisable also runs on a domain reload, which must keep _edited.
        private void OnDestroy()
        {
            if (_edited != null)
                DestroyImmediate(_edited);
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
            // Every draw, so a change made elsewhere (Inspector, Undo) shows here, and a later edit
            // here cannot write the old value back.
            ConfigValidation.ShowSettings(Config, _edited, _refused);

            var labelWidth = EditorGUIUtility.labelWidth;
            EditorGUIUtility.labelWidth = Mathf.Max(labelWidth, TlsLabelWidth());

            // The Android section at the bottom can run past the edge of the window.
            _scroll = EditorGUILayout.BeginScrollView(_scroll);

            DrawHeader();
            DrawAppSettings();
            DrawOptionalConfig();

            // Every draw, even with no change here: a change elsewhere can make a refused value valid.
            _refused = ConfigValidation.ApplyValidSettings(_edited, Config);

            var errors = ConfigValidation.ConfigurationErrors(_edited);

            DrawSaveButton(errors);
            DrawSendRateWarning();

            DrawAndroidIssues();

            EditorGUILayout.EndScrollView();

            EditorGUIUtility.labelWidth = labelWidth;
        }

        private static void DrawHeader()
        {
            // Stretched, not fixed: the scroll view's vertical scrollbar takes part of the width,
            // and a fixed width would overflow it.
            GUILayout.Label("Colibri Setup", new GUIStyle(EditorStyles.largeLabel)
            {
                fontSize = 22,
                fontStyle = FontStyle.Bold,
                alignment = TextAnchor.MiddleCenter,
                stretchWidth = true
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
        }

        private void DrawAppSettings()
        {
            EditorGUILayout.HelpBox("Choose an App Name unique to this project. Every client that should share objects and messages "
                + "must use the same App Name.", MessageType.Info);

            _edited.AppName = EditorGUILayout.TextField("App Name: ", _edited.AppName);

            var sharedAppName = ColibriConfig.SharedAppNameWarning(_edited.AppName);
            if (sharedAppName != null)
                EditorGUILayout.HelpBox(sharedAppName, MessageType.Warning);

            _edited.ServerAddress = EditorGUILayout.TextField("Server Address: ", _edited.ServerAddress);
        }

        private void DrawOptionalConfig()
        {
            GUILayout.Space(16);
            _portSettings = EditorGUILayout.Foldout(_portSettings, "Optional Config");
            if (_portSettings)
                DrawPortSettings();
        }

        private void DrawPortSettings()
        {
            var x = EditorGUILayout.BeginVertical();
            x.position = new Vector2(5, 5);
            EditorGUILayout.HelpBox("The ports, SSL/TLS and the voice sampling rate must match the server. Change them only "
                + "if the server does not use the defaults.", MessageType.Warning);
            _edited.IsSSL = EditorGUILayout.Toggle(new GUIContent("Server supports SSL/TLS?",
                "The server has TLS turned on (TLS_CERT and TLS_KEY): the TCP connection is encrypted, and the Store uses https."), _edited.IsSSL);
            if (_edited.IsSSL)
                DrawTlsSettings();
            _edited.WebServerPort = EditorGUILayout.IntField("Web server Port: ", _edited.WebServerPort);
            _edited.TcpServerPort = EditorGUILayout.IntField("TCP server Port: ", _edited.TcpServerPort);
            _edited.VoiceServerPort = EditorGUILayout.IntField("Voice server Port: ", _edited.VoiceServerPort);
            _edited.VoiceServerSamplingRate = EditorGUILayout.IntField("Voice Sampling Rate: ", _edited.VoiceServerSamplingRate);
            _edited.MaxSendRate = EditorGUILayout.IntField(new GUIContent("Max Send Rate (Hz): ",
                "The most updates per second one synced object (SyncTransform, SyncBehaviour) sends. "
                + "Nothing is lost: a single change goes out at once, and the latest values of quicker "
                + "changes go out when the interval is up. 0 = no limit, one update per frame. "
                + "Code can change it at runtime through SyncSettings.MaxSendRate."), _edited.MaxSendRate);
            EditorGUILayout.EndVertical();
        }

        private void DrawTlsSettings()
        {
            EditorGUI.indentLevel++;
            _edited.AllowSelfSignedCertificate = EditorGUILayout.Toggle(new GUIContent(AllowSelfSignedLabel,
                "Also accept a server certificate this device does not trust, such as a self-signed one. The connection "
                + "is still encrypted, but nothing checks that it goes to your server."), _edited.AllowSelfSignedCertificate);
            _edited.ServerCertificateSha256 = EditorGUILayout.TextField(new GUIContent(CertificateSha256Label,
                "Optional. The fingerprint of the one certificate to accept, trusted or not, as colibri-server logs it "
                + "when it starts; every other certificate is rejected. Leave it empty for a certificate from Let's Encrypt, "
                + "which changes with every renewal."), _edited.ServerCertificateSha256);
            EditorGUI.indentLevel--;
        }

        private void DrawSaveButton(List<string> errors)
        {
            GUILayout.Space(15f);

            EditorGUI.BeginDisabledGroup(errors.Count != 0);
            // Enabled only when nothing shown has an error, so everything shown has been applied.
            if (GUILayout.Button("Save Config"))
            {
                EditorUtility.SetDirty(Config);
                SaveConfig();
                Close();
            }
            EditorGUI.EndDisabledGroup();

            foreach (var error in errors)
                EditorGUILayout.HelpBox(error, MessageType.Error);
        }

        private void DrawSendRateWarning()
        {
            // Outside the foldout, which starts closed each time the window opens.
            if (_edited.MaxSendRate == 0)
            {
                EditorGUILayout.HelpBox("Max Send Rate is 0, so there is no limit: every moving synced object sends an update "
                    + "in every frame, 72 to 120 a second on a headset. One server and one Wi-Fi network cannot keep up "
                    + $"with dozens of clients doing that. The default is {ColibriConfig.DEFAULT_MAX_SEND_RATE}.", MessageType.Warning);
            }
        }

        /// <summary>
        /// The label column width that fits the two TLS labels with their indent. Unity's default
        /// of 150 px cuts them off. Measured rather than fixed, so it follows the editor's font.
        /// </summary>
        private static float TlsLabelWidth()
        {
            var widest = Mathf.Max(
                EditorStyles.label.CalcSize(new GUIContent(AllowSelfSignedLabel)).x,
                EditorStyles.label.CalcSize(new GUIContent(CertificateSha256Label)).x);

            // Their indent, and a few pixels between the text and the field.
            return IndentPerLevel + widest + 4f;
        }

        /// <summary>
        /// Settings that silently break a build. See <see cref="AndroidSettingsCheck"/>. They are
        /// checked against <see cref="_edited"/>, so turning SSL on clears the Allow downloads over HTTP issue.
        /// </summary>
        private void DrawAndroidIssues()
        {
            var issues = AndroidSettingsCheck.FindIssues(_edited);
            if (issues.Count == 0)
                return;

            GUILayout.Space(15f);
            EditorGUILayout.LabelField(EditorUserBuildSettings.activeBuildTarget == BuildTarget.Android
                ? "Android / Meta Quest"
                : "Player build", EditorStyles.boldLabel);

            foreach (var issue in issues)
            {
                EditorGUILayout.HelpBox(issue.Message, MessageType.Warning);
                if (GUILayout.Button(issue.FixLabel))
                    issue.Fix();
            }
        }
    }
}
