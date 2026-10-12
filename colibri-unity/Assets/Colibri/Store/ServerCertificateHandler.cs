using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Setup;
using UnityEngine.Networking;

namespace HCIKonstanz.Colibri.Store
{
    /// <summary>
    /// Checks the web server's certificate for the Store's https requests the way the TCP
    /// connection checks it, so that a server with a self-signed certificate works for both: with
    /// <see cref="ColibriConfig.AllowSelfSignedCertificate"/> any certificate is accepted, and with
    /// <see cref="ColibriConfig.ServerCertificateSha256"/> only the pinned one. Without either the
    /// request has no handler and the system checks the certificate, as it always did.
    /// </summary>
    /// <remarks>
    /// UnityWebRequest hands a certificate handler the certificate and nothing else, not the
    /// system's verdict on it; see <see cref="ServerCertificatePolicy.AcceptsWithoutSystemCheck"/>.
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

        /// <summary>The handler for a request to the server <paramref name="config"/> names, or null for the system's own check.</summary>
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
