using System.Linq;
using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Synchronization;
using UnityEditor;
using UnityEngine;

namespace HCIKonstanz.Colibri.Setup
{
    /// <summary>
    /// Shows whether the running app is connected and what is arriving, without reading the console.
    /// </summary>
    // Read-only. Never goes through WebServerConnection.Instance: SingletonBehaviour.Instance creates
    // a GameObject when none exists, and this window must not add objects to the scene.
    public class ColibriStatusWindow : EditorWindow
    {
        private const double RepaintIntervalSeconds = 0.1;

        // The server heartbeats every 100 ms, so a gap under this is just the normal sawtooth.
        private const long HeartbeatConcernMillis = 500;

        // Below this, the frame rate is what makes messages feel late: they reach user code from
        // Update, so at 20 fps up to 50 ms pass before anything acts on one.
        private const float DeliveryRateConcernFps = 20f;

        private const float LabelColumnGap = 8f;

        private Vector2 _scroll;
        private double _nextRepaint;

        // Peak-hold over one second. The raw gap is a 0-100 ms sawtooth that beats against the
        // 10 Hz repaint and reads like a countdown; the worst gap of the last second holds still.
        private long _worstRecentGap;
        private double _gapWindowEnds;

        // Fingerprint label width at the last repaint; DrawCertificate sizes from it.
        private float _fingerprintWidth;

        [MenuItem("Window/Colibri Status")]
        private static void ShowStatusWindow()
        {
            var window = GetWindow<ColibriStatusWindow>();
            window.titleContent = new GUIContent("Colibri Status", EditorGUIUtility.IconContent("d_UnityEditor.ConsoleWindow").image);
            window.minSize = new Vector2(360, 320);
            window.Show();
        }

        private void OnEnable() => EditorApplication.update += OnEditorUpdate;
        private void OnDisable() => EditorApplication.update -= OnEditorUpdate;

        private void OnEditorUpdate()
        {
            // Only in Play mode, and ten times a second: nothing changes in edit mode, and repainting
            // on every editor tick would show up in the editor's own profile.
            if (!EditorApplication.isPlaying || EditorApplication.timeSinceStartup < _nextRepaint)
                return;

            _nextRepaint = EditorApplication.timeSinceStartup + RepaintIntervalSeconds;
            Repaint();
        }

        private void OnGUI()
        {
            _scroll = EditorGUILayout.BeginScrollView(_scroll);

            DrawConfiguration();
            EditorGUILayout.Space();
            DrawConnection();
            EditorGUILayout.Space();
            DrawChannels();
            EditorGUILayout.Space();
            DrawTraffic();
            EditorGUILayout.Space();
            DrawButtons();

            EditorGUILayout.EndScrollView();
        }

        private void DrawConfiguration()
        {
            var config = ColibriConfig.Load();

            EditorGUILayout.LabelField("Configuration", EditorStyles.boldLabel);
            if (!config.IsConfigured)
                EditorGUILayout.HelpBox(ColibriConfig.NOT_CONFIGURED_MESSAGE, MessageType.Error);

            Row("App Name", string.IsNullOrEmpty(config.AppName) ? "(not set)" : config.AppName);
            Row("Server", $"{config.ServerAddress}  (tcp {config.TcpServerPort}, web {config.WebServerPort}{(config.IsSSL ? ", TLS" : "")})");
        }

        private void DrawConnection()
        {
            EditorGUILayout.LabelField("Connection", EditorStyles.boldLabel);

            if (!EditorApplication.isPlaying)
            {
                EditorGUILayout.HelpBox("Colibri only connects while the game is running. Press Play to see the connection.", MessageType.Info);
                return;
            }

            // Not Instance: it would create the object when the scene has none.
            var connection = FindAnyObjectByType<WebServerConnection>();
            if (connection == null)
            {
                EditorGUILayout.HelpBox("No Colibri connection in the scene yet. It is created automatically the first time something calls Sync.Send, Sync.Receive, or a SyncBehaviour wakes up.", MessageType.Info);
                return;
            }

            var status = connection.Status;
            var previous = GUI.contentColor;
            GUI.contentColor = StatusColor(status);
            Row("Status", status.ToString());
            GUI.contentColor = previous;

            Row("Server", $"{connection.ServerAddress}:{connection.TcpPort}{(connection.UsesTls ? "  TLS" : "")}");
            Row("App Name", string.IsNullOrEmpty(connection.AppName) ? "(not set)" : connection.AppName);
            Row("Protocol", status == ConnectionStatus.ProtocolMismatch
                ? $"v{WebServerConnection.ClientVersion} (binary TCP), server speaks v{connection.ServerVersion ?? "unknown"}"
                : $"v{WebServerConnection.ClientVersion} (binary TCP)");

            if (status == ConnectionStatus.ProtocolMismatch)
            {
                // Terminal. The usual "is the server running?" advice is wrong here: it is running,
                // and it said no.
                EditorGUILayout.HelpBox(
                    $"The server refused this client: {connection.ProtocolMismatchReason}\n\n" +
                    "This is not retried. Update colibri-unity and colibri-server to matching versions.",
                    MessageType.Error);
                return;
            }

            if (status == ConnectionStatus.Connected)
            {
                // Not latency: the heartbeat carries the server's clock, so no round trip can be
                // derived from it. It does show whether the server is still talking to us.
                var gap = TrackHeartbeatGap(connection.MillisSinceLastHeartbeat());
                Row("Heartbeat",
                    gap < HeartbeatConcernMillis
                        ? "OK"
                        : $"missing for {gap / 1000f:0.0} s, about to drop the connection");

                DrawCertificate(connection);
                DrawDeliveryRate(connection);
            }
            else if (!string.IsNullOrEmpty(connection.SuspectedProtocolMismatch))
            {
                // Something answers on that port but does not speak this protocol, so "check that
                // colibri-server is running" is the wrong advice.
                EditorGUILayout.HelpBox(
                    $"{connection.SuspectedProtocolMismatch}\n\n" +
                    "Still retrying, because this cannot tell an out-of-date server apart from an address that points at something other than colibri-server.",
                    MessageType.Warning);
            }
            else
            {
                // A timeout and a refusal need different fixes, so the last failure is shown here
                // rather than left to the console.
                var failure = connection.LastConnectFailure;
                EditorGUILayout.HelpBox(
                    "Not connected. Check that colibri-server is running and that the server address above is reachable."
                    + (failure == null ? "" : $"\n\nLast attempt: {failure}."),
                    MessageType.Warning);
            }
        }

        private void DrawCertificate(WebServerConnection connection)
        {
            if (!connection.UsesTls || connection.CertificateAcceptance == null)
                return;

            Row("Certificate", connection.CertificateAcceptance);

            // The layout needs a selectable label's height before it hands out widths, so the height
            // comes from the width at the last repaint, and is estimated only before the first one.
            // The fingerprint has no spaces, so it breaks between characters.
            var fingerprint = connection.ServerCertificateSha256 ?? "";
            var width = _fingerprintWidth > 0f
                ? _fingerprintWidth
                : EditorGUIUtility.currentViewWidth - EditorGUIUtility.labelWidth - 40f;
            var height = Mathf.Max(EditorGUIUtility.singleLineHeight,
                EditorStyles.wordWrappedLabel.CalcHeight(new GUIContent(fingerprint), width));

            EditorGUILayout.BeginHorizontal();
            EditorGUILayout.PrefixLabel("SHA-256");
            // Selectable, so the fingerprint can be copied into "Server certificate SHA-256".
            EditorGUILayout.SelectableLabel(fingerprint, EditorStyles.wordWrappedLabel, GUILayout.Height(height));

            // Only a repaint knows the real width. Repaint again when it changes, so a resize is off
            // for one frame at most.
            if (Event.current.type == EventType.Repaint)
            {
                var laidOut = GUILayoutUtility.GetLastRect().width;
                if (!Mathf.Approximately(laidOut, _fingerprintWidth))
                {
                    _fingerprintWidth = laidOut;
                    Repaint();
                }
            }

            EditorGUILayout.EndHorizontal();
        }

        // The socket runs off the main thread, so the delay left is this client's own frame time.
        // A background Editor at 4 fps looks exactly like a slow server, and the fix is local.
        private void DrawDeliveryRate(WebServerConnection connection)
        {
            var fps = connection.DeliveryFramesPerSecond;
            if (fps <= 0f)
                return;

            var delayMillis = 1000f / fps;

            Row("Delivery", $"{fps:0} fps  (up to {delayMillis:0} ms per message)");

            if (fps < DeliveryRateConcernFps)
            {
                EditorGUILayout.HelpBox(
                    $"Messages are only handed to your code once per frame, and this client is "
                    + $"running at {fps:0} fps, so anything arriving waits up to {delayMillis:0} ms "
                    + "before it is applied. This is local, not the network. An Editor window in "
                    + "the background is the usual reason: Unity throttles it. Enable "
                    + "Edit > Project Settings > Player > Run In Background, and click the "
                    + "unfocused editor's Game view to confirm the number recovers.",
                    MessageType.Warning);
            }
        }

        // Returns the worst gap of the last second, so the reading holds still enough to be read.
        private long TrackHeartbeatGap(long currentGap)
        {
            if (currentGap > _worstRecentGap)
                _worstRecentGap = currentGap;

            if (EditorApplication.timeSinceStartup >= _gapWindowEnds)
            {
                _gapWindowEnds = EditorApplication.timeSinceStartup + 1.0;
                var held = _worstRecentGap;
                _worstRecentGap = currentGap;
                return held;
            }

            return _worstRecentGap;
        }

        private void DrawChannels()
        {
            EditorGUILayout.LabelField("Channels with listeners", EditorStyles.boldLabel);

            var channels = ChannelListenerRegistry.Channels.OrderBy(c => c).ToArray();
            if (channels.Length == 0)
            {
                EditorGUILayout.LabelField("(none registered)");
                return;
            }

            var labelWidth = WidenLabelColumn(channels);
            foreach (var channel in channels)
                Row(channel, string.Join(", ", ChannelListenerRegistry.ListenerTypesFor(channel)));
            EditorGUIUtility.labelWidth = labelWidth;

            EditorGUILayout.HelpBox("A message is only delivered when the channel *and* the type match.", MessageType.None);
        }

        private void DrawTraffic()
        {
            EditorGUILayout.LabelField("Recent messages", EditorStyles.boldLabel);

            // With domain reload disabled, entries outlive Play mode. Their ages would keep counting
            // against a clock that never stops, which reads as live traffic.
            if (!EditorApplication.isPlaying)
            {
                EditorGUILayout.LabelField("(nothing sent or received yet)");
                return;
            }

            var traffic = Sync.RecentTraffic.ToArray();
            if (traffic.Length == 0)
            {
                EditorGUILayout.LabelField("(nothing sent or received yet)");
                return;
            }

            var now = Time.realtimeSinceStartup;
            var labels = traffic.Select(entry => $"{(entry.Incoming ? "in " : "out")}  {entry.Channel}").ToArray();
            var labelWidth = WidenLabelColumn(labels);
            for (var i = 0; i < traffic.Length; i++)
                Row(labels[i], $"{traffic[i].Command}   {now - traffic[i].Time:0.0}s ago");
            EditorGUIUtility.labelWidth = labelWidth;
        }

        private static void Row(string label, string value)
            => EditorGUILayout.LabelField(label, value, EditorStyles.wordWrappedLabel);

        // Widens the label column to fit the widest label, up to half the window, for the rows
        // drawn after it. The caller puts back the returned width.
        private static float WidenLabelColumn(string[] labels)
        {
            var previous = EditorGUIUtility.labelWidth;
            var widest = labels.Select(label => EditorStyles.label.CalcSize(new GUIContent(label)).x).DefaultIfEmpty(0f).Max();
            EditorGUIUtility.labelWidth = Mathf.Clamp(widest + LabelColumnGap, previous, EditorGUIUtility.currentViewWidth / 2f);
            return previous;
        }

        private void DrawButtons()
        {
            EditorGUILayout.BeginHorizontal();

            if (GUILayout.Button("Colibri Configuration"))
                EditorApplication.ExecuteMenuItem("Window/Colibri Configuration");

            if (GUILayout.Button("Open Server Web UI"))
                Application.OpenURL(ColibriConfig.GetWebUrl(""));

            EditorGUILayout.EndHorizontal();
        }

        private static Color StatusColor(ConnectionStatus status)
        {
            switch (status)
            {
                case ConnectionStatus.Connected: return new Color(0.3f, 0.8f, 0.3f);
                case ConnectionStatus.Connecting:
                case ConnectionStatus.Reconnecting: return new Color(0.9f, 0.7f, 0.2f);
                default: return new Color(0.9f, 0.4f, 0.4f);
            }
        }
    }
}
