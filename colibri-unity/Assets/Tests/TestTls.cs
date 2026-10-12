using System;
using System.IO;
using System.Net.Security;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Threading.Tasks;

namespace HCIKonstanz.Colibri.E2E
{
    /// <summary>
    /// TLS for the test's own endpoints: <see cref="FakeColibriServer"/> and <see cref="TcpProxy"/>
    /// serve it with the TLS test server's certificate, and <see cref="TcpPeer"/> and the proxy
    /// speak it to colibri-server. Only the Unity client checks certificates; these accept any.
    /// </summary>
    public static class TestTls
    {
        private const string Password = "colibri-test";

        private static X509Certificate2 _certificate;

        /// <summary>
        /// The certificate the test's own servers present, with its key: the TLS test server's,
        /// from <see cref="E2EServer.TlsCertificatePfxPath"/>. Loaded once.
        /// </summary>
        public static X509Certificate2 Certificate
        {
            get
            {
                if (_certificate != null)
                    return _certificate;

                var path = E2EServer.TlsCertificatePfxPath;
                if (!File.Exists(path))
                {
                    throw new FileNotFoundException(
                        $"The certificate the test's own TLS servers present is not at {path}; set COLIBRI_E2E_TLS_PFX.", path);
                }

                _certificate = new X509Certificate2(File.ReadAllBytes(path), Password);
                return _certificate;
            }
        }

        /// <summary>
        /// The SHA-256 fingerprint of <see cref="Certificate"/>, as a pin: worked out here rather
        /// than by the code under test, like <see cref="E2EServer.TlsCertificateSha256"/>.
        /// </summary>
        public static string CertificateSha256
        {
            get
            {
                using (var sha256 = SHA256.Create())
                    return BitConverter.ToString(sha256.ComputeHash(Certificate.GetRawCertData())).Replace("-", "").ToLowerInvariant();
            }
        }

        /// <summary>The server's side of a TLS handshake over <paramref name="inner"/>, with <see cref="Certificate"/>.</summary>
        public static async Task<Stream> AcceptAsync(Stream inner)
        {
            var tls = new SslStream(inner, false);
            try
            {
                // TLS 1.2 is what Unity's TLS backend speaks, and what every client here can.
                await tls.AuthenticateAsServerAsync(Certificate, false, SslProtocols.Tls12, false).ConfigureAwait(false);
                return tls;
            }
            catch (Exception)
            {
                tls.Dispose();
                throw;
            }
        }

        /// <summary>The client's side of a TLS handshake over <paramref name="inner"/>, accepting any certificate.</summary>
        public static async Task<Stream> ConnectAsync(Stream inner, string host)
        {
            var tls = new SslStream(inner, false, (sender, certificate, chain, errors) => true);
            try
            {
                await tls.AuthenticateAsClientAsync(host).ConfigureAwait(false);
                return tls;
            }
            catch (Exception)
            {
                tls.Dispose();
                throw;
            }
        }
    }
}
