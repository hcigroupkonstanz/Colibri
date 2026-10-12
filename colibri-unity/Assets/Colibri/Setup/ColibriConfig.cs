using UnityEngine;

namespace HCIKonstanz.Colibri.Setup
{
    public class ColibriConfig : ScriptableObject
    {
        public static readonly string CONFIG_NAME = "ColibriConfig.asset";

        /// <summary>
        /// What to tell someone whose project has no configuration asset yet. Kept here so the
        /// connection loop, the Store and the status window all say exactly the same thing.
        /// </summary>
        public static readonly string NOT_CONFIGURED_MESSAGE =
            "Colibri is not configured yet. Open Window -> Colibri Configuration, enter an App Name, and press Save Config. " +
            "(Every client that should see each other has to use the same App Name.)";

        private static ColibriConfig _instance;
        private static ColibriConfig _defaults;

        /// <summary>
        /// The project's configuration. Never null: without a configuration asset this hands back
        /// the defaults, so a missing asset surfaces as one clear message from the connection loop
        /// rather than as a NullReferenceException from whichever call site touched it first.
        /// </summary>
        public static ColibriConfig Load()
        {
            if (_instance)
                return _instance;

            // Kept out of _instance so that the asset is picked up the moment it appears - which,
            // in the editor, is as soon as the setup window saves it.
            _instance = Resources.Load<ColibriConfig>("ColibriConfig");
            if (_instance)
                return _instance;

            // Created once, not per call: the connection loop calls Load() every frame, and a
            // ScriptableObject per frame would leak - CreateInstance is not garbage collected.
            if (!_defaults)
            {
                _defaults = CreateInstance<ColibriConfig>();
                _defaults.hideFlags = HideFlags.HideAndDontSave;
            }

            return _defaults;
        }

        /// <summary>
        /// A configuration is only usable with an app name: the server routes messages by it, so
        /// an empty one silently isolates the client from every other client.
        /// </summary>
        public bool IsConfigured => !string.IsNullOrWhiteSpace(AppName);

        /// <summary>
        /// App names that many people end up with: example and placeholder names - colibri-web's
        /// samples use "myAppName" - and what anyone types first. Lowercase; compared without
        /// regard to case.
        /// </summary>
        private static readonly string[] CommonAppNames =
        {
            "myappname", "myapp", "appname", "app", "test", "testapp", "demo", "example", "colibri", "default"
        };

        /// <summary>
        /// Why <paramref name="appName"/> is likely to be shared with strangers, or null if it is
        /// not. An empty name is not this method's concern - see <see cref="IsConfigured"/>.
        /// </summary>
        /// <remarks>
        /// The server puts every client with the same app name into one app, whoever they are. So
        /// unrelated projects that settle on the same example name see each other's objects and
        /// messages, and since each update goes to every other client in the app, the server's
        /// work grows with the square of the number of clients in it. Nothing says so at runtime:
        /// it just works, for everyone at once.
        /// </remarks>
        internal static string SharedAppNameWarning(string appName)
        {
            if (string.IsNullOrWhiteSpace(appName))
                return null;

            var name = appName.Trim();
            if (System.Array.IndexOf(CommonAppNames, name.ToLowerInvariant()) < 0)
                return null;

            return $"'{name}' is a generic App Name that other people are likely to pick too. "
                + "Everyone on this server who uses the same App Name is in one app: they all see each other's objects and messages, "
                + "and the server's work grows with the square of their number. Choose a name that is unique to this project or deployment.";
        }

        public string AppName = "";
        public string ServerAddress = "colibri.hci.uni-konstanz.de";

        // colibri-server 2.x's default ports. 1.x's were 9011, 9012 and 9013: the defaults differ so
        // that a client of one version does not reach a server of the other by them. A configuration
        // saved by 1.x keeps the ports it saved; only a new one starts out with these.
        public int WebServerPort = 9211;
        public int TcpServerPort = 9212;
        public int VoiceServerPort = 9213;

        /// <summary>
        /// The server has TLS turned on (<c>TLS_CERT</c> and <c>TLS_KEY</c> at colibri-server): the
        /// TCP connection is encrypted, and the Store uses https. By default the server's certificate
        /// has to be one this device trusts, issued for <see cref="ServerAddress"/>; see
        /// <see cref="AllowSelfSignedCertificate"/> and <see cref="ServerCertificateSha256"/> for a
        /// self-signed one.
        /// </summary>
        public bool IsSSL = false;

        /// <summary>
        /// With <see cref="IsSSL"/>: also accept a server certificate this device does not trust,
        /// such as a self-signed one, or one issued for another name. The connection is still
        /// encrypted, but nothing checks that it goes to the right server; the first connection
        /// says so once in the log, with the certificate's fingerprint for
        /// <see cref="ServerCertificateSha256"/>.
        /// </summary>
        /// <remarks>
        /// Off in a configuration saved before this field existed: Unity leaves a field the asset
        /// has no value for at its initializer.
        /// </remarks>
        public bool AllowSelfSignedCertificate = false;

        /// <summary>
        /// With <see cref="IsSSL"/>: the SHA-256 fingerprint of the one server certificate to
        /// accept, as colibri-server logs it when it starts. When set, that certificate is accepted
        /// whether this device trusts it or not, and every other certificate is rejected, trusted or
        /// not. Upper or lower case, with or without colons. Empty for no pin, which is the default.
        /// </summary>
        /// <remarks>
        /// Meant for a self-signed certificate, which stays the same until it is replaced. A
        /// certificate from Let's Encrypt changes with every renewal, so pinning one rejects the
        /// server after its next renewal; leave this empty for those.
        /// </remarks>
        public string ServerCertificateSha256 = "";

        public int VoiceServerSamplingRate = 48000;

        /// <summary>The value <see cref="MaxSendRate"/> starts out with.</summary>
        public const int DEFAULT_MAX_SEND_RATE = 30;

        /// <summary>
        /// The most updates per second one synced object sends, 0 for no limit. What
        /// <c>SyncSettings.MaxSendRate</c> starts out as - see there for what the limit does.
        /// </summary>
        /// <remarks>
        /// A configuration asset saved before this field existed has no value for it, and Unity
        /// leaves such a field at its initializer. So existing projects get the default without
        /// saving their configuration again.
        ///
        /// [Min] keeps the asset's own Inspector from taking a negative value; one that gets in
        /// anyway, by a hand edit, is reported and replaced with the default at runtime.
        /// </remarks>
        [Min(0)]
        public int MaxSendRate = DEFAULT_MAX_SEND_RATE;

        /// <summary>
        /// Generates a URL for the WebRequest
        /// </summary>
        /// <param name="endpoint">Server Endpoint. Not leading slash (/) required</param>
        /// <returns></returns>
        public static string GetWebUrl(string endpoint)
        {
            var config = Load();
            var protocol = config.IsSSL ? "https" : "http";
            endpoint = endpoint.TrimStart('/'); // remove leading slash

            var uri = $"{protocol}://{UrlHost(config.ServerAddress)}:{config.WebServerPort}/{endpoint}";
            return uri;
        }

        /// <summary>
        /// The server address as the host of a URL: an IPv6 address goes in brackets there, so
        /// that its colons are not read as the port's. One typed with brackets keeps them. A host
        /// name never contains a colon, so a colon means an IPv6 address.
        /// </summary>
        /// <remarks>Internal for the EditMode tests.</remarks>
        internal static string UrlHost(string serverAddress)
            => serverAddress.IndexOf(':') >= 0 && !serverAddress.StartsWith("[") ? $"[{serverAddress}]" : serverAddress;
    }
}
