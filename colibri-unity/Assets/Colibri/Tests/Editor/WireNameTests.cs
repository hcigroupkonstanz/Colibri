using System;
using System.Globalization;
using System.Linq;
using System.Threading;
using HCIKonstanz.Colibri.Synchronization;
using NUnit.Framework;
using UnityEngine;
using Object = UnityEngine.Object;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// Channels and [Sync] member names are lowercased C# names, and every client has to arrive at
    /// the same string. Culture-sensitive lowercasing does not: on a Turkish or Azerbaijani system
    /// 'I' becomes a dotless i (U+0131), so a member called "PhysicsId" went out under a name that
    /// colibri-web's <c>toLowerCase()</c> and every other client spell differently, and simply
    /// stopped syncing - no error anywhere.
    /// </summary>
    public class WireNameTests
    {
        // Both names contain a capital I, the one letter that lowercases differently.
        private class InventoryItem : SyncBehaviour<InventoryItem>
        {
            // Only ever written by the sync layer, through reflection, which the compiler cannot
            // see: initialised so it does not warn that the field is never assigned (CS0649).
            [Sync]
            public int ItemIndex = 0;

            [Sync]
            public bool IsVisible { get; set; }
        }

        private class InventoryItemManager : SyncBehaviourManager<InventoryItem>
        {
        }

        private CultureInfo _previousCulture;
        private GameObject _gameObject;

        [SetUp]
        public void UseTurkishCulture()
        {
            _previousCulture = Thread.CurrentThread.CurrentCulture;
            Thread.CurrentThread.CurrentCulture = new CultureInfo("tr-TR");

            // The premise, checked rather than assumed: on a runtime that did not lowercase the
            // Turkish way, every test here would pass without proving anything.
            Assume.That("I".ToLower(), Is.EqualTo("ı"),
                "This runtime does not apply Turkish casing rules, so the culture cannot be exercised here");
        }

        [TearDown]
        public void RestoreCulture()
        {
            Thread.CurrentThread.CurrentCulture = _previousCulture;

            if (_gameObject != null)
                Object.DestroyImmediate(_gameObject);
        }

        [Test]
        public void SyncedMemberNamesAreTheSameOnATurkishSystem()
        {
            var names = SyncBehaviour<InventoryItem>.SyncedNames.OrderBy(n => n, StringComparer.Ordinal).ToArray();

            Assert.That(names, Is.EqualTo(new[] { "isvisible", "itemindex" }));
        }

        /// <summary>
        /// Edit mode does not call Awake, so adding the component only constructs it - which is
        /// exactly when the channel name is built.
        /// </summary>
        [Test]
        public void AModelsChannelIsTheSameOnATurkishSystem()
        {
            _gameObject = new GameObject("wire-name-model");
            var model = _gameObject.AddComponent<InventoryItem>();

            Assert.That(model.Channel, Is.EqualTo("inventoryitem"));
        }

        [Test]
        public void AManagersChannelIsTheSameOnATurkishSystem()
        {
            _gameObject = new GameObject("wire-name-manager");
            var manager = _gameObject.AddComponent<InventoryItemManager>();

            Assert.That(manager.Channel, Is.EqualTo("inventoryitem"),
                "The manager listens on a different channel from the models it is meant to create");
        }
    }
}
