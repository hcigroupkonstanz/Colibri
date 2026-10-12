using System.Collections;
using HCIKonstanz.Colibri.Synchronization;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace HCIKonstanz.Colibri.E2E
{
    /// <summary>
    /// A listener outliving the object that registered it, over a real socket.
    ///
    /// Forgetting <c>Sync.Unregister</c> in <c>OnDestroy</c> used to be quietly expensive: the
    /// delegate keeps calling into a destroyed MonoBehaviour, the first line that touches
    /// <c>transform</c> throws MissingReferenceException, and the exception comes out of
    /// <c>WebServerConnection.Update</c> - discarding every message still queued behind it that
    /// frame. One missing line, and the connection looks like it drops messages at random.
    ///
    /// Colibri now drops those listeners itself. The cases that must keep working matter just as
    /// much as the ones that must stop: a static listener has no Unity lifetime to follow, and
    /// pruning it would be a new bug in place of the old one.
    /// </summary>
    public class ListenerLifetimeTests : ColibriE2EFixture
    {
        /// <summary>Records deliveries in a plain field, which survives the component's destruction.</summary>
        private class CountingListener : MonoBehaviour
        {
            public string Channel;
            public int Received;

            private void Awake() => Sync.Receive<int>(Channel, OnValue);

            private void OnValue(int value) => Received++;
        }

        private class LambdaListener : MonoBehaviour
        {
            public string Channel;
            public int Received;

            // Captures nothing but `this`, which is how most one-line listeners are written.
            private void Awake() => Sync.Receive<int>(Channel, value => Received++);
        }

        /// <summary>The listener that actually throws once its object is gone.</summary>
        private class TransformTouchingListener : MonoBehaviour
        {
            public string Channel;

            private void Awake() => Sync.Receive<int>(Channel, value => transform.position = Vector3.one * value);
        }

        private static int _staticDeliveries;

        private static void CountStatically(int value) => _staticDeliveries++;


        [UnityTest]
        public IEnumerator AListenerStopsWhenItsComponentIsDestroyed()
        {
            var channel = E2EServer.Channel("lifetime");
            var listener = SpawnConfigured<CountingListener>("listener", l => l.Channel = channel);
            yield return null;

            Peer.Send(channel, "broadcast::int", "1");
            yield return E2EServer.WaitUntil(() => listener.Received == 1,
                $"Unity never received the first message on channel '{channel}'");

            Object.DestroyImmediate(listener.gameObject);

            Peer.Send(channel, "broadcast::int", "2");
            yield return E2EServer.Settle();

            Assert.That(listener.Received, Is.EqualTo(1),
                "The listener was still called after its component was destroyed");
        }

        [UnityTest]
        public IEnumerator ALambdaListenerIsDroppedTheSameWay()
        {
            var channel = E2EServer.Channel("lifetime-lambda");
            var listener = SpawnConfigured<LambdaListener>("listener", l => l.Channel = channel);
            yield return null;

            Peer.Send(channel, "broadcast::int", "1");
            yield return E2EServer.WaitUntil(() => listener.Received == 1,
                $"Unity never received the first message on channel '{channel}'");

            Object.DestroyImmediate(listener.gameObject);

            Peer.Send(channel, "broadcast::int", "2");
            yield return E2EServer.Settle();

            Assert.That(listener.Received, Is.EqualTo(1),
                "The lambda was still called after the component it was written in was destroyed");
        }

        /// <summary>
        /// The reason any of this matters. Messages are delivered in a batch, so one orphaned
        /// listener throwing used to cost every message queued behind it in the same frame.
        /// </summary>
        [UnityTest]
        public IEnumerator AnOrphanedListenerDoesNotTakeTheRestOfTheBatchWithIt()
        {
            var orphaned = E2EServer.Channel("orphaned");
            var healthy = E2EServer.Channel("healthy");

            var doomed = SpawnConfigured<TransformTouchingListener>("doomed", l => l.Channel = orphaned);
            var survivor = SpawnConfigured<CountingListener>("survivor", l => l.Channel = healthy);
            yield return null;

            Object.DestroyImmediate(doomed.gameObject);

            // Same socket, so these arrive in this order and, in all likelihood, the same frame.
            Peer.Send(orphaned, "broadcast::int", "1");
            Peer.Send(healthy, "broadcast::int", "2");

            yield return E2EServer.WaitUntil(() => survivor.Received == 1,
                "The message queued behind the orphaned listener never arrived");

            AssertNoErrors();
        }

        [UnityTest]
        public IEnumerator AStaticListenerIsNeverDroppedAutomatically()
        {
            var channel = E2EServer.Channel("static-listener");
            _staticDeliveries = 0;

            Sync.Receive<int>(channel, CountStatically);
            Cleanup.Add(() => Sync.Unregister<int>(channel, CountStatically));

            Peer.Send(channel, "broadcast::int", "1");
            yield return E2EServer.WaitUntil(() => _staticDeliveries == 1,
                $"A static listener stopped receiving on channel '{channel}'");
        }

        /// <summary>
        /// Pruning has to reach the registry too, or the channel keeps claiming a listener that no
        /// longer exists - and every later message on it gets reported as a type mismatch against
        /// a component that has been gone for minutes.
        /// </summary>
        [UnityTest]
        public IEnumerator TheChannelIsForgottenOnceItsLastListenerIsDestroyed()
        {
            var channel = E2EServer.Channel("forgotten");
            var listener = SpawnConfigured<CountingListener>("listener", l => l.Channel = channel);
            yield return null;

            Assert.That(ChannelListenerRegistry.ListenerTypesFor(channel), Is.EquivalentTo(new[] { "int" }));

            Object.DestroyImmediate(listener.gameObject);

            Peer.Send(channel, "broadcast::int", "1");
            yield return E2EServer.Settle();

            Assert.That(ChannelListenerRegistry.ListenerTypesFor(channel), Is.Empty,
                "The channel still counts a listener whose component no longer exists");
        }

        /// <summary>
        /// Reloading a scene registers everything again. Nothing has to arrive on the channel for
        /// the previous scene's listeners to be cleaned up - registering is a sweep of its own.
        /// </summary>
        [UnityTest]
        public IEnumerator RegisteringAgainClearsOutTheDestroyedListeners()
        {
            var channel = E2EServer.Channel("reregistered");

            var first = SpawnConfigured<CountingListener>("first", l => l.Channel = channel);
            yield return null;
            Object.DestroyImmediate(first.gameObject);

            var second = SpawnConfigured<CountingListener>("second", l => l.Channel = channel);
            yield return null;

            Assert.That(ChannelListenerRegistry.ListenerCount(channel, typeof(int)), Is.EqualTo(1),
                "The destroyed listener is still registered alongside the new one");

            Peer.Send(channel, "broadcast::int", "1");
            yield return E2EServer.WaitUntil(() => second.Received == 1,
                $"The replacement listener never received anything on channel '{channel}'");
        }
    }
}
