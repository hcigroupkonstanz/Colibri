using HCIKonstanz.Colibri.Synchronization;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEngine;
using Object = UnityEngine.Object;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// A model's state arriving before the model has run Awake - which is where its type's table
    /// of [Sync] members used to be built, and nowhere else. A SyncBehaviourManager hands the
    /// first update to a fresh clone straight away, so for the first object of a type this was
    /// the normal case rather than an edge.
    /// </summary>
    public class ModelUpdateTests
    {
        /// <summary>
        /// Used by this test alone. The member table is built once per type, so if anything else
        /// woke one of these first, the test would pass without proving anything.
        /// </summary>
        private class NeverWokenModel : SyncBehaviour<NeverWokenModel>
        {
            [Sync]
            public string Label = "";

            [Sync]
            public Vector3 Where { get; set; }
        }

        private GameObject _gameObject;

        [TearDown]
        public void DestroyObject()
        {
            if (_gameObject != null)
                Object.DestroyImmediate(_gameObject);
        }

        /// <summary>Edit mode does not call Awake, so this model never wakes.</summary>
        [Test]
        public void AnUpdateIsAppliedToAModelBeforeAnyOfItsTypeHasWoken()
        {
            _gameObject = new GameObject("never-woken");
            var model = _gameObject.AddComponent<NeverWokenModel>();
            model.Id = "from-elsewhere";

            model.OnModelUpdate(new JObject
            {
                { "id", "from-elsewhere" },
                { "label", "from the server" },
                { "where", new JArray(1f, 2f, 3f) }
            });

            Assert.That(model.Label, Is.EqualTo("from the server"));
            Assert.That(model.Where, Is.EqualTo(new Vector3(1f, 2f, 3f)));
        }
    }
}
