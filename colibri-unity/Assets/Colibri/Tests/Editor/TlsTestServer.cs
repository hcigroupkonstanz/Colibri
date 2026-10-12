using System;
using System.IO;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// A TLS server in the test process, for what only a real handshake shows about the client:
    /// which name it checks the server's certificate against, and which name it asks the server
    /// for (SNI). It accepts one connection, answers its handshake with the certificate it was
    /// given, and keeps the server name from the client's hello.
    /// </summary>
    /// <remarks>
    /// The certificates are here with their keys, as PKCS#12 encrypted with 3DES under a SHA-1
    /// MAC, which is what Mono can read. They are for tests only: their private keys are public.
    /// </remarks>
    internal sealed class TlsTestServer : IDisposable
    {
        /// <summary>The SHA-256 fingerprint of <see cref="OtherName"/>.</summary>
        internal const string OtherNameSha256 =
            "CA:4E:36:1E:82:EA:73:7E:00:5F:17:8B:75:22:D3:00:AD:FB:FF:3C:17:82:AC:52:03:72:EB:8C:27:2C:19:D5";

        private const string Password = "colibri-test";

        private readonly TcpListener _listener;
        private readonly Task<string> _serving;
        private readonly object _gate = new object();
        private TcpClient _accepted;
        private SslStream _tls;
        private bool _disposed;

        internal TlsTestServer(X509Certificate2 certificate)
        {
            _listener = new TcpListener(IPAddress.Loopback, 0);
            _listener.Start();
            Port = ((IPEndPoint)_listener.LocalEndpoint).Port;

            _serving = Serve(certificate);
            _ = _serving.ContinueWith(serving => { _ = serving.Exception; }, CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
        }

        internal int Port { get; }

        /// <summary>
        /// The TLS test server's certificate, colibri-unity/tls-test-server/cert.pem with its key:
        /// self-signed, issued for localhost, 127.0.0.1 and ::1. Its fingerprint is
        /// <see cref="ServerCertificatePolicyTests.TestCertificateSha256"/>.
        /// </summary>
        internal static X509Certificate2 Localhost() => Load(LocalhostPfx);

        /// <summary>A self-signed certificate issued for colibri.invalid and no other name.</summary>
        /// <remarks>
        /// Made with <c>openssl req -x509 -newkey rsa:2048 -nodes -days 36500 -subj "/CN=colibri.invalid"
        /// -addext "subjectAltName=DNS:colibri.invalid"</c> (plus the key usages of the TLS test
        /// server's certificate), then <c>openssl pkcs12 -export -certpbe PBE-SHA1-3DES -keypbe
        /// PBE-SHA1-3DES -macalg sha1</c> with the password below, as was <see cref="Localhost"/>.
        /// </remarks>
        internal static X509Certificate2 OtherName() => Load(OtherNamePfx);

        /// <summary>
        /// The host name the client asked for in its hello, or null if it named none. Waits for
        /// the handshake to end, whichever way it ends.
        /// </summary>
        internal string RequestedServerName
        {
            get
            {
                if (!_serving.Wait(TimeSpan.FromSeconds(10)))
                    throw new TimeoutException("The client's handshake never reached the test server");

                return _serving.Result;
            }
        }

        public void Dispose()
        {
            lock (_gate)
            {
                _disposed = true;
                _listener.Stop();
                _tls?.Dispose();
                _accepted?.Close();
            }
        }

        private async Task<string> Serve(X509Certificate2 certificate)
        {
            var accepted = await _listener.AcceptTcpClientAsync().ConfigureAwait(false);
            var hello = new RecordingStream(accepted.GetStream());
            var tls = new SslStream(hello, false);
            lock (_gate)
            {
                _accepted = accepted;
                _tls = tls;
                if (_disposed)
                {
                    tls.Dispose();
                    accepted.Close();
                    return null;
                }
            }

            try
            {
                await tls.AuthenticateAsServerAsync(certificate, false, SslProtocols.Tls12, false).ConfigureAwait(false);
            }
            catch (Exception)
            {
                // A client that rejects the certificate ends the handshake, which is what some of
                // the tests are about.
            }

            return ServerNameIn(hello.Recorded);
        }

        /// <summary>
        /// The host name in the server_name extension (RFC 6066) of the ClientHello that
        /// <paramref name="received"/> starts with, or null if it has none.
        /// </summary>
        internal static string ServerNameIn(byte[] received)
        {
            try
            {
                // A handshake record (22) that holds a ClientHello (1).
                if (received[0] != 22 || received[5] != 1)
                    return null;

                var at = 5 + 4;                       // record header; handshake type and length
                at += 2 + 32;                         // version, random
                at += 1 + received[at];               // session id
                at += 2 + UInt16At(received, at);     // cipher suites
                at += 1 + received[at];               // compression methods
                var end = at + 2 + UInt16At(received, at);
                at += 2;

                while (at < end)
                {
                    var type = UInt16At(received, at);
                    var length = UInt16At(received, at + 2);
                    at += 4;

                    // server_name: a list of names, its length first; a host_name (0) is the only
                    // kind of name there is.
                    if (type == 0)
                        return received[at + 2] == 0 ? Encoding.ASCII.GetString(received, at + 5, UInt16At(received, at + 3)) : null;

                    at += length;
                }

                return null;
            }
            catch (Exception e) when (e is IndexOutOfRangeException || e is ArgumentException)
            {
                return null;
            }
        }

        private static int UInt16At(byte[] bytes, int at) => bytes[at] << 8 | bytes[at + 1];

        private static X509Certificate2 Load(string pfx) => new X509Certificate2(Convert.FromBase64String(pfx), Password);

        /// <summary>Passes everything through, and keeps a copy of what was read.</summary>
        private sealed class RecordingStream : Stream
        {
            private readonly Stream _inner;
            private readonly MemoryStream _read = new MemoryStream();

            public RecordingStream(Stream inner) => _inner = inner;

            public byte[] Recorded
            {
                get
                {
                    lock (_read)
                        return _read.ToArray();
                }
            }

            public override bool CanRead => true;
            public override bool CanSeek => false;
            public override bool CanWrite => true;
            public override long Length => throw new NotSupportedException();

            public override long Position
            {
                get => throw new NotSupportedException();
                set => throw new NotSupportedException();
            }

            public override int Read(byte[] buffer, int offset, int count) => Keep(buffer, offset, _inner.Read(buffer, offset, count));

            public override async Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken token)
                => Keep(buffer, offset, await _inner.ReadAsync(buffer, offset, count, token).ConfigureAwait(false));

            public override void Write(byte[] buffer, int offset, int count) => _inner.Write(buffer, offset, count);

            public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken token)
                => _inner.WriteAsync(buffer, offset, count, token);

            public override void Flush() => _inner.Flush();
            public override Task FlushAsync(CancellationToken token) => _inner.FlushAsync(token);
            public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
            public override void SetLength(long value) => throw new NotSupportedException();

            protected override void Dispose(bool disposing)
            {
                if (disposing)
                    _inner.Dispose();
                base.Dispose(disposing);
            }

            private int Keep(byte[] buffer, int offset, int read)
            {
                lock (_read)
                    _read.Write(buffer, offset, read);
                return read;
            }
        }

        private const string LocalhostPfx =
            "MIIJ8gIBAzCCCbgGCSqGSIb3DQEHAaCCCakEggmlMIIJoTCCBC8GCSqGSIb3DQEHBqCCBCAwggQcAgEAMIIEFQYJKoZIhvcNAQcB"
            + "MBwGCiqGSIb3DQEMAQMwDgQICy8Q1BK3ZJYCAggAgIID6DDSnQLT1HO/OXy5NeXZQEVI5ctQaX3PVy54QTnq+nMxdPloLtCXOnOg"
            + "RBgL0ga5zqHQ4tCr7Xp3BJECa/bZSK/g7AGHUyMm9xOgtI26DKPEng2il3jUMrSyuUyY44WJXhY8KMxE9kNxVmXOUlkpVAgy6fSi"
            + "Oz2q2BQZDYKsIS4w7RQ0e7+nrIZSQa8ta8D1IDBZyg5kaqac8Iz1mYhITeZRjRnYeiUt1NGn28SWX54uWoxeF0uZj6QIuibf2OYv"
            + "SyFDh98lyfaT4vyVt7wg/IBQpVCvPksT8z4CNDAeIA5m2IisQnlq+sV2p+T9o1rE9bpsmEUzhKWOsksL1UsS+umrF0sqKhgjzTPb"
            + "bTaNBLApD8zLFswv+z0C0plCnMJzHTnzmJJ2Bj2LuktytAMedmjmgwbZFzscVUk0k0D8gUp2+hEkKJTt5LlvWz96K2K/cm8DBRI7"
            + "FfaKQGp9cc38LXh6HBmRp1ih4ui/MkOuPx9xyLI9rmx8grETYTTmy2M4GiAX5JvoTuHc3jwdWQ+Rjn2BWcWrxAvOmouTZMB/3ygV"
            + "L9dQMJjsnV0TgSR1YDULY3m++Ep7ZBYqooLRwqtKSkFgmAtzovDGEN2VhpJ4QLwqgebHzxcatMtP1vp2w+bkmXGn40QLwyuFq+V9"
            + "hBbUeNVkejHjDXm4h15vVx2H4LfNPysXGaym1UJs+ljRJqlz/IubVk9vhQX7clwLhHfKQNIJQ26OWpArrO2OP2Tf+YIaikhlOeak"
            + "0gc5W0kH4UXJHu4esqH+x6HpHVBs+d2f3ozagwWtRZiaMWX9WLyrsXEbKeDpFfH2AS+l/50uwHtAVRcwhjzY0ZfSs8lX0mgkQWkA"
            + "wSh8PYELdbKdZaG5jRg3VY79rWN1BYLjFKrYlbLp6Lds6jRtTB3O4E6q/sFqSX/v8GCHukzZ+hYEmwALJCRNH9AijpXQikf/b8h6"
            + "qyPoxf/6P0ibYZ30+lyhG807GePt2/qTAhNFPnmlZ6CQQvgc0K4+ybsdVtoqIBNzCMeMQhW5+S4g5kzYHp0nsZZMj8z69HzpLTOL"
            + "SRhKR/kuoc3lBmXQJIS346Vhxonco+GxNEntJg/p+C/7iPbhn1XicuHE7Owma2eWmlIaFgs8xUXOURhsGiajMQI/2MLkHnAwaC7K"
            + "3naiAiX2WN48I5Pbge9lxWxQQasn6BTybajemL4x3PP1URy48zwGs6kwUBdUJHYlYoaWh5k5wME4F4sAKiJDheq+VpaEQ6fFA9hX"
            + "G5X1+vmBMe/d70L1efHKi+E8U0/tDW2rOphDXVp9eNzpmXh9b2RQS7TcGJM4Stvl4TQnL/7uuWnvwcUwggVqBgkqhkiG9w0BBwGg"
            + "ggVbBIIFVzCCBVMwggVPBgsqhkiG9w0BDAoBAqCCBO4wggTqMBwGCiqGSIb3DQEMAQMwDgQI3HQMPuHGdDwCAggABIIEyLk7N2lU"
            + "elwmAC9afZrSf6Gz5qDlZvQ/Ls4bJV/Xt4Q8zjUDWlDySODKyOEs1mJEKmvfReEy8pOQDUnfpXCWMCDCxomaKalsWhtki2nyzhOU"
            + "frX3Svi27o6PAweC5WJjIBiVkQ7+tP5psPk9ELLwakG/Phkt7M0zKduJRjn9gswc8Q24cfLBvioT8cp4VrVG2j9lXfSu1BA2G/8W"
            + "Mdn0nvHv9ITGQSQ/6Z/ZQnPX/LDJ3p2bXvLvcsfQmmC2vjfc96GLVN6edVRlWRHCcWOgdl9rsOEV2KgpgNhiXSdbJ0s9WHG3idgc"
            + "eCLH7mtwL4EkVXjL1qmGYy1T5S2shY9YycOmo4f8bDHVrt5tH4LHm1uYMGuIVSCzEnTdBn8fGUm/mgCyKeg8C3jNS9jR1AlxJRrS"
            + "fCDgJ2dHQ821VZHQFAbfyFZVW0xWvvdvjkfLz/0fHMpjQ863CfBkur2o0gn395scb5DTvj6s1XlF74tU17XC3v9P18hQpxpHG/tX"
            + "fxhIp10acVlxMLdubqlhOOi9Sm7WG5GLvYirGHZCWfo1pmydA4MX83hvt3biG5UTHHG51htq57G8CqBEXcMsStlOLrLhkzE2PRQQ"
            + "3UwFsoNpt2jK+4SNx1oHxCsjX/QNTL9gd82DiVuoXr40GBCpLSIfKot8ImuZvJYn/mqaF+3IQG/q+ohatjZQyaYqvGuRBdtvRwce"
            + "aKTPNWRS8ry2K9E4yYhTXJS9RHr3wGEZlUyd50Vrk+LIK1nD0qa6XrecTKskYjydGv2AvYD9o57WJw6taYNbP1yPSPbtZVA+1xS7"
            + "G4307wV/z31fd16WRg+b4g3O4bMDJ5BWOvu/QMFSI41fl3GTxgO/HHBD1FPt63VrOsexK6sFC+Opcci/YJ7fxWMUaH9wB4jpnmSf"
            + "lEgxKlsU8BvQV1CB9H01JefC1E+V7aCSNTaxac9a5CTSORzR9eqGoHUJFaOEyHtgnMjlf47OpvKa6TOIM9SvUfHeNsDKUXVaEwtg"
            + "ihtxLk4jpnaC+sxI5GMbjsQdS43GpsStVX+hjfMSsB5gehUZcD3CkUJBDFCC66QCxIANcTWkKkY0pNCQYqOGY5wCw2CjVEmRGy0A"
            + "bGZyk2PgMk9AqwA5OmKTBKrjIgwIenQ6g3+yMAOfQhWTGjCSO1GAbqdmSM3DM2+k2tiOLrvTJzW3QYCWX3XRVQ1qgcHCKm47Ekyj"
            + "fciUBExvDc5kgLJpmM8ZDCzJ10EZdCS5FzchEPAE6r48jU9Tr3tU7wFa3lAR4MhXzfjr6hGYrVQe59oGxL/5S4t5B1tYle79ZYqp"
            + "zlkFZQtF9K81GwrTkWqfZ38NqBmDtha2X8lfIBYZFBtowDPO+oyxjU3PaRih3e/ZDH4K++460ibPdrbUIg9RndCEthDIwArZ+3WP"
            + "rtQP6zuh+6gx4Xe93RKpvbNwSg05ewO4x1flsVCjf7kHDaziWIKZn+P+XOLG2cOPJNlpHIHTmPEtD///iTNHEQ5AlsHNa3Ddhto9"
            + "B5Y31UbQSoouUvLLtLxUQTcgiUDxP1H+j0hfQJf+nXE/KtjJfTVdHUvp+jC3fNBCmV1o0loS5uiZjAf/GUGO1NttQCdByTyJWRFR"
            + "TL+uga/g8hcPuhQ4XWFVTo3wkzFOMCMGCSqGSIb3DQEJFTEWBBRG2Iu6IQ2OhYCOSSKAziaUYtLjcjAnBgkqhkiG9w0BCRQxGh4Y"
            + "AGMAbwBsAGkAYgByAGkALQB0AGUAcwB0MDEwITAJBgUrDgMCGgUABBT1OZ+mbqblH3zBFm7Y++fFjyhKwQQIhM8FXas+dY8CAggA";

        private const string OtherNamePfx =
            "MIIJ6gIBAzCCCbAGCSqGSIb3DQEHAaCCCaEEggmdMIIJmTCCBCcGCSqGSIb3DQEHBqCCBBgwggQUAgEAMIIEDQYJKoZIhvcNAQcB"
            + "MBwGCiqGSIb3DQEMAQMwDgQInko2lF1DxvQCAggAgIID4AidHa5B3ZDAegMeXrVtHTRbqueluo5lvvlUwZHuR6o6ZZ9GjzerIREK"
            + "fV4P9t13p40vNA//r8IdZEkleHFijOud2mPX4N/31j4NSe9Behce9RprrZj4PiAmUuzBXTRnlz8A7A82u8QoKrn33KOwS+IXuRBK"
            + "wCPbgwW6iYvqFNamkShcXobRaBtEXsAoJFzOpvbGcxJH4topg8Q4lHUQmHbgmqD3qno6GCr1VB2FqAG5MS9xZg3lv0/iCUpha1jD"
            + "QLHR7uk/mXc5Lu4VBFfv8QHOmZpiWRe5KrHB5IVs9gGRt64x5f/x0e1FVRDhKZsuczbY1f2rKoQ+tjEa0q8uPL6ImSsuIE3FceTS"
            + "1g14uDz7lk79lF98EYQdYgt0+E+wSDVwledHb4JCeHR8Bi7CTtyUO+Ki/kCXKlibHkB1McGmXmavjAnfcg0K0LT9GaIOg1OuRi41"
            + "bwYkLjL5AIM2h2WYFjUeo0TGeFDFfvfFGPYYV4xj9OpyLc9emvmSJTqQdnR6zcY0Znq95PwXYl7Ih3t1dnlVykeuEUBnlDo0TxbB"
            + "40IqZIpeHjhcxGj4I8XNLY60L6q7pgP9/W04nL1wG/S5fTCqRpRjoRE9TpAMuoQod32UV9Cu+7d0vB67rAbzotsxoCKVkpdNO/Pu"
            + "NRxafbPXfdBXP/CsqVXh4GuXiz8SCvPx4RaslQmWHwshVGbP7TmjJCoLriUfWFsEi+LkXE7WdT4tFOFDpCD7m86yDi+514p5FwXB"
            + "fEHWMiSmWORIL+VOffHqFibfYDO5Iy+2NwYx2piOOPLs8dFfhRc+yX3QhHABzqF6M5KvzmfM965Ff3EAlbRK6bW5iS5AULZMaJUF"
            + "9pQmAPESauWk9pLSDmMpDgLxMPzNPM5wvykO/jcfANVvaROb+SNu6jOLzmCiWIc2grl8ZpFdEKjx3OGuBMGq68cWtlHoFjF6o18m"
            + "3T7q8eAqkAue1tOI+nDqyr1ghtSp2yu95AaX+sWyIjB0FRtYwu3g5IGZNpk3KfVLFVH4b2864v/MZpZ6vbnD47Eo3Z7OgI8hr7dL"
            + "8FUu6CbEQyy/0cSEcBc6TSeI3vpsQMJF9OnyMAbl0vNETM3OTr8I2oJ9bfsWOCKf4NqwkYREzrHOMSgdLlRIsxfoYb+CrzIdZEV5"
            + "zqbx8y1NlNCSz70MbFb39ZFSYYCW3MIsU6xB8pU49CpiWcCEk7XWdC1tTlJ+AOdyxA0LlqxNTWyGd9TdgIPTtAqUl0t/ktC0oQjG"
            + "YwbNAwBUJOXlG5fZEKG6LIduPY/En5UxQNsi4r0zKI2TrZGLtc33tQhUMyLdcNUf1b3FMIIFagYJKoZIhvcNAQcBoIIFWwSCBVcw"
            + "ggVTMIIFTwYLKoZIhvcNAQwKAQKgggTuMIIE6jAcBgoqhkiG9w0BDAEDMA4ECChyc2aktRvVAgIIAASCBMhYLMLAhavW81kQUA2m"
            + "NxPjFGGMlvB8HiQSm0lAQ8+CJCeZ7hLMjZ5csXCaFhsU8Gms76bmJR7HdsUKdXhA85yfEso5oB8T+g7SX+1wKEobSpIKS3fq+3Tu"
            + "GcJE/TaWiUiJRsJzjt84MHhqf1I0XvVxBD5bWPDOEKOYbwnrJqtWfSy/7xTpEaAkbzkPCpwG6L/ooZsk5cFHjOW0Y0a4PdAXQ4+x"
            + "gdDEMV+M+1s+RS/QmUGF2DwT10bhS/sd96LwvzSjdU28IIyYZzTOji4Yv9DiDg2iiuD7wERuKe1HAr2fvdjc4oH3ruITqSORjolq"
            + "Wur/4Er7d9QU5VfKlbIlhFcHizkwmHIpNHyTVzjoDxPto3MvwEcPfWYWvHfNQT9ij7ljkYhK7r2XZEXMNWZ4ORrE4uPgU86KHkM3"
            + "hEQxhaV+I0+O+YjbRT0Lg47TLRUerp5QopfEQHTMPZPmW6oBOvYbrfwNbh8UVJHsNGr0w0U4kQ8xeRRJLtRecsKvOGWBReLVxIR/"
            + "745h4k4qudtUJUbBpOfp8rMfzq4ZS0dkDrpURXHVPZHpUKjdmru2GegznmPfyFO4qWM7JYLsZVth9OwLUiUP/1xqq/9OFKNyvk2i"
            + "PaaEFEa0sYn+LShZFS9slvrHpUMFtQLDtklArIL5iVzINTUV097djlo7i4wrqXnRqzgjrEUPcyYhBpkRAdGyMtL8/hXB3xXsXe4t"
            + "uRYA1lPH36+Ez4ZgNL0+xTorlaTj2kR7QxLEgEkFJQp7pJN6w/F5LvdPsovY5YhA3T+w4cd+L+W3HlckZabc2h0Svp6WcUaC/lu7"
            + "4bDHdKaOrDpGZzJg5jzCg2bylh3t+d7mHmZgKBTWLDbL0yXYD3ErjGoBMQB5P9BjSpjaJcMARM9owTkbjZmbly2HyJVzy+2gJLHE"
            + "K2ZHLmyvabBmx7zgszRcmTidiCw1KTcEM6Pysy8thFsH8tW+NjEU6Jf5z3oxPHOVC7FCgf5RFM28owO2Vas4pczrMhYefEnXKzMM"
            + "hxR6MPZQR/usSf8ANoGXgkriCon7NoWv/sDssE3ZlIqv2ewo4F7k8Xn39wOb5SmuuPVXrDM89Y0aq9zkrKexn6kUoryJAVsP18GQ"
            + "Zs0O8gnUr91H981Fa9FJ7PaVfRFlkF/vd2LbvNjWYWSgiP/L2xKWEZizFmlvmrpoqH68uQ/JJEkadjZ5UW+4vqYc2Xkwt65OYOvC"
            + "UD+lSOFJOc1XoJ4UGaDHTXuW8X5FSeE4BPg9FEpkYwB6kw821iOQjtzxjxiG23F5SlYdOybe4Vy6mpAZvjKladQjmIzedLeFAw6r"
            + "QWJQbgIL9Vs9JGPeAg9EtYpA/CtB0fYLKzXBpEMOGgXuU8GZWIMzOjCHocrToZ1m5y3kxr4i0AWngrvg6TWRV8CyaTzmrcasBdxc"
            + "luTADrZB0/c7eGs76UFYTgs3JpHil6dmYF0ifd2Z+rkHhp/vnYIXWVtagBjNogoYNuZbI8tCNAIz7seEoX1zMR3jQkimCT6hMQ40"
            + "h1JuyqGWcnh61dmBHlYk9ge9i/2Ptg51yt4uxuv1veNmXdLhGj96IlV9vTzB6bDHCSQVpONJWVkex8MaS8l/2VJaWluOjPyJGASx"
            + "f/FRGrqQXNjAZ8kxTjAjBgkqhkiG9w0BCRUxFgQUOpMcxVes/ocaVihN94j1O71KyRgwJwYJKoZIhvcNAQkUMRoeGABjAG8AbABp"
            + "AGIAcgBpAC0AdABlAHMAdDAxMCEwCQYFKw4DAhoFAAQUliiuIpYyqe0NIve2FVrLtP7h2mYECC53VNnWe5T0AgIIAA==";
    }
}
