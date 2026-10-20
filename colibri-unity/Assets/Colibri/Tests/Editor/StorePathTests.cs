using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Setup;
using NUnit.Framework;
using ColibriStore = HCIKonstanz.Colibri.Store.Store;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// Where the Store reads and writes a key. colibri-web puts the app name and the key into the
    /// path with encodeURIComponent, so the Store has to as well, or the two address different
    /// entries: pasted in as they were, a '/' in a key made a path the server has no route for, a
    /// '#' cut the key off there, and a '?' turned the rest into a query. The expected paths are
    /// what encodeURIComponent makes of each key.
    /// </summary>
    public class StorePathTests
    {
        [TestCase("scores/alice", "scores%2Falice")]
        [TestCase("round#2", "round%232")]
        [TestCase("what?", "what%3F")]
        [TestCase("100%", "100%25")]
        [TestCase("two words", "two%20words")]
        [TestCase("a&b=c+d", "a%26b%3Dc%2Bd")]
        [TestCase("gr\u00fc\u00dfe", "gr%C3%BC%C3%9Fe")]
        [TestCase("plain-key_1.0~x", "plain-key_1.0~x")]
        public void AKeyIsOnePathSegmentEscapedAsColibriWebEscapesIt(string key, string expected)
        {
            Assert.That(ColibriStore.StorePath("app", key), Is.EqualTo("api/store/app/" + expected));
        }

        [Test]
        public void TheAppNameIsEscapedTheSameWay()
        {
            Assert.That(ColibriStore.StorePath("my app/1", "key"), Is.EqualTo("api/store/my%20app%2F1/key"));
        }

        /// <summary>
        /// The same rule as colibri-web's getRestUri, so that a name addresses the same value on
        /// both sides.
        /// </summary>
        [TestCase(" color ", "color")]
        [TestCase("/color", "color")]
        [TestCase(" //scores/alice", "scores/alice")]
        [TestCase("a.b", "a.b")]
        public void ANameLosesSurroundingSpacesAndLeadingSlashes(string name, string expected)
        {
            Assert.That(ColibriStore.KeyName(name), Is.EqualTo(expected));
        }

        /// <summary>
        /// A URL parser resolves "." and ".." as directory steps, and an empty name leaves none:
        /// Delete("") addressed the app itself and deleted every value of it.
        /// </summary>
        [TestCase(null)]
        [TestCase("")]
        [TestCase("   ")]
        [TestCase("/")]
        [TestCase(".")]
        [TestCase("..")]
        [TestCase(" /.. ")]
        public void ANameThatAddressesNoValueIsRefused(string name)
        {
            Assert.That(ColibriStore.KeyName(name), Is.Null);
        }

        /// <summary>
        /// The server's REST_MEDIA_TYPE, which it builds from the same protocol version: a value
        /// sent as anything else is refused with 415.
        /// </summary>
        [Test]
        public void RequestsUseTheServersMediaTypeForThisProtocolVersion()
        {
            Assert.That(ColibriStore.MediaType, Is.EqualTo($"application/vnd.colibri.v{WebServerConnection.ClientVersion}+json"));
        }

        /// <summary>"http://2001:db8::1:9211/" is no URL: an IPv6 server address needs brackets there.</summary>
        [TestCase("2001:db8::1", "[2001:db8::1]")]
        [TestCase("[2001:db8::1]", "[2001:db8::1]")]
        [TestCase("::1", "[::1]")]
        [TestCase("192.168.0.10", "192.168.0.10")]
        [TestCase("colibri.example.org", "colibri.example.org")]
        public void AnIPv6ServerAddressGoesInBracketsInTheUrl(string serverAddress, string expected)
        {
            Assert.That(ColibriConfig.UrlHost(serverAddress), Is.EqualTo(expected));
        }
    }
}
