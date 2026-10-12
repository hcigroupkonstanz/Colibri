using System.Collections.Generic;
using HCIKonstanz.Colibri.Core;
using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Synchronization;
using NUnit.Framework;
using UnityEngine;
using Object = UnityEngine.Object;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// What a client remembers of the models it deleted itself, so that its managers do not build
    /// one again from an update another client sent before the server had the delete.
    /// SyncModelTests checks that against a server.
    /// </summary>
    public class LocallyDeletedModelsTests
    {
        private class DeletableModel : SyncBehaviour<DeletableModel>
        {
            [Sync]
            public string Label = "";

            /// <summary>Edit mode calls none of these itself.</summary>
            public void Wake() => Awake();
            public void RunOnApplicationQuit() => OnApplicationQuit();
            public void RunOnDestroy() => OnDestroy();
        }

        private readonly List<GameObject> _gameObjects = new List<GameObject>();

        [SetUp]
        public void ForgetEverything() => LocallyDeletedModels.Reset();

        [TearDown]
        public void Cleanup()
        {
            foreach (var gameObject in _gameObjects)
            {
                if (gameObject != null)
                    Object.DestroyImmediate(gameObject);
            }
            _gameObjects.Clear();

            // Awake registers listeners and OnDestroy sends the delete, and that creates the
            // connection singleton - in edit mode an inert component on a GameObject in the open
            // scene. It is not this test's to keep.
            foreach (var connection in UnityCompat.FindAll<WebServerConnection>(FindObjectsInactive.Include))
                Object.DestroyImmediate(connection.gameObject);

            LocallyDeletedModels.Reset();
        }

        private DeletableModel SpawnModel()
        {
            var gameObject = new GameObject("deletable-model");
            _gameObjects.Add(gameObject);
            var model = gameObject.AddComponent<DeletableModel>();
            model.Wake();
            return model;
        }

        [Test]
        public void ADeleteIsRememberedForTheWindowAndNoLonger()
        {
            LocallyDeletedModels.Remember("channel", "x", 100.0);

            Assert.That(LocallyDeletedModels.Contains("channel", "x", 100.0), Is.True);
            Assert.That(LocallyDeletedModels.Contains("channel", "x", 100.0 + LocallyDeletedModels.WindowSeconds - 0.1), Is.True);
            Assert.That(LocallyDeletedModels.Contains("channel", "x", 100.0 + LocallyDeletedModels.WindowSeconds), Is.False);
        }

        [Test]
        public void ADeleteIsRememberedForItsChannelAndIdOnly()
        {
            LocallyDeletedModels.Remember("channel", "x", 0.0);

            Assert.That(LocallyDeletedModels.Contains("other-channel", "x", 1.0), Is.False);
            Assert.That(LocallyDeletedModels.Contains("channel", "y", 1.0), Is.False);
        }

        [Test]
        public void AForgottenDeleteIsNotRemembered()
        {
            LocallyDeletedModels.Remember("channel", "x", 0.0);
            LocallyDeletedModels.Forget("channel", "x");

            Assert.That(LocallyDeletedModels.Contains("channel", "x", 1.0), Is.False);
        }

        /// <summary>A scene of thousands of objects unloaded once a minute must not add up.</summary>
        [Test]
        public void ExpiredDeletesAreDroppedAsNewOnesAreRemembered()
        {
            for (var i = 0; i < 1000; i++)
                LocallyDeletedModels.Remember("channel", $"old-{i}", 0.0);

            LocallyDeletedModels.Remember("channel", "new", LocallyDeletedModels.WindowSeconds + 1.0);

            Assert.That(LocallyDeletedModels.Count, Is.EqualTo(1));
        }

        /// <summary>The id deleted twice is remembered from the second delete, not dropped with the first.</summary>
        [Test]
        public void ADeleteRememberedAgainCountsFromTheLaterOne()
        {
            LocallyDeletedModels.Remember("channel", "x", 0.0);
            LocallyDeletedModels.Remember("channel", "x", 50.0);
            LocallyDeletedModels.Remember("channel", "y", LocallyDeletedModels.WindowSeconds + 1.0);

            Assert.That(LocallyDeletedModels.Contains("channel", "x", LocallyDeletedModels.WindowSeconds + 2.0), Is.True);
        }

        /// <summary>
        /// What Sync sends again when it notices an outage: the deletes made from a given time on,
        /// once each and in the order they were made, except one forgotten since.
        /// </summary>
        [Test]
        public void TheDeletesSinceATimeAreThoseMadeFromThenOnAndNotForgotten()
        {
            LocallyDeletedModels.Remember("channel", "long before", 100.0);
            LocallyDeletedModels.Remember("channel", "deleted twice", 150.0);
            LocallyDeletedModels.Remember("channel", "at the drop", 200.0);
            LocallyDeletedModels.Remember("other-channel", "just after", 200.5);
            LocallyDeletedModels.Remember("channel", "deleted twice", 200.6);
            LocallyDeletedModels.Remember("channel", "created here again", 200.7);
            LocallyDeletedModels.Forget("channel", "created here again");

            Assert.That(LocallyDeletedModels.Since(199.0, now: 202.0), Is.EqualTo(new[]
            {
                ("channel", "at the drop"),
                ("other-channel", "just after"),
                ("channel", "deleted twice"),
            }));
            Assert.That(LocallyDeletedModels.Since(300.0, now: 302.0), Is.Null);
        }

        /// <summary>
        /// Only the deletes remembered still: one older than the window, or one made before the
        /// clock started again, is left out, as in Contains, even while nothing has been remembered
        /// since to drop it. Sent again, it would delete an object another client has created under
        /// the id in the meantime.
        /// </summary>
        [Test]
        public void TheDeletesSinceATimeLeaveOutThoseNoLongerRemembered()
        {
            LocallyDeletedModels.Remember("channel", "older than the window", 100.0);
            LocallyDeletedModels.Remember("channel", "within the window", 150.0);

            Assert.That(LocallyDeletedModels.Since(0.0, now: 100.0 + LocallyDeletedModels.WindowSeconds + 1.0),
                Is.EqualTo(new[] { ("channel", "within the window") }));
            Assert.That(LocallyDeletedModels.Since(0.0, now: 5.0), Is.Null, "Both were made before the clock started again");
        }

        /// <summary>A clock behind a delete has started again since, which no delete outlives.</summary>
        [Test]
        public void NothingIsRememberedFromBeforeTheClockStartedAgain()
        {
            LocallyDeletedModels.Remember("channel", "x", 500.0);

            Assert.That(LocallyDeletedModels.Contains("channel", "x", 1.0), Is.False);
        }

        [Test]
        public void DestroyingAnObjectRemembersItsDelete()
        {
            var model = SpawnModel();

            model.RunOnDestroy();

            Assert.That(LocallyDeletedModels.Contains(model.Channel, model.Id), Is.True);
        }

        /// <summary>Shutting down is not deleting, so it sends no delete and has none to remember.</summary>
        [Test]
        public void QuittingRemembersNoDelete()
        {
            var model = SpawnModel();

            model.RunOnApplicationQuit();
            model.RunOnDestroy();

            Assert.That(LocallyDeletedModels.Contains(model.Channel, model.Id), Is.False);
        }

        /// <summary>
        /// An object with the id in this client's scene again - a scene with placed objects of
        /// fixed ids loaded once more - takes updates for it again, and so may a manager.
        /// </summary>
        [Test]
        public void AnObjectCreatedHereAgainUnderTheIdEndsTheDelete()
        {
            var deleted = SpawnModel();
            deleted.RunOnDestroy();

            var gameObject = new GameObject("created-again");
            _gameObjects.Add(gameObject);
            var again = gameObject.AddComponent<DeletableModel>();
            again.Id = deleted.Id;
            again.Wake();

            Assert.That(LocallyDeletedModels.Contains(deleted.Channel, deleted.Id), Is.False);
        }
    }
}
