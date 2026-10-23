using UnityEngine;

namespace HCIKonstanz.Colibri.Setup
{
    public class ColibriConfig : ScriptableObject
    {
        public static readonly string CONFIG_NAME = "ColibriConfig.asset";

        /// <summary>
        /// The message for a project without a configuration asset, shown by the connection loop,
        /// the voice connection and the status window.
        /// </summary>
        public static readonly string NOT_CONFIGURED_MESSAGE =
            "Colibri is not configured yet. Open Window -> Colibri Configuration, enter an App Name, and press Save Config. " +
            "(Every client that should see each other has to use the same App Name.)";

        private static ColibriConfig _instance;
        private static ColibriConfig _defaults;

        /// <summary>
        /// The project's configuration, never null. Without an asset this returns the defaults, so
        /// the connection loop reports the missing asset instead of a NullReferenceException.
        /// </summary>
        public static ColibriConfig Load()
        {
            if (_instance)
                return _instance;

            // Defaults are not cached here, so an asset saved in the setup window is picked up on the next call.
            _instance = Resources.Load<ColibriConfig>("ColibriConfig");
            if (_instance)
                return _instance;

            // Created once: Load() runs every frame, and CreateInstance objects are not garbage collected.
            if (!_defaults)
            {
                _defaults = CreateInstance<ColibriConfig>();
                _defaults.hideFlags = HideFlags.HideAndDontSave;
            }

            return _defaults;
        }

        /// <summary>
        /// True when an App Name is set. Without one the client does not connect.
        /// </summary>
        public bool IsConfigured => !string.IsNullOrWhiteSpace(AppName);

        // Example and placeholder names, in lowercase. colibri-web's samples use "myAppName".
        private static readonly string[] _commonAppNames =
        {
            "myappname", "myapp", "appname", "app", "test", "testapp", "demo", "example", "colibri", "default"
        };

        /// <summary>
        /// Returns a warning when <paramref name="appName"/> is one that other projects are likely
        /// to pick too, or null.
        /// </summary>
        // Every client with the same App Name shares one app on the server, so unrelated projects on a
        // generic name see each other's objects, and the server's work grows with the square of the client count.
        internal static string SharedAppNameWarning(string appName)
        {
            if (string.IsNullOrWhiteSpace(appName))
                return null;

            var name = appName.Trim();
            if (System.Array.IndexOf(_commonAppNames, name.ToLowerInvariant()) < 0)
                return null;

            return $"'{name}' is a generic App Name that other people are likely to pick too. "
                + "Everyone on this server who uses the same App Name is in one app: they all see each other's objects and messages, "
                + "and the server's work grows with the square of their number. Choose a name that is unique to this project or deployment.";
        }

        public string AppName = "";
        public string ServerAddress = "colibri.hci.uni-konstanz.de";

        // Trimmed: a stray space breaks DNS resolution of the address, or puts the client in an app of its own.
        internal string App => (AppName ?? "").Trim();
        internal string Host => (ServerAddress ?? "").Trim();

        /// <summary>The message for an empty server address.</summary>
        public static readonly string NO_SERVER_ADDRESS_MESSAGE =
            "Colibri has no server address. Open Window -> Colibri Configuration, enter the Server Address, and press Save Config.";

        // colibri-server 2.x's ports. 1.x used 9011 to 9013, so a client of one version does not reach
        // a server of the other by default. A configuration saved earlier keeps its ports.
        public int WebServerPort = 9211;
        public int TcpServerPort = 9212;
        public int VoiceServerPort = 9213;

        /// <summary>
        /// Connects with TLS: the TCP connection is encrypted, and the Store uses https.
        /// </summary>
        /// <remarks>
        /// The server needs <c>TLS_CERT</c> and <c>TLS_KEY</c> set. Its certificate must be one this
        /// device trusts and that is issued for <see cref="ServerAddress"/>, unless
        /// <see cref="AllowSelfSignedCertificate"/> or <see cref="ServerCertificateSha256"/> is set.
        /// </remarks>
        public bool IsSSL = false;

        /// <summary>
        /// With <see cref="IsSSL"/>, also accepts a server certificate this device does not trust,
        /// such as a self-signed one, or one issued for another name.
        /// </summary>
        /// <remarks>
        /// The connection stays encrypted, but nothing checks that it reaches the right server. The
        /// warning logged when such a certificate is accepted includes its fingerprint, for
        /// <see cref="ServerCertificateSha256"/>.
        /// </remarks>
        public bool AllowSelfSignedCertificate = false;

        /// <summary>
        /// With <see cref="IsSSL"/>, the SHA-256 fingerprint of the one certificate to accept: it is
        /// accepted whether this device trusts it or not, and every other certificate is rejected.
        /// </summary>
        /// <remarks>
        /// colibri-server logs its fingerprint at startup. Upper or lower case, with or without colons.
        /// Empty for no pin, the default. Meant for a self-signed certificate, which stays the same until
        /// it is replaced. A Let's Encrypt certificate changes with every renewal, so leave this empty for those.
        /// </remarks>
        public string ServerCertificateSha256 = "";

        public int VoiceServerSamplingRate = 48000;

        /// <summary>The value <see cref="MaxSendRate"/> starts out with.</summary>
        public const int DEFAULT_MAX_SEND_RATE = 30;

        /// <summary>
        /// The most updates per second one synced object sends, 0 for no limit. <c>SyncSettings.MaxSendRate</c>
        /// starts out as this value.
        /// </summary>
        // [Min] keeps the Inspector from entering a negative value. A hand edit that gets one in is reported
        // and replaced with the default at runtime.
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

            var uri = $"{protocol}://{UrlHost(config.Host)}:{config.WebServerPort}/{endpoint}";
            return uri;
        }

        /// <summary>
        /// The server address as the host of a URL, with an IPv6 address in brackets so its colons
        /// are not read as the port.
        /// </summary>
        // A host name has no colon, so a colon means IPv6. An address typed with brackets already has them.
        internal static string UrlHost(string serverAddress)
            => serverAddress.IndexOf(':') >= 0 && !serverAddress.StartsWith("[") ? $"[{serverAddress}]" : serverAddress;
    }
}
