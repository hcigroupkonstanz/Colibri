using System;
using System.Collections;
using System.Linq;
using HCIKonstanz.Colibri.Core;
using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Synchronization;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.TestTools;
using Object = UnityEngine.Object;

namespace HCIKonstanz.Colibri.E2E
{
    /// <summary>
    /// The zero-code component: drop <c>SyncTransform</c> on an object and it follows its twin on
    /// every other client. Both directions, and the per-field switches that decide what is worth
    /// putting on the wire at all.
    /// </summary>
    public class SyncTransformTests : ColibriE2EFixture
    {
        private const string Channel = "synctransform";

        private static IEnumerator LetInitialStateArrive() => E2EServer.Settle(1.5f);

        [UnityTest]
        public IEnumerator AMoveReachesTheOtherClient()
        {
            var sync = SpawnConfigured<SyncTransform>("cube", _ => { });
            yield return LetInitialStateArrive();

            sync.transform.position = new Vector3(1f, 2f, 3f);

            yield return Peer.Expect(Channel, "model::update", frame =>
            {
                var payload = TcpPeer.Json(frame);
                Assert.That(payload["id"].Value<string>(), Is.EqualTo(sync.Id));
                Assert.That(payload["position"].ToString(Newtonsoft.Json.Formatting.None), Is.EqualTo("[1.0,2.0,3.0]"));
            });
        }

        /// <summary>
        /// Turning a field off has to keep it off the wire even while it is changing locally.
        /// Otherwise the switches are decoration and every object costs the full transform.
        /// </summary>
        [UnityTest]
        public IEnumerator TheFieldsThatAreSwitchedOffAreNotSentEvenWhenTheyChange()
        {
            var sync = SpawnConfigured<SyncTransform>("position-only", s =>
            {
                s.SyncActive = false;
                s.SyncRotation = false;
                s.SyncScale = false;
            });
            yield return LetInitialStateArrive();

            sync.transform.position = new Vector3(1f, 2f, 3f);
            sync.transform.rotation = Quaternion.Euler(0f, 90f, 0f);
            sync.transform.localScale = new Vector3(2f, 2f, 2f);

            yield return Peer.Expect(Channel, "model::update", frame =>
            {
                var payload = (JObject)TcpPeer.Json(frame);
                var members = payload.Properties().Select(p => p.Name).OrderBy(n => n).ToArray();

                Assert.That(members, Is.EqualTo(new[] { "id", "position" }),
                    $"Rotation and scale changed too, but only position was meant to travel. Sent: {string.Join(", ", members)}");
            });
        }

        /// <summary>
        /// The full state a manager sends for a new object, once the server has answered the
        /// object's first request, goes by the same switches. It used to carry every member, and a
        /// switched-off one as the placeholder its getter reads - Vector3.zero for the position -
        /// which a client with that box ticked applied: the object jumped to the origin there.
        /// </summary>
        [UnityTest]
        public IEnumerator TheFullStateLeavesOutTheFieldsThatAreSwitchedOff()
        {
            yield return SpawnManagerWithInactiveTemplate();

            var sync = SpawnConfigured<SyncTransform>("full-state-position-off", s =>
            {
                s.SyncPosition = false;
                s.SyncActive = false;
            });

            yield return Peer.Expect(Channel, "model::update", frame =>
            {
                var payload = (JObject)TcpPeer.Json(frame);
                var members = payload.Properties().Select(p => p.Name).ToArray();

                Assert.That(payload["id"].Value<string>(), Is.EqualTo(sync.Id));
                Assert.That(members, Does.Contain("rotation").And.Contain("scale"), $"Expected the full state, got {payload}");
                Assert.That(members, Does.Not.Contain("position").And.Not.Contain("active"),
                    $"A switched-off member went out as its placeholder: {payload}");
            });
        }

        [UnityTest]
        public IEnumerator AnUnchangedTransformSendsNothingAtAll()
        {
            SpawnConfigured<SyncTransform>("still", _ => { });
            yield return LetInitialStateArrive();

            // Nothing was touched, so nothing should ever have gone out - not at startup either.
            // The initial state exchange is between the object and the server alone; the peer is
            // only told about changes.
            yield return Peer.ExpectNothing(Channel, 2f);
        }

        /// <summary>
        /// The other half, and the one the manual verification never confirmed: an update from
        /// another client actually moves the object.
        /// </summary>
        [UnityTest]
        public IEnumerator AMoveFromAnotherClientMovesTheObject()
        {
            var sync = SpawnConfigured<SyncTransform>("follower", _ => { });
            yield return LetInitialStateArrive();

            Peer.Send(Channel, "model::update", new JObject
            {
                { "id", sync.Id },
                { "position", new JArray(4f, 5f, 6f) }
            });

            yield return E2EServer.WaitUntil(
                () => sync.transform.position == new Vector3(4f, 5f, 6f),
                $"The object never moved; it is at {sync.transform.position}");
        }


        /*
         *  Active state. Deactivating an object has to hide its copies everywhere else, and
         *  reactivating it has to bring them back. It never did: the poll skipped inactive
         *  objects, so `false` was never seen. And whatever tears an object down - Destroy, a
         *  scene unload, the end of Play mode - must not be mistaken for a deactivation on the
         *  way out.
         */

        [UnityTest]
        public IEnumerator DeactivatingTheObjectHidesItOnTheOtherClientAndReactivatingItShowsIt()
        {
            var sync = SpawnConfigured<SyncTransform>("hidden-and-back", _ => { });
            yield return LetInitialStateArrive();

            sync.gameObject.SetActive(false);

            yield return Peer.Expect(Channel, "model::update", frame => AssertActive(frame, sync.Id, false));

            sync.gameObject.SetActive(true);

            yield return Peer.Expect(Channel, "model::update", frame => AssertActive(frame, sync.Id, true));
            yield return Peer.ExpectNothing(Channel);
        }

        /// <summary>
        /// The send-rate limit holds back the moves that follow one another, but not this: hiding
        /// an object is often the last thing that happens to it, and it goes out at once, carrying
        /// the move that was being held.
        /// </summary>
        [UnityTest]
        public IEnumerator HidingAMovingObjectIsNotHeldBackByTheSendRateLimit()
        {
            var sync = SpawnConfigured<SyncTransform>("moved-then-hidden", _ => { });
            yield return LetInitialStateArrive();

            SyncSettings.MaxSendRate = 1;
            Cleanup.Add(SyncSettings.ResetMaxSendRate);

            sync.transform.position = new Vector3(1f, 0f, 0f);
            yield return Peer.Expect(Channel, "model::update", timeoutSeconds: 0.5f);

            sync.transform.position = new Vector3(2f, 0f, 0f);
            yield return null;
            sync.gameObject.SetActive(false);

            yield return Peer.Expect(Channel, "model::update", frame =>
            {
                AssertActive(frame, sync.Id, false);
                Assert.That(TcpPeer.Json(frame)["position"].ToString(Newtonsoft.Json.Formatting.None), Is.EqualTo("[2.0,0.0,0.0]"));
            }, timeoutSeconds: 0.5f);
        }

        /// <summary>
        /// Switching the component off stops it syncing; it does not mean the object has gone.
        /// </summary>
        [UnityTest]
        public IEnumerator DisablingOnlyTheComponentDoesNotHideTheObjectElsewhere()
        {
            var sync = SpawnConfigured<SyncTransform>("component-off", _ => { });
            yield return LetInitialStateArrive();

            sync.enabled = false;
            yield return Peer.ExpectNothing(Channel, 1.5f);

            sync.enabled = true;
            yield return Peer.ExpectNothing(Channel, 1.5f);
        }

        [UnityTest]
        public IEnumerator AnotherClientHidingAndShowingTheObjectIsAppliedHereAndNotEchoed()
        {
            var sync = SpawnConfigured<SyncTransform>("hidden-remotely", _ => { });
            yield return LetInitialStateArrive();

            Peer.Send(Channel, "model::update", new JObject { { "id", sync.Id }, { "active", false } });
            yield return E2EServer.WaitUntil(() => !sync.gameObject.activeSelf,
                "The peer deactivated the object, but it is still active here");
            yield return Peer.ExpectNothing(Channel);

            Peer.Send(Channel, "model::update", new JObject { { "id", sync.Id }, { "active", true } });
            yield return E2EServer.WaitUntil(() => sync.gameObject.activeSelf,
                "The peer reactivated the object, but it is still inactive here");
            yield return Peer.ExpectNothing(Channel);

            // And this client can still hide it itself afterwards.
            sync.gameObject.SetActive(false);
            yield return Peer.Expect(Channel, "model::update", frame => AssertActive(frame, sync.Id, false));
        }

        [UnityTest]
        public IEnumerator DestroyingTheObjectDeletesItWithoutDeactivatingItFirst()
        {
            var sync = SpawnConfigured<SyncTransform>("destroyed", _ => { });
            yield return LetInitialStateArrive();

            var id = sync.Id;
            Object.Destroy(sync.gameObject);

            yield return Peer.Expect(Channel, "model::delete",
                frame => Assert.That(TcpPeer.Json(frame)["id"].Value<string>(), Is.EqualTo(id)));

            // An active:false sent on the way out would have arrived before the delete and still
            // be waiting here.
            yield return Peer.ExpectNothing(Channel);
        }

        [UnityTest]
        public IEnumerator UnloadingTheSceneDeletesTheObjectWithoutDeactivatingItFirst()
        {
            var scene = SceneManager.CreateScene($"colibri-unload-{Guid.NewGuid():N}");
            var sync = SpawnConfigured<SyncTransform>("unloaded-with-its-scene", _ => { });
            SceneManager.MoveGameObjectToScene(sync.gameObject, scene);
            yield return LetInitialStateArrive();

            var id = sync.Id;
            yield return SceneManager.UnloadSceneAsync(scene);

            yield return Peer.Expect(Channel, "model::delete",
                frame => Assert.That(TcpPeer.Json(frame)["id"].Value<string>(), Is.EqualTo(id)));
            yield return Peer.ExpectNothing(Channel);
        }


        /*
         *  Objects another client created, built here by a SyncTransformManager from a template
         *  that is switched off - the usual way to keep a template in the scene without it being
         *  a synced object itself. The clone starts out switched off as well, and used to stay
         *  that way: it never ran Awake, never registered for its own updates, and an object that
         *  arrived hidden could never be shown again.
         */

        [UnityTest]
        public IEnumerator AnObjectHiddenElsewhereIsBuiltFromAnInactiveTemplateAndShownWhenItReappears()
        {
            yield return SpawnManagerWithInactiveTemplate();

            var id = Guid.NewGuid().ToString();
            Peer.Send(Channel, "model::update", new JObject
            {
                { "id", id },
                { "active", false },
                { "position", new JArray(1f, 2f, 3f) }
            });

            yield return E2EServer.WaitUntil(() => Instances(id).Any(),
                $"The manager never instantiated the object '{id}' it was told about");

            var clone = Instances(id).Single();
            Assert.That(clone.gameObject.activeSelf, Is.False, "The object is hidden on the client it came from");
            Assert.That(clone.transform.position, Is.EqualTo(new Vector3(1f, 2f, 3f)));

            Peer.Send(Channel, "model::update", new JObject { { "id", id }, { "active", true } });
            yield return E2EServer.WaitUntil(() => clone.gameObject.activeSelf,
                "The peer showed the object again, but it is still hidden here");

            // Applying either state must not send it back.
            yield return Peer.ExpectNothing(Channel);
        }

        [UnityTest]
        public IEnumerator AVisibleObjectIsBuiltFromAnInactiveTemplateAsVisibleAndFollowsItsMoves()
        {
            yield return SpawnManagerWithInactiveTemplate();

            var id = Guid.NewGuid().ToString();
            Peer.Send(Channel, "model::update", new JObject { { "id", id }, { "position", new JArray(1f, 2f, 3f) } });

            yield return E2EServer.WaitUntil(() => Instances(id).Any(),
                $"The manager never instantiated the object '{id}' it was told about");

            var clone = Instances(id).Single();
            Assert.That(clone.gameObject.activeSelf, Is.True, "The clone of an inactive template stayed inactive");
            Assert.That(clone.transform.position, Is.EqualTo(new Vector3(1f, 2f, 3f)));

            Peer.Send(Channel, "model::update", new JObject { { "id", id }, { "position", new JArray(4f, 5f, 6f) } });
            yield return E2EServer.WaitUntil(() => clone.transform.position == new Vector3(4f, 5f, 6f),
                $"The clone never moved; it is at {clone.transform.position}");

            yield return Peer.ExpectNothing(Channel);
        }

        private IEnumerator SpawnManagerWithInactiveTemplate()
        {
            var templateObject = Spawn("inactive-transform-template");
            templateObject.SetActive(false);
            var template = templateObject.AddComponent<SyncTransform>();

            var manager = Spawn<SyncTransformManager>("transform-manager");
            manager.Template = template;

            // Start is where the manager subscribes; nothing before it runs would be seen.
            yield return null;
            yield return LetInitialStateArrive();
        }

        private static SyncTransform[] Instances(string id)
            => UnityCompat.FindAll<SyncTransform>(FindObjectsInactive.Include)
                .Where(s => s.Id == id)
                .ToArray();


        /*
         *  A change made before the server's first answer for the object: in Start, in an
         *  OnConnected handler, or by a user right after Play. The answer put the server's value
         *  over it, and no other client ever saw it.
         */

        /// <summary>The proxy a test put between this client and the server, if any.</summary>
        private TcpProxy _proxy;

        /// <summary>
        /// The trace from Unity on Windows: a SyncTransform placed in the scene, hidden right after
        /// the client connected, was shown again by the server's answer, and the other client never
        /// saw it hidden. Here another client has moved the object before, so the server holds its
        /// state, and a manager on the channel asks for every model too, the object included. The
        /// object is hidden in the frame the client connects, before either answer arrives: it
        /// stays hidden here, is hidden on the other client and on the server, and takes the
        /// position the other client set, which it did not change.
        /// </summary>
        [UnityTest]
        public IEnumerator AnObjectHiddenBeforeTheServersAnswerStaysHiddenAndIsHiddenElsewhere()
        {
            var id = Guid.NewGuid().ToString();
            Peer.Send(Channel, "model::update", new JObject
            {
                { "id", id },
                { "active", true },
                { "position", new JArray(1f, 2f, 3f) }
            });
            Peer.Send(Channel, "model::request", new JObject { { "id", id } });
            yield return Peer.Expect(Channel, "model::update",
                frame => Assert.That(TcpPeer.Json(frame)["position"], Is.Not.Null, "Precondition: the server holds the object"));

            // The client starts up through a proxy that holds its connection: the object and the
            // manager ask for their state, and the requests wait in the queue.
            _proxy = TcpProxy.Start(E2EServer.Host, E2EServer.TcpPort, terminateTls: E2EServer.OverTls);
            _proxy.HoldNewConnections = true;
            yield return DestroyConnection();
            E2EServer.ConfigureInProcess(_proxy.Port);
            var connection = WebServerConnection.Instance;

            var sync = SpawnConfigured<SyncTransform>("hidden-before-the-answer", s => s.Id = id);
            var templateObject = Spawn("hidden-before-the-answer-template");
            templateObject.SetActive(false);
            var manager = Spawn<SyncTransformManager>("hidden-before-the-answer-manager");
            manager.Template = templateObject.AddComponent<SyncTransform>();
            yield return null;

            var hidden = false;
            Action hide = () =>
            {
                sync.gameObject.SetActive(false);
                hidden = true;
            };
            connection.OnConnected += hide;
            Cleanup.Add(() => connection.OnConnected -= hide);

            _proxy.HoldNewConnections = false;
            yield return E2EServer.WaitUntil(() => hidden, "The client never connected through the proxy", 20f);
            connection.OnConnected -= hide;

            yield return Peer.Expect(Channel, "model::update", frame => AssertActive(frame, id, false));

            // Long enough for both answers, and for the end of them.
            yield return E2EServer.Settle(1f);
            Assert.That(sync.gameObject.activeSelf, Is.False, "An answer showed the object again");
            Assert.That(sync.transform.position, Is.EqualTo(new Vector3(1f, 2f, 3f)),
                "The position, not changed here, did not take the other client's");

            var checker = Cleanup.Add(new TcpPeer());
            yield return checker.Connect("hidden-before-the-answer-checker");
            yield return E2EServer.Settle(0.3f);
            checker.Send(Channel, "model::request", new JObject { { "id", id } });
            yield return checker.Expect(Channel, "model::update", frame =>
            {
                var payload = (JObject)TcpPeer.Json(frame);
                Assert.That((bool?)payload["active"], Is.False, $"The server holds {payload}");
                Assert.That(payload["position"].ToVector3(), Is.EqualTo(new Vector3(1f, 2f, 3f)), $"The server holds {payload}");
            });
        }

        /// <summary>
        /// Points the connection back at the server after a test that put a proxy in between,
        /// before the fixture deletes what the test spawned.
        /// </summary>
        [UnityTearDown]
        public IEnumerator ConnectDirectlyAgain()
        {
            if (_proxy == null)
                yield break;

            yield return DestroyConnection();
            _proxy.Dispose();
            _proxy = null;
            E2EServer.Configure();
        }

        private static IEnumerator DestroyConnection()
        {
            var existing = Object.FindAnyObjectByType<WebServerConnection>();
            if (existing != null)
            {
                // OnDisable cancels the loop and closes the socket; the frame after is what lets
                // the cancelled loop unwind before anything rebuilds it.
                Object.DestroyImmediate(existing.gameObject);
                yield return null;
            }
        }


        /*
         *  Quitting. Leaving Play mode or the app tears every object down, and that must delete
         *  nothing on the server: the object is meant to outlive this client. An active object
         *  hears about it through OnApplicationQuit, but Unity never sends that to an inactive
         *  one - and a synced object is inactive whenever this client or another one has hidden
         *  it. Such an object used to delete itself, and every other client's copy with it.
         */

        [UnityTest]
        public IEnumerator AnObjectHiddenHereIsNotDeletedEverywhereWhenThisClientQuits()
        {
            var sync = SpawnConfigured<SyncTransform>("hidden-then-quit", _ => { });
            yield return LetInitialStateArrive();

            sync.gameObject.SetActive(false);
            yield return Peer.Expect(Channel, "model::update", frame => AssertActive(frame, sync.Id, false));

            yield return DestroyWhileQuitting(sync);

            yield return Peer.ExpectNothing(Channel, 1.5f);
        }

        [UnityTest]
        public IEnumerator AnObjectHiddenByAnotherClientIsNotDeletedEverywhereWhenThisClientQuits()
        {
            var sync = SpawnConfigured<SyncTransform>("hidden-remotely-then-quit", _ => { });
            yield return LetInitialStateArrive();

            Peer.Send(Channel, "model::update", new JObject { { "id", sync.Id }, { "active", false } });
            yield return E2EServer.WaitUntil(() => !sync.gameObject.activeSelf,
                "The peer deactivated the object, but it is still active here");

            yield return DestroyWhileQuitting(sync);

            yield return Peer.ExpectNothing(Channel, 1.5f);
        }

        /// <summary>
        /// Stands in for the end of Play mode: Application.quitting has been raised, then the
        /// object is destroyed. A test cannot send OnApplicationQuit, and the inactive objects
        /// above would not receive it anyway.
        /// </summary>
        private static IEnumerator DestroyWhileQuitting(Component component)
        {
            SingletonLifetime.IsQuitting = true;
            try
            {
                Object.Destroy(component.gameObject);

                // Destruction happens at the end of the frame; OnDestroy has run by the next one.
                yield return null;
            }
            finally
            {
                // Every later test needs a live application again.
                SingletonLifetime.IsQuitting = false;
            }
        }

        private static void AssertActive(Networking.Protocol.DecodedFrame frame, string id, bool expected)
        {
            var payload = (JObject)TcpPeer.Json(frame);

            Assert.That(payload["id"].Value<string>(), Is.EqualTo(id));
            Assert.That(payload.ContainsKey("active"), Is.True, $"Expected the active state, got {payload}");
            Assert.That(payload["active"].Value<bool>(), Is.EqualTo(expected));
        }
    }
}
