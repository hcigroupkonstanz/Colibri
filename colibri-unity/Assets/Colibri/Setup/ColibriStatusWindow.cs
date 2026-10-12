#if UNITY_EDITOR
using System.Linq;
using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Synchronization;
using UnityEditor;
using UnityEngine;

namespace HCIKonstanz.Colibri.Setup
{
    /// <summary>
    /// "Am I actually connected, and is anything arriving?" answered without reading the console.
    ///
    /// Everything here is read-only observation of the running app: the window never creates or
    /// touches scene objects, and in particular never goes through WebServerConnection.Instance,
    /// because SingletonBehaviour.Instance *creates* a GameObject when none exists - which outside
    /// Play mode would mean an editor window quietly adding an object to the open scene.
    /// </summary>
    public class ColibriStatusWindow : EditorWindow
    {
        private const double RepaintIntervalSeconds = 0.1;

        /// <summary>
        /// How long a gap has to be before it is worth showing a number for. The server
        /// heartbeats every 100 ms, so anything under this is just the normal sawtooth.
        /// </summary>
        private const long HeartbeatConcernMillis = 500;

        /// <summary>
        /// Below this, the frame rate is the reason messages feel late. Received messages are
        /// handed to user code from <c>Update</c>, so 20 fps already puts up to 50 ms between a
        /// message arriving on the socket and anything acting on it - and an Editor left in the
        /// background falls a long way below that.
        /// </summary>
        private const float DeliveryRateConcernFps = 20f;

        /// <summary>Between the widest label and the value next to it.</summary>
        private const float LabelColumnGap = 8f;

        private Vector2 _scroll;
        private double _nextRepaint;

        // Peak-hold over one second. Showing MillisSinceLastHeartbeat() raw meant sampling a
        // 0-100 ms sawtooth at the same 10 Hz this window repaints at, which beats against it
        // and reads like a number counting down - alarming, and impossible to read anything
        // out of. The worst gap in the last second is both steady and the figure that
        // actually matters.
        private long _worstRecentGap;
        private double _gapWindowEnds;

        // The width the certificate's fingerprint had in the last repaint; see DrawCertificate.
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
            // Only while playing, and only ten times a second: nothing here changes in edit mode,
            // and repainting on every editor tick would show up in the editor's own profile.
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

            // Never WebServerConnection.Instance - see the class comment.
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
                // Terminal, and the one connection state the usual "is the server running?"
                // advice is actively wrong for - the server is running, and it said no.
                EditorGUILayout.HelpBox(
                    $"The server refused this client: {connection.ProtocolMismatchReason}\n\n" +
                    "This is not retried. Update colibri-unity and colibri-server to matching versions.",
                    MessageType.Error);
                return;
            }

            if (status == ConnectionStatus.Connected)
            {
                // Not a latency: the heartbeat carries the server's clock, so no round trip can be
                // derived from it. It does say whether the server is still talking to us.
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
                // "Check that colibri-server is running" is the wrong advice here: something is
                // answering on that port, it just is not speaking this protocol.
                EditorGUILayout.HelpBox(
                    $"{connection.SuspectedProtocolMismatch}\n\n" +
                    "Still retrying, because this cannot tell an out-of-date server apart from an address that points at something other than colibri-server.",
                    MessageType.Warning);
            }
            else
            {
                // A timeout and a refusal want different fixes - the address or the network, against
                // the server or its port - so the last one is shown rather than left to the console.
                var failure = connection.LastConnectFailure;
                EditorGUILayout.HelpBox(
                    "Not connected. Check that colibri-server is running and that the server address above is reachable."
                    + (failure == null ? "" : $"\n\nLast attempt: {failure}."),
                    MessageType.Warning);
            }
        }

        /// <summary>
        /// How the server's certificate was accepted, and its fingerprint, selectable so that it
        /// can be copied into "Server certificate SHA-256" to accept only this certificate.
        /// </summary>
        /// <remarks>
        /// Both wrap: on one line, they ran past the edge of the window at its default width and
        /// were cut off.
        /// </remarks>
        private void DrawCertificate(WebServerConnection connection)
        {
            if (!connection.UsesTls || connection.CertificateAcceptance == null)
                return;

            Row("Certificate", connection.CertificateAcceptance);

            // A selectable label takes the height it is given, and the layout needs that height
            // before it hands out widths. So it is worked out for the width the fingerprint had in
            // the last repaint, and only estimated before the first one: an estimate below the
            // real width reserved a second, empty line in a wide window. The fingerprint has no
            // spaces: it breaks between characters.
            var fingerprint = connection.ServerCertificateSha256 ?? "";
            var width = _fingerprintWidth > 0f
                ? _fingerprintWidth
                : EditorGUIUtility.currentViewWidth - EditorGUIUtility.labelWidth - 40f;
            var height = Mathf.Max(EditorGUIUtility.singleLineHeight,
                EditorStyles.wordWrappedLabel.CalcHeight(new GUIContent(fingerprint), width));

            EditorGUILayout.BeginHorizontal();
            EditorGUILayout.PrefixLabel("SHA-256");
            EditorGUILayout.SelectableLabel(fingerprint, EditorStyles.wordWrappedLabel, GUILayout.Height(height));

            // Only a repaint has the real width. Laid out again at once when it changed, so a new
            // window or a resize shows the wrong height for a single frame at most.
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

        /// <summary>
        /// The socket runs off the main thread, so what is left between a message arriving and
        /// user code seeing it is one frame of this client's own. That is worth stating outright:
        /// a background Editor delivering at 4 fps looks exactly like a slow server otherwise,
        /// and the fix is on this side of the wire.
        /// </summary>
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

        /// <returns>The worst gap seen in the last second, so the reading holds still long
        /// enough to be read.</returns>
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

            // Entries outlive Play mode when domain reload is disabled. Showing the last
            // session's messages here, with ages still counting up against a clock that never
            // stops, reads as if something were still being sent.
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

        /// <summary>
        /// A label and its value, the value wrapped to the window's width. On one line, a value
        /// longer than the space next to the label column was cut off at the window's edge.
        /// </summary>
        private static void Row(string label, string value)
            => EditorGUILayout.LabelField(label, value, EditorStyles.wordWrappedLabel);

        /// <summary>
        /// Widens the label column to fit the widest of <paramref name="labels"/>, up to half the
        /// window, for the rows drawn until it is put back. At the default width a long channel
        /// name ran into the value next to it.
        /// </summary>
        /// <returns>The width to put back.</returns>
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
#endif
