using HCIKonstanz.Colibri.Setup;

namespace HCIKonstanz.Colibri.Networking
{
    internal sealed class ConnectionConfig
    {
        internal static readonly ConnectionConfig Empty = new ConnectionConfig(null, null, 0, false, false, null);

        private ConnectionConfig(string serverAddress, string appName, int tcpPort, bool useTls,
            bool allowSelfSignedCertificate, string serverCertificateSha256)
        {
            ServerAddress = serverAddress;
            AppName = appName;
            TcpPort = tcpPort;
            UseTls = useTls;
            AllowSelfSignedCertificate = allowSelfSignedCertificate;
            ServerCertificateSha256 = serverCertificateSha256;
        }

        internal string ServerAddress { get; }
        internal string AppName { get; }
        internal int TcpPort { get; }
        internal bool UseTls { get; }
        internal bool AllowSelfSignedCertificate { get; }
        internal string ServerCertificateSha256 { get; }

        internal ConnectionConfig Refreshed(ColibriConfig config)
        {
            var serverAddress = config.Host;
            var appName = config.App;
            var tcpPort = config.TcpServerPort;
            var useTls = config.IsSSL;
            var allowSelfSignedCertificate = config.AllowSelfSignedCertificate;
            var serverCertificateSha256 = config.ServerCertificateSha256;

            if (serverAddress == ServerAddress && appName == AppName && tcpPort == TcpPort && useTls == UseTls
                && allowSelfSignedCertificate == AllowSelfSignedCertificate && serverCertificateSha256 == ServerCertificateSha256)
                return this;

            return new ConnectionConfig(serverAddress, appName, tcpPort, useTls, allowSelfSignedCertificate, serverCertificateSha256);
        }
    }
}
