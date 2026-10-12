using System.Collections;
using System.Collections.Generic;
using HCIKonstanz.Colibri.Networking;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace HCIKonstanz.Colibri.E2E
{
    /// <summary>
    /// Both ends of every end-to-end test: a real Unity client connected to a real colibri-server,
    /// and a raw peer on the same app to be the other side of the conversation.
    ///
    /// The Unity connection is a scene singleton and deliberately survives the whole run - it
    /// handshakes once, and tearing it down between tests would spend a reconnect per test for no
    /// isolation, since the server keys everything on the app name. Isolation comes from
    /// <see cref="E2EServer.Channel"/> instead. The peer is per test, which is what makes the
    /// late-joiner cases honest.
    /// </summary>
    public abstract class ColibriE2EFixture
    {
        protected TcpPeer Peer { get; private set; }
        protected WebServerConnection Connection { get; private set; }

        /// <summary>What the test has to undo when it ends, failed or not. See <see cref="TestCleanup"/>.</summary>
        protected TestCleanup Cleanup { get; } = new TestCleanup();

        private readonly List<GameObject> _spawned = new List<GameObject>();

        /// <summary>The synced objects already in the scene when the test started.</summary>
        private HashSet<GameObject> _syncedBefore = new HashSet<GameObject>();

        [UnitySetUp]
        public IEnumerator ConnectBothEnds()
        {
            E2EServer.RequireReachable();
            E2EServer.Configure();

            // Touching Instance is what puts the connection in the scene and starts its loop.
            Connection = WebServerConnection.Instance;

            yield return E2EServer.WaitUntil(
                () => Connection.Status == ConnectionStatus.Connected,
                $"The Unity client never connected to {E2EServer.Host}:{E2EServer.TcpPort}",
                20f);

            Peer = new TcpPeer();
            yield return Peer.Connect();

            // The peer's handshake and a test's first message are two different connections, so
            // there is no ordering between them. Without this the server can relay the message
            // before it has put the peer on the app, and it is lost for good.
            yield return E2EServer.Settle(0.3f);

            _syncedBefore = TestCleanup.SyncedObjects();
        }

        [UnityTearDown]
        public IEnumerator DisconnectPeer()
        {
            Cleanup.Run();

            var destroyed = false;
            foreach (var spawned in _spawned)
            {
                if (spawned)
                {
                    Object.Destroy(spawned);
                    destroyed = true;
                }
            }
            _spawned.Clear();

            // And every synced object that appeared during the test without being spawned by it:
            // the objects a manager built from the server's answer, which on the shared model
            // channels includes models earlier tests left behind. Left in the scene, they were
            // found by the next test's manager - which takes switched-off objects too since
            // 06d5943 - and their state went out into that test's peer.
            foreach (var synced in TestCleanup.SyncedObjects())
            {
                if (!_syncedBefore.Contains(synced))
                {
                    Object.Destroy(synced);
                    destroyed = true;
                }
            }

            // Destruction is what sends model::delete, and that has to leave before the peer does.
            yield return null;

            // ...and reach the server before the next test's peer joins. The next test usually
            // listens on the same model channel, and every frame it has received counts for its
            // Expect and ExpectNothing - so a delete from here that the server handled after the
            // join failed whichever test came next. One frame was not enough on a busy machine:
            // two full runs in nine failed that way, each time in a different test.
            if (destroyed)
                yield return E2EServer.Settle(0.25f);

            Peer?.Dispose();
            Peer = null;
        }

        /// <summary>A GameObject the fixture will destroy after the test.</summary>
        protected GameObject Spawn(string name)
        {
            var go = new GameObject(name);
            _spawned.Add(go);
            return go;
        }

        protected T Spawn<T>(string name) where T : Component
        {
            var go = Spawn(name);
            return go.AddComponent<T>();
        }

        /// <summary>
        /// Adds a component to an object that is inactive first, so that its Awake runs only once
        /// the caller has finished configuring it. <c>SyncBehaviour.Awake</c> registers listeners
        /// and requests initial state, and doing that before the caller has set its fields makes
        /// the first update race the configuration.
        /// </summary>
        protected T SpawnConfigured<T>(string name, System.Action<T> configure) where T : Component
        {
            var go = Spawn(name);
            go.SetActive(false);

            var component = go.AddComponent<T>();
            configure(component);

            go.SetActive(true);
            return component;
        }

        protected static void AssertNoErrors() => LogAssert.NoUnexpectedReceived();
    }
}
