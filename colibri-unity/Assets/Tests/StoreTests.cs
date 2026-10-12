using System;
using System.Collections;
using System.Linq;
using System.Text.RegularExpressions;
using HCIKonstanz.Colibri.Setup;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.Networking;
using UnityEngine.TestTools;
using ColibriStore = HCIKonstanz.Colibri.Store.Store;

namespace HCIKonstanz.Colibri.E2E
{
    /// <summary>Anything the Store round-trips has to survive JSON in both directions.</summary>
    public class StoredThing
    {
        public string Name { get; set; }
        public int Count { get; set; }
    }

    public class StoredPlacement
    {
        public Vector3 Position;
        public Quaternion Rotation;
        public Color Tint;
    }

    /// <summary>
    /// The Store is the one part of Colibri that does not use the binary protocol at all - it is
    /// plain REST over the web port, which is why a wrong address failed so differently there.
    /// </summary>
    public class StoreTests : ColibriE2EFixture
    {
        [UnityTest]
        public IEnumerator SavesAndReadsBackAnObject()
        {
            var key = $"e2e-{Guid.NewGuid():N}";

            var put = ColibriStore.Put(key, new StoredThing { Name = "colibri", Count = 3 });
            yield return E2EServer.Await(put, "Store.Put never completed", 20f);
            Assert.That(put.Result, Is.True, "Store.Put reported failure");

            var get = ColibriStore.Get<StoredThing>(key);
            yield return E2EServer.Await(get, "Store.Get never completed", 20f);

            Assert.That(get.Result, Is.Not.Null, "Store.Get returned nothing for a key it had just written");
            Assert.That(get.Result.Name, Is.EqualTo("colibri"));
            Assert.That(get.Result.Count, Is.EqualTo(3));

            var delete = ColibriStore.Delete(key);
            yield return E2EServer.Await(delete, "Store.Delete never completed", 20f);
            Assert.That(delete.Result, Is.True, "Store.Delete reported failure");
        }

        /// <summary>
        /// Newtonsoft on its own cannot write a Vector3, Quaternion or Color - it follows
        /// Vector3.normalized, a Vector3 again, into a "Self referencing loop" - so a class
        /// holding one could not be saved at all.
        /// </summary>
        [UnityTest]
        public IEnumerator SavesAndReadsBackAnObjectWithUnityTypes()
        {
            var key = $"e2e-{Guid.NewGuid():N}";
            var saved = new StoredPlacement
            {
                Position = new Vector3(1.5f, 2f, -3f),
                Rotation = new Quaternion(0f, 0.6f, 0f, 0.8f),
                Tint = new Color(0.25f, 0.5f, 0.75f, 1f)
            };

            var put = ColibriStore.Put(key, saved);
            yield return E2EServer.Await(put, "Store.Put never completed", 20f);
            Assert.That(put.Result, Is.True, "Store.Put reported failure");

            var get = ColibriStore.Get<StoredPlacement>(key);
            yield return E2EServer.Await(get, "Store.Get never completed", 20f);

            Assert.That(get.Result, Is.Not.Null, "Store.Get returned nothing for a key it had just written");
            Assert.That(get.Result.Position, Is.EqualTo(saved.Position));
            Assert.That(get.Result.Rotation, Is.EqualTo(saved.Rotation));
            Assert.That(get.Result.Tint, Is.EqualTo(saved.Tint));

            var delete = ColibriStore.Delete(key);
            yield return E2EServer.Await(delete, "Store.Delete never completed", 20f);
        }

        /// <summary>
        /// A key is stored under its own name whatever characters it has, which is the entry
        /// colibri-web addresses for it: the server decodes the key colibri-web escapes with
        /// encodeURIComponent. Pasted into the path as it was, "scores/..." went to a path the
        /// server has no route for, "round#..." was stored as "round", and "what?..." as "what".
        /// </summary>
        [UnityTest]
        public IEnumerator AKeyIsStoredUnderItsOwnNameWhateverCharactersItHas()
        {
            var unique = Guid.NewGuid().ToString("N").Substring(0, 8);
            var keys = new[] { $"scores/{unique}", $"round#{unique}", $"what?{unique}", $"100%{unique}", $"two words {unique}" };

            foreach (var key in keys)
            {
                var put = ColibriStore.Put(key, new StoredThing { Name = key, Count = 1 });
                yield return E2EServer.Await(put, "Store.Put never completed", 20f);
                Assert.That(put.Result, Is.True, $"Store.Put(\"{key}\") reported failure");
            }

            // The names the server keeps the app's entries under.
            using (var request = UnityWebRequest.Get($"{E2EServer.WebUrl}/api/store/{Uri.EscapeDataString(E2EServer.App)}"))
            {
                // Over TLS, the pinned certificate; otherwise none.
                request.certificateHandler = HCIKonstanz.Colibri.Store.ServerCertificateHandler.For(ColibriConfig.Load());
                yield return request.SendWebRequest();
                Assert.That(request.responseCode, Is.EqualTo(200), $"Listing the app's entries failed: {request.error}");

                var names = JArray.Parse(request.downloadHandler.text).Select(name => (string)name).ToArray();
                Assert.That(names, Is.SupersetOf(keys), $"The entries are named {string.Join(", ", names)}");
            }

            foreach (var key in keys)
            {
                var get = ColibriStore.Get<StoredThing>(key);
                yield return E2EServer.Await(get, "Store.Get never completed", 20f);
                Assert.That(get.Result?.Name, Is.EqualTo(key), $"Store.Get(\"{key}\") did not read what Store.Put wrote");

                var delete = ColibriStore.Delete(key);
                yield return E2EServer.Await(delete, "Store.Delete never completed", 20f);
                Assert.That(delete.Result, Is.True, $"Store.Delete(\"{key}\") reported failure");
            }
        }

        /// <summary>
        /// UnityWebRequest defaults to no timeout at all, so a wrong server address used to leave
        /// the call outstanding forever: no result, no error, nothing in the console, and no way to
        /// tell a slow server from a typo.
        /// </summary>
        [UnityTest]
        public IEnumerator GivesUpAndSaysSoWhenTheServerIsNotThere()
        {
            var config = ColibriConfig.Load();
            var realPort = config.WebServerPort;

            // Only the web port, so the binary connection this fixture depends on is untouched.
            config.WebServerPort = 9099;
            Cleanup.Add(() => config.WebServerPort = realPort);

            LogAssert.Expect(LogType.Error, new Regex("^Colibri: could not load "));

            var get = ColibriStore.Get<StoredThing>("does-not-matter");
            yield return E2EServer.Await(get, "Store.Get hung against an unreachable server", 20f);

            Assert.That(get.Result, Is.Null);
        }
    }

    /// <summary>
    /// The Store over https, against the TLS test server (see <see cref="TlsTests"/>), whose web
    /// port serves the same self-signed certificate as its TCP port. The certificate settings have
    /// to work for the Store's requests too, or a server with a self-signed certificate could
    /// connect and still not load or save anything.
    /// </summary>
    /// <remarks>
    /// "Server supports SSL/TLS" is shared with the TCP connection that other fixtures leave
    /// running, but that only reads it when it reconnects, and these tests put it back long before
    /// one is due. The TCP port is left alone.
    /// </remarks>
    public class StoreOverTlsTests
    {
        private const string OtherSha256 =
            "BA:78:16:BF:8F:01:CF:EA:41:41:40:DE:5D:AE:22:23:B0:03:61:A3:96:17:7A:9C:B4:10:FF:61:F2:00:15:AD";

        [SetUp]
        public void RequireTheTlsServer() => E2EServer.RequireTlsServer();

        [TearDown]
        public void RestoreTheConfiguration() => E2EServer.Configure();

        [UnityTest]
        public IEnumerator SavesAndReadsBackWithThePinnedCertificate()
        {
            UseTheTlsServer(allowSelfSigned: false, pin: E2EServer.TlsCertificateSha256);
            yield return SaveReadAndDelete();
        }

        [UnityTest]
        public IEnumerator SavesAndReadsBackWhenSelfSignedCertificatesAreAllowed()
        {
            UseTheTlsServer(allowSelfSigned: true, pin: "");
            yield return SaveReadAndDelete();
        }

        [UnityTest]
        public IEnumerator RejectsTheSelfSignedCertificateByDefault()
        {
            UseTheTlsServer(allowSelfSigned: false, pin: "");
            LogAssert.Expect(LogType.Error, new Regex("^Colibri: could not load "));

            var get = ColibriStore.Get<StoredThing>("does-not-matter");
            yield return E2EServer.Await(get, "Store.Get never completed", 20f);

            Assert.That(get.Result, Is.Null);
        }

        [UnityTest]
        public IEnumerator RejectsAnotherCertificateWhenOneIsPinned()
        {
            UseTheTlsServer(allowSelfSigned: true, pin: OtherSha256);
            LogAssert.Expect(LogType.Error, new Regex("^Colibri: could not load "));

            var get = ColibriStore.Get<StoredThing>("does-not-matter");
            yield return E2EServer.Await(get, "Store.Get never completed", 20f);

            Assert.That(get.Result, Is.Null);
        }

        private static void UseTheTlsServer(bool allowSelfSigned, string pin)
        {
            E2EServer.Configure();

            var config = ColibriConfig.Load();
            config.IsSSL = true;
            config.WebServerPort = E2EServer.TlsWebPort;
            config.AllowSelfSignedCertificate = allowSelfSigned;
            config.ServerCertificateSha256 = pin;
        }

        private static IEnumerator SaveReadAndDelete()
        {
            var key = $"e2e-tls-{Guid.NewGuid():N}";

            var put = ColibriStore.Put(key, new StoredThing { Name = "over https", Count = 5 });
            yield return E2EServer.Await(put, "Store.Put never completed", 20f);
            Assert.That(put.Result, Is.True, "Store.Put reported failure over https");

            var get = ColibriStore.Get<StoredThing>(key);
            yield return E2EServer.Await(get, "Store.Get never completed", 20f);
            Assert.That(get.Result?.Name, Is.EqualTo("over https"));

            var delete = ColibriStore.Delete(key);
            yield return E2EServer.Await(delete, "Store.Delete never completed", 20f);
            Assert.That(delete.Result, Is.True, "Store.Delete reported failure over https");
        }
    }
}
