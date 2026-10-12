using System.Collections;
using System.Linq;
using HCIKonstanz.Colibri.Core;
using HCIKonstanz.Colibri.Synchronization;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace HCIKonstanz.Colibri.E2E
{
    /// <summary>
    /// The machinery behind the sync loop, which has no public surface and therefore no other way
    /// of being checked.
    ///
    /// The 2.0.0 performance claim is that synchronization costs one <c>Update</c> and one
    /// <c>LateUpdate</c> for the whole application, no matter how many objects are synced. That
    /// held right up until the ticker started surviving Play mode: seven of them had accumulated,
    /// all enabled, all driving the same static list, so the seventh session sent every update
    /// seven times.
    /// </summary>
    public class LifecycleTests : ColibriE2EFixture
    {
        [UnityTest]
        public IEnumerator ThereIsExactlyOneTickerHoweverManyObjectsAreSynced()
        {
            SpawnConfigured<E2ESyncModel>("a", _ => { });
            SpawnConfigured<E2ESyncModel>("b", _ => { });
            SpawnConfigured<SyncTransform>("c", _ => { });
            yield return null;

            var tickers = Resources.FindObjectsOfTypeAll<SyncTicker>();

            Assert.That(tickers.Length, Is.EqualTo(1),
                $"Expected one sync ticker, found {tickers.Length}");
        }

        /// <summary>
        /// <c>HideFlags.DontSave</c> does not only keep an object out of the saved scene - it also
        /// exempts it from being destroyed when Play mode ends. That is what left one ticker behind
        /// per session. The flag must stay off; <c>DontDestroyOnLoad</c> alone is what is wanted.
        /// </summary>
        [UnityTest]
        public IEnumerator TheTickerIsNotExemptFromPlayModeTeardown()
        {
            SpawnConfigured<E2ESyncModel>("model", _ => { });
            yield return null;

            var ticker = Resources.FindObjectsOfTypeAll<SyncTicker>().Single();

            Assert.That(ticker.gameObject.hideFlags, Is.EqualTo(HideFlags.None),
                "The ticker carries hide flags again, so it will survive Play mode and the next "
                + "session will tick everything twice");
        }

        [UnityTest]
        public IEnumerator EachSyncedObjectIsDrivenExactlyOnce()
        {
            var before = SyncTicker.RegisteredCount;

            SpawnConfigured<E2ESyncModel>("a", _ => { });
            SpawnConfigured<E2ESyncModel>("b", _ => { });
            yield return null;

            Assert.That(SyncTicker.RegisteredCount, Is.EqualTo(before + 2));
        }

        [UnityTest]
        public IEnumerator ADestroyedObjectStopsBeingDriven()
        {
            var before = SyncTicker.RegisteredCount;
            var model = SpawnConfigured<E2ESyncModel>("temporary", _ => { });
            yield return null;

            Assert.That(SyncTicker.RegisteredCount, Is.EqualTo(before + 1));

            Object.DestroyImmediate(model.gameObject);

            // Deregistering clears the slot; LateUpdate compacts the list on the next frame.
            yield return null;
            yield return null;

            Assert.That(SyncTicker.RegisteredCount, Is.EqualTo(before),
                "A destroyed object is still registered with the ticker");
        }

        /// <summary>
        /// The connection is a singleton on purpose: one socket, one handshake, one client on the
        /// server's Clients page however many scenes and components ask for it.
        /// </summary>
        [UnityTest]
        public IEnumerator ThereIsExactlyOneConnection()
        {
            SpawnConfigured<E2ESyncModel>("model", _ => { });
            yield return null;

            var connections = UnityCompat.FindAll<Networking.WebServerConnection>(FindObjectsInactive.Include);

            Assert.That(connections.Length, Is.EqualTo(1),
                $"Expected one WebServerConnection, found {connections.Length}");
        }


        /*
         *  Surviving Play mode with domain reload disabled - which the v2 docs recommend turning
         *  on, so this is the configuration that projects following them actually run.
         *
         *  Ending a Play session destroys the singleton's GameObject but leaves the static field
         *  pointing at it. The next session has to notice that and build a new one. When it did
         *  not, the second press of Play produced a client with no connection at all: nothing in
         *  the scene, no socket, and - because handing back a destroyed object throws nothing -
         *  not one line in the console to say so.
         *
         *  Tested on singletons of their own rather than on WebServerConnection: the statics are
         *  per-T, so destroying these cannot disturb the connection the rest of the suite is
         *  using. One type per test, for the same reason - the state under test *is* the static,
         *  so sharing a type would leave whichever test runs second reading the first one's
         *  leftovers.
         */

        private class RebuiltSingleton : Core.SingletonBehaviour<RebuiltSingleton>
        {
        }

        private class PlantedSingleton : Core.SingletonBehaviour<PlantedSingleton>
        {
        }

        [UnityTest]
        public IEnumerator ASingletonIsRebuiltAfterTheLastSessionsInstanceWasDestroyed()
        {
            var first = RebuiltSingleton.Instance;
            Assert.That(first != null, Is.True, "the singleton was not created in the first place");

            // What ending a Play session does to it, minus the session.
            Object.DestroyImmediate(first.gameObject);
            yield return null;

            var second = RebuiltSingleton.Instance;

            // Unity's !=, and checked before anything dereferences `second`: the failure being
            // guarded against hands back the *destroyed* component, so asking whether it is alive
            // has to come first or the test reports a MissingReferenceException instead of saying
            // what went wrong. NUnit's own Is.Not.Null compares references and would pass here.
            Assert.That(second != null, Is.True,
                "The singleton was not rebuilt - Instance handed back the destroyed instance from "
                + "the previous session. That is a client with no connection in the scene, no "
                + "socket, and nothing in the console to say so");
            Assert.That(ReferenceEquals(second, first), Is.False,
                "A new instance was expected, not the previous session's");

            Object.DestroyImmediate(second.gameObject);
        }

        private class ChannelListener : MonoBehaviour
        {
            public int Received;

            public void Listen(string channel) => Sync.Receive<int>(channel, OnValue);

            private void OnValue(int value) => Received++;
        }

        /// <summary>
        /// The second press of Play, for a client that only listens. Its listeners from the first
        /// session were dropped along with their objects, but with domain reload disabled the
        /// channel's entry in Sync outlives them - and registering on a channel that already had
        /// an entry never asked for the connection. So nothing rebuilt it or subscribed to it: no
        /// connection in the scene, nothing received, and nothing in the console.
        /// </summary>
        [UnityTest]
        public IEnumerator AListenerRegisteredAfterTheConnectionWasRebuiltStillHearsTheServer()
        {
            var channel = E2EServer.Channel("next-session");

            var previous = Spawn<ChannelListener>("previous-session");
            previous.Listen(channel);

            // What ending a Play session does: the scene and the connection go, Sync's statics stay.
            Object.DestroyImmediate(previous.gameObject);
            Object.DestroyImmediate(Connection.gameObject);
            yield return null;

            var next = Spawn<ChannelListener>("next-session");
            next.Listen(channel);

            var connection = Object.FindAnyObjectByType<Networking.WebServerConnection>();
            Assert.That(connection != null, Is.True,
                "Registering a listener did not bring the connection back, so this client will never hear anything");

            yield return E2EServer.WaitUntil(() => connection.Status == Networking.ConnectionStatus.Connected,
                "The rebuilt connection never connected", 20f);

            // The server puts the client on its app when it reads the handshake; give that a
            // moment, as the fixture does for its own connection.
            yield return E2EServer.Settle(0.3f);

            Peer.Send(channel, "broadcast::int", "1");
            yield return E2EServer.WaitUntil(() => next.Received == 1,
                "A listener registered after the connection was rebuilt never heard the server");
        }

        [UnityTest]
        public IEnumerator ASingletonAdoptsAnInstanceAlreadyInTheSceneInsteadOfAddingAnother()
        {
            var planted = new GameObject("planted").AddComponent<PlantedSingleton>();
            yield return null;

            Assert.That(ReferenceEquals(PlantedSingleton.Instance, planted), Is.True,
                "A second instance was created alongside the one already in the scene");

            Object.DestroyImmediate(planted.gameObject);
        }
    }
}
