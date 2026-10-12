#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using HCIKonstanz.Colibri.Networking;
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

        // The two longest labels, both indented one level under "Server supports SSL/TLS?".
        private const string AllowSelfSignedLabel = "Allow self-signed certificate";
        private const string CertificateSha256Label = "Server certificate SHA-256";

        /// <summary>How far EditorGUI indents per indentLevel; it does not expose the figure.</summary>
        private const float IndentPerLevel = 15f;

        /// <summary>The configuration asset, which Play mode and builds use.</summary>
        private ColibriConfig Config;

        /// <summary>
        /// What the fields show and change: <see cref="Config"/>'s settings, but for those in
        /// <see cref="_refused"/>. A change reaches Config only if it passes the checks (see
        /// <see cref="ApplyValidSettings"/>).
        /// </summary>
        /// <remarks>
        /// Serialized, as <see cref="_refused"/> is, so that a refused value stays in the window
        /// through a domain reload, such as when entering Play mode: an object that is not saved
        /// outlives the reload, and Unity restores the window's reference to it.
        /// </remarks>
        [SerializeField] private ColibriConfig _edited;

        /// <summary>The settings whose value in <see cref="_edited"/> the checks refused, so Config does not have it.</summary>
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
                // Load() hands back a shared, hidden defaults object when there is no asset yet.
                // That one must not *become* the asset, so this window creates its own to save.
                Config = CreateInstance<ColibriConfig>();
                SaveConfig();
            }

            // Still there after a domain reload. OnGUI fills it.
            if (_edited == null)
            {
                _edited = CreateInstance<ColibriConfig>();
                _edited.hideFlags = HideFlags.HideAndDontSave;

                // Left from a copy that is gone, it would hold back the new copy's defaults.
                _refused.Clear();
            }
        }

        // When the window closes, which drops a value the checks refused; not before a domain
        // reload, as OnDisable would.
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
            // Every time, so that a change made elsewhere, such as in the asset's Inspector or by
            // an Undo, shows here, and the next change here does not write the old value back.
            ShowSettings(Config, _edited, _refused);

            var labelWidth = EditorGUIUtility.labelWidth;
            EditorGUIUtility.labelWidth = Mathf.Max(labelWidth, TlsLabelWidth());

            // The Android section at the bottom can run past the edge of the window.
            _scroll = EditorGUILayout.BeginScrollView(_scroll);

            // Stretched to the width there is, not fixed to the window's 500 px: inside the scroll
            // view, a vertical scrollbar takes some of those, and a fixed-width title then added
            // a horizontal one as well.
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

            EditorGUILayout.HelpBox("Choose an App Name unique to this project. Every client that should share objects and messages "
                + "must use the same App Name.", MessageType.Info);

            _edited.AppName = EditorGUILayout.TextField("App Name: ", _edited.AppName);

            var sharedAppName = ColibriConfig.SharedAppNameWarning(_edited.AppName);
            if (sharedAppName != null)
                EditorGUILayout.HelpBox(sharedAppName, MessageType.Warning);

            _edited.ServerAddress = EditorGUILayout.TextField("Server Address: ", _edited.ServerAddress);
            GUILayout.Space(16);
            _portSettings = EditorGUILayout.Foldout(_portSettings, "Optional Config");
            if (_portSettings)
            {
                var x = EditorGUILayout.BeginVertical();
                x.position = new Vector2(5, 5);
                EditorGUILayout.HelpBox("The ports, SSL/TLS and the voice sampling rate must match the server. Change them only "
                    + "if the server does not use the defaults.", MessageType.Warning);
                _edited.IsSSL = EditorGUILayout.Toggle(new GUIContent("Server supports SSL/TLS?",
                    "The server has TLS turned on (TLS_CERT and TLS_KEY): the TCP connection is encrypted, and the Store uses https."), _edited.IsSSL);
                if (_edited.IsSSL)
                {
                    // Only meaningful with TLS, so only shown with it.
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

            // Also when nothing changed here: a change elsewhere can make a refused value valid.
            _refused = ApplyValidSettings(_edited, Config);

            var errors = ConfigurationErrors(_edited);

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

            // Outside the foldout: it is closed whenever the window opens, and this is not a
            // setting to forget about.
            if (_edited.MaxSendRate == 0)
            {
                EditorGUILayout.HelpBox("Max Send Rate is 0, so there is no limit: every moving synced object sends an update "
                    + "in every frame, 72 to 120 a second on a headset. One server and one Wi-Fi network cannot keep up "
                    + $"with dozens of clients doing that. The default is {ColibriConfig.DEFAULT_MAX_SEND_RATE}.", MessageType.Warning);
            }

            DrawAndroidIssues();

            EditorGUILayout.EndScrollView();

            EditorGUIUtility.labelWidth = labelWidth;
        }

        /// <summary>
        /// A label column wide enough for the two TLS labels, the longest ones, with their indent.
        /// Unity's default of 150 px cut them off, as "Allow self-signed certifi" and "Server
        /// certificate SHA-2". Measured rather than fixed, so it follows the editor's font.
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
        /// The settings: every public field Unity serializes, so that one added later is not left
        /// behind; not the name or the hide flags, which belong to the asset.
        /// </summary>
        private static readonly FieldInfo[] Settings = typeof(ColibriConfig)
            .GetFields(BindingFlags.Public | BindingFlags.Instance)
            .Where(field => !field.IsNotSerialized)
            .ToArray();

        /// <summary>
        /// Copies <paramref name="config"/>'s settings to <paramref name="shown"/>, but for the
        /// <paramref name="refused"/> ones, which keep the value typed in.
        /// </summary>
        /// <remarks>Internal for the EditMode tests.</remarks>
        internal static void ShowSettings(ColibriConfig config, ColibriConfig shown, ICollection<string> refused)
        {
            foreach (var setting in Settings)
                if (!refused.Contains(setting.Name))
                    setting.SetValue(shown, setting.GetValue(config));
        }

        /// <summary>
        /// Copies to <paramref name="config"/>, the configuration in use, each setting in which
        /// <paramref name="shown"/> differs from it, unless one of the checks that Save makes, and
        /// that looks at the setting, then fails. So a valid change takes effect at once, as it
        /// always has, even while another setting shows an error, and a value that Save refuses is
        /// neither used in Play mode nor written to disk by whatever saves the project's assets
        /// next. Writing the fields straight into the configuration did both, though Save was
        /// disabled. Copying only those settings leaves a change made elsewhere to any other in place.
        /// </summary>
        /// <returns>The settings it did not copy, by name.</returns>
        /// <remarks>Internal for the EditMode tests.</remarks>
        internal static List<string> ApplyValidSettings(ColibriConfig shown, ColibriConfig config)
        {
            var changed = Settings.Where(setting => !Equals(setting.GetValue(shown), setting.GetValue(config))).ToList();
            if (changed.Count == 0)
                return new List<string>();

            var candidate = CreateInstance<ColibriConfig>();
            candidate.hideFlags = HideFlags.HideAndDontSave;
            try
            {
                // Those of the settings that a failing check looks at, when they have their value
                // from shown and every other setting has config's.
                List<FieldInfo> Failing(List<FieldInfo> settings)
                {
                    foreach (var setting in Settings)
                        setting.SetValue(candidate, setting.GetValue(settings.Contains(setting) ? shown : config));
                    var looked = Checks.Where(check => check.Error(candidate) != null).SelectMany(check => check.LooksAt).ToList();
                    return settings.Where(setting => looked.Contains(setting.Name)).ToList();
                }

                // All together first, since two ports can only be swapped together, less those
                // that a failing check looks at, until the rest pass.
                var applied = changed.ToList();
                for (var failing = Failing(applied); failing.Count != 0; failing = Failing(applied))
                    applied = applied.Except(failing).ToList();

                // Then each of the others on its own, so that a refused value does not hold back a
                // valid one that shares a check with it, such as the voice port while the web port
                // has the TCP port's number.
                foreach (var setting in changed.Except(applied).ToList())
                    if (Failing(applied.Append(setting).ToList()).Count == 0)
                        applied.Add(setting);

                foreach (var setting in applied)
                    setting.SetValue(config, setting.GetValue(shown));
                return changed.Except(applied).Select(setting => setting.Name).ToList();
            }
            finally
            {
                DestroyImmediate(candidate);
            }
        }

        /// <summary>
        /// The checks that Save makes, each with the settings it looks at, and its error if it
        /// fails, or null.
        /// </summary>
        private static readonly (string[] LooksAt, Func<ColibriConfig, string> Error)[] Checks =
        {
            // The status window's test. A name of spaces only used to pass here, and the status
            // window then reported the project as not configured.
            (new[] { nameof(ColibriConfig.AppName) },
                config => config.IsConfigured ? null : "App Name must not be empty!"),
            (new[] { nameof(ColibriConfig.ServerAddress) },
                config => !config.ServerAddress.Contains("://") ? null
                    : "Server address should not contain a protocol (only IP or domain name)"),
            (new[] { nameof(ColibriConfig.WebServerPort) },
                config => IsPort(config.WebServerPort) ? null
                    : "Web server port invalid (must be a number between 1 - 65535, default 9211)"),
            (new[] { nameof(ColibriConfig.TcpServerPort) },
                config => IsPort(config.TcpServerPort) ? null
                    : "TCP server port invalid (must be a number between 1 - 65535, default 9212)"),
            (new[] { nameof(ColibriConfig.VoiceServerPort) },
                config => IsPort(config.VoiceServerPort) ? null
                    : "Voice server port invalid (must be a number between 1 - 65535, default 9213)"),
            (new[] { nameof(ColibriConfig.WebServerPort), nameof(ColibriConfig.TcpServerPort), nameof(ColibriConfig.VoiceServerPort) },
                config => new[] { config.WebServerPort, config.TcpServerPort, config.VoiceServerPort }.Distinct().Count() == 3 ? null
                    : "Two ports may not have the same value!"),
            (new[] { nameof(ColibriConfig.VoiceServerSamplingRate) },
                config => config.VoiceServerSamplingRate >= 16000 && config.VoiceServerSamplingRate <= 48000 ? null
                    : "Voice server sampling rate invalid (must be a number between 16000 - 48000, default 48000)"),
            (new[] { nameof(ColibriConfig.MaxSendRate) },
                config => config.MaxSendRate >= 0 ? null
                    : $"Max send rate invalid (updates per second per synced object; 0 = no limit, default {ColibriConfig.DEFAULT_MAX_SEND_RATE})"),
            (new[] { nameof(ColibriConfig.IsSSL), nameof(ColibriConfig.ServerCertificateSha256) }, CertificateSettingsError),
        };

        private static bool IsPort(int port) => port > 0 && port <= 65535;

        /// <summary>What keeps the configuration from being saved; empty if nothing does.</summary>
        internal static List<string> ConfigurationErrors(ColibriConfig config)
            => Checks.Select(check => check.Error(config)).Where(error => error != null).ToList();

        /// <summary>
        /// What is wrong with the certificate settings, or null. A pinned fingerprint that cannot
        /// match any certificate would have every connection rejected, so it is not saved; without
        /// TLS the settings are not used, and not checked.
        /// </summary>
        /// <remarks>Internal for the EditMode tests.</remarks>
        internal static string CertificateSettingsError(ColibriConfig config)
        {
            if (!config.IsSSL || ServerCertificatePolicy.TryNormalizeFingerprint(config.ServerCertificateSha256, out _))
                return null;

            return "Server certificate SHA-256 invalid (64 hexadecimal digits, with or without colons, as colibri-server logs it; or empty)";
        }

        /// <summary>
        /// Settings that break a build silently - see <see cref="AndroidSettingsCheck"/>.
        /// Checked against the configuration as edited here, so turning SSL on clears the HTTP one.
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
#endif
