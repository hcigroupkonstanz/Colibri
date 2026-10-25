using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Setup;
using UnityEngine.Networking;

namespace HCIKonstanz.Colibri.Store
{
    /// <summary>
    /// The TCP connection's certificate rules for the Store's https requests, so one server setup
    /// works for both.
    /// </summary>
    /// <remarks>
    /// UnityWebRequest passes the certificate but not the system's verdict, so the handler treats
    /// the system as having rejected it. Only <see cref="ColibriConfig.ServerCertificateSha256"/>
    /// or <see cref="ColibriConfig.AllowSelfSignedCertificate"/> can accept it then.
    /// </remarks>
    internal sealed class ServerCertificateHandler : CertificateHandler
    {
        private readonly bool _allowSelfSigned;
        private readonly string _pin;

        private ServerCertificateHandler(bool allowSelfSigned, string pin)
        {
            _allowSelfSigned = allowSelfSigned;
            _pin = pin;
        }

        /// <summary>The handler for the server in <paramref name="config"/>, or null when the system's own check applies.</summary>
        internal static ServerCertificateHandler For(ColibriConfig config)
        {
            if (!config.IsSSL || !ServerCertificatePolicy.HasOwnRules(config.AllowSelfSignedCertificate, config.ServerCertificateSha256))
                return null;

            return new ServerCertificateHandler(config.AllowSelfSignedCertificate, config.ServerCertificateSha256);
        }

        /// <param name="certificateData">The server's certificate, DER-encoded.</param>
        internal bool Accepts(byte[] certificateData)
            => certificateData != null && certificateData.Length > 0
                && ServerCertificatePolicy.AcceptsWithoutSystemCheck(ServerCertificatePolicy.Fingerprint(certificateData), _allowSelfSigned, _pin);

        protected override bool ValidateCertificate(byte[] certificateData) => Accepts(certificateData);
    }
}
