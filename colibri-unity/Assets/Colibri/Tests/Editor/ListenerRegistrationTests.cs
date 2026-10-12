using System;
using System.Collections.Generic;
using HCIKonstanz.Colibri.Core;
using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Synchronization;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEngine;
using Object = UnityEngine.Object;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// Registering a listener that is already registered. A listener that belongs to nothing that
    /// is ever destroyed - a static method, or a lambda that captures nothing, which the compiler
    /// creates once and hands out again - is the same delegate every time it is registered. Written
    /// in Start, it used to be added once more on every scene reload, and every message was
    /// delivered to it once more each time.
    /// </summary>
    public class ListenerRegistrationTests
    {
        private class Listening : MonoBehaviour
        {
            public int Received;
            public int ReceivedByOther;

            public void OnValue(int value) => Received++;
            public void OnOtherValue(int value) => ReceivedByOther++;
        }

        private static int _staticReceived;

        private static void StaticHandler(int value) => _staticReceived++;

        /// <summary>The listener as it is typically written in Start: a lambda that captures nothing.</summary>
        private static Action<int> CaptureFreeLambda() => value => _staticReceived++;

        private readonly List<Action> _cleanup = new List<Action>();
        private readonly List<GameObject> _gameObjects = new List<GameObject>();
        private static int _channelCounter;

        [SetUp]
        public void Reset()
        {
            _staticReceived = 0;
            ChannelListenerRegistry.Clear();
        }

        [TearDown]
        public void Cleanup()
        {
            foreach (var undo in _cleanup)
                undo();
            _cleanup.Clear();

            foreach (var gameObject in _gameObjects)
            {
                if (gameObject != null)
                    Object.DestroyImmediate(gameObject);
            }
            _gameObjects.Clear();

            ChannelListenerRegistry.Clear();

            // Registering a listener creates the connection singleton, which in edit mode is an
            // inert component on a GameObject in the open scene. It is not this test's to keep.
            foreach (var connection in UnityCompat.FindAll<WebServerConnection>(FindObjectsInactive.Include))
                Object.DestroyImmediate(connection.gameObject);
        }

        private static string NewChannel() => $"registration-test-{++_channelCounter}";


        /*
         *  The same listener twice
         */

        [Test]
        public void AStaticMethodRegisteredAgainIsCalledOnce()
        {
            var channel = NewChannel();

            Register<int>(channel, StaticHandler);
            Register<int>(channel, StaticHandler);
            Sync.OnServerMessage(channel, "broadcast::int", new JValue(1));

            Assert.That(_staticReceived, Is.EqualTo(1), "A static method registered twice was called twice for one message");
            Assert.That(ChannelListenerRegistry.ListenerCount(channel, typeof(int)), Is.EqualTo(1));
        }

        /// <summary>
        /// Start running again after a scene reload: the same code registers the same lambda again.
        /// </summary>
        [Test]
        public void ALambdaThatCapturesNothingRegisteredAgainIsCalledOnce()
        {
            var channel = NewChannel();
            Assert.That(CaptureFreeLambda(), Is.SameAs(CaptureFreeLambda()),
                "Precondition: the compiler hands out one instance of a lambda that captures nothing");

            Register(channel, CaptureFreeLambda());
            Register(channel, CaptureFreeLambda());
            Sync.OnServerMessage(channel, "broadcast::int", new JValue(1));

            Assert.That(_staticReceived, Is.EqualTo(1), "The lambda registered by the second Start was called once more for every message");
            Assert.That(ChannelListenerRegistry.ListenerCount(channel, typeof(int)), Is.EqualTo(1));
        }

        /// <summary>The same object registering the same method twice - from OnEnable, say, with nothing unregistering it in OnDisable.</summary>
        [Test]
        public void TheSameMethodOfTheSameObjectRegisteredAgainIsCalledOnce()
        {
            var channel = NewChannel();
            var listening = Spawn();

            Register<int>(channel, listening.OnValue);
            Register<int>(channel, listening.OnValue);
            Sync.OnServerMessage(channel, "broadcast::int", new JValue(1));

            Assert.That(listening.Received, Is.EqualTo(1));
        }

        [Test]
        public void AModelListenerRegisteredAgainForTheSameObjectIsCalledOnce()
        {
            var channel = NewChannel();
            var received = 0;
            Action<JObject> listener = _ => received++;

            Sync.AddModelUpdateListener(channel, listener, "a");
            Sync.AddModelUpdateListener(channel, listener, "a");
            _cleanup.Add(() => Sync.RemoveModelUpdateListener(channel, listener));

            Sync.OnServerMessage(channel, "model::update", new JObject { { "id", "a" } });

            Assert.That(received, Is.EqualTo(1));
        }

        /// <summary>
        /// Once is once: a listener registered twice is gone after one Unregister, rather than left
        /// behind to be delivered to by itself.
        /// </summary>
        [Test]
        public void OneUnregisterRemovesAListenerRegisteredTwice()
        {
            var channel = NewChannel();

            Sync.Receive<int>(channel, StaticHandler);
            Sync.Receive<int>(channel, StaticHandler);
            Sync.Unregister<int>(channel, StaticHandler);
            Sync.OnServerMessage(channel, "broadcast::int", new JValue(1));

            Assert.That(_staticReceived, Is.Zero, "A listener registered twice was still called after it was unregistered");
            Assert.That(ChannelListenerRegistry.ListenerCount(channel, typeof(int)), Is.Zero);
        }


        /*
         *  Different listeners are still each called
         */

        [Test]
        public void DifferentListenersOnOneChannelAreEachCalled()
        {
            var channel = NewChannel();
            var first = Spawn();
            var second = Spawn();

            Register<int>(channel, first.OnValue);
            Register<int>(channel, first.OnOtherValue);
            Register<int>(channel, second.OnValue);
            Register<int>(channel, StaticHandler);
            Sync.OnServerMessage(channel, "broadcast::int", new JValue(1));

            Assert.That((first.Received, first.ReceivedByOther, second.Received, _staticReceived), Is.EqualTo((1, 1, 1, 1)));
            Assert.That(ChannelListenerRegistry.ListenerCount(channel, typeof(int)), Is.EqualTo(4));
        }

        [Test]
        public void OneListenerOnTwoChannelsIsCalledForEach()
        {
            var first = NewChannel();
            var second = NewChannel();

            Register<int>(first, StaticHandler);
            Register<int>(second, StaticHandler);
            Sync.OnServerMessage(first, "broadcast::int", new JValue(1));
            Sync.OnServerMessage(second, "broadcast::int", new JValue(2));

            Assert.That(_staticReceived, Is.EqualTo(2));
        }


        /*
         *  A new Play session. With domain reload disabled, Sync's statics outlive the session that
         *  filled them; Sync.ResetListeners is what Unity calls at the start of the next one.
         */

        /// <summary>
        /// The previous session's static listener, which this session does not register: it used
        /// to be called all the same, and its type still counted for the mismatch warning.
        /// </summary>
        [Test]
        public void ANewPlaySessionDoesNotCallThePreviousSessionsListeners()
        {
            var channel = NewChannel();
            Register<int>(channel, StaticHandler);

            Sync.ResetListeners();

            // A float on the channel the old int listener was on is nobody's business now: no
            // mismatch warning (any log would fail the test).
            Sync.OnServerMessage(channel, "broadcast::int", new JValue(1));
            Sync.OnServerMessage(channel, "broadcast::float", new JValue(1.5f));

            Assert.That(_staticReceived, Is.Zero, "A listener from the previous Play session was called in this one");
            Assert.That(ChannelListenerRegistry.ListenerCount(channel, typeof(int)), Is.Zero,
                "The previous Play session's listener still counts for the type-mismatch warning");
        }

        [Test]
        public void AListenerRegisteredAgainInANewPlaySessionIsCalledOnce()
        {
            var channel = NewChannel();
            Register(channel, CaptureFreeLambda());

            Sync.ResetListeners();
            Register(channel, CaptureFreeLambda());
            Sync.OnServerMessage(channel, "broadcast::int", new JValue(1));

            Assert.That(_staticReceived, Is.EqualTo(1));
            Assert.That(ChannelListenerRegistry.ListenerCount(channel, typeof(int)), Is.EqualTo(1));
        }

        /// <summary>
        /// A listener owned by an object still goes with the object in the new session, and takes
        /// its count with it.
        /// </summary>
        [Test]
        public void InANewPlaySessionAListenerStillGoesWithItsObject()
        {
            var channel = NewChannel();

            // The previous session, which ends by destroying its objects.
            var previous = Spawn();
            Register<int>(channel, previous.OnValue);
            Object.DestroyImmediate(previous.gameObject);

            Sync.ResetListeners();

            var listening = Spawn();
            Register<int>(channel, listening.OnValue);
            Register<int>(channel, StaticHandler);
            Object.DestroyImmediate(listening.gameObject);

            Sync.OnServerMessage(channel, "broadcast::int", new JValue(1));

            Assert.That((listening.Received, _staticReceived), Is.EqualTo((0, 1)));
            Assert.That(ChannelListenerRegistry.ListenerCount(channel, typeof(int)), Is.EqualTo(1),
                "The destroyed object's listener was not dropped, or took the other listener's count with it");
        }


        /*
         *  Helpers
         */

        private void Register<T>(string channel, Action<T> listener)
        {
            Sync.Receive(channel, listener);
            _cleanup.Add(() => Sync.Unregister(channel, listener));
        }

        private Listening Spawn()
        {
            var gameObject = new GameObject("registration-test-listener");
            _gameObjects.Add(gameObject);
            return gameObject.AddComponent<Listening>();
        }
    }
}
