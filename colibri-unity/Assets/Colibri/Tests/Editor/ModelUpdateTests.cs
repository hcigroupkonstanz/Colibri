using HCIKonstanz.Colibri.Synchronization;
using Newtonsoft.Json.Linq;
using System.Text.RegularExpressions;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;
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

        private class MixedModel : SyncBehaviour<MixedModel>
        {
            [Sync]
            public JObject Data = new JObject { { "kept", true } };

            [Sync]
            public int Count = 7;

            [Sync]
            public string Label = "";

            [Sync]
            public Vector3 Where = new Vector3(1f, 2f, 3f);

            [Sync]
            public float[] Values = { 1f };
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

        /// <summary>
        /// A JObject member that is null on the sender arrives as a JSON null. It used to throw on
        /// every receiver, and the members after it in the update were lost.
        /// </summary>
        [Test]
        public void ANullJObjectIsAppliedAsNullAndTheRestOfTheUpdateToo()
        {
            _gameObject = new GameObject("mixed");
            var model = _gameObject.AddComponent<MixedModel>();
            model.Id = "mixed";

            model.OnModelUpdate(new JObject { { "id", "mixed" }, { "data", JValue.CreateNull() }, { "label", "after" } });

            Assert.That(model.Data, Is.Null);
            Assert.That(model.Label, Is.EqualTo("after"));
        }

        /// <summary>A value that cannot be read, from a web client say, is skipped with a warning.</summary>
        [Test]
        public void AValueThatCannotBeReadIsSkippedAndTheRestOfTheUpdateApplied()
        {
            _gameObject = new GameObject("mixed");
            var model = _gameObject.AddComponent<MixedModel>();
            model.Id = "mixed";

            LogAssert.Expect(LogType.Warning, new Regex("received null for \\[Sync\\] Count"));
            LogAssert.Expect(LogType.Warning, new Regex("received \\[1,2\\] for \\[Sync\\] Data"));
            model.OnModelUpdate(new JObject
            {
                { "id", "mixed" },
                { "count", JValue.CreateNull() },
                { "data", new JArray(1, 2) },
                { "label", "after" },
            });

            Assert.That(model.Count, Is.EqualTo(7));
            Assert.That(model.Data?["kept"]?.Value<bool>(), Is.True);
            Assert.That(model.Label, Is.EqualTo("after"));
        }

        /// <summary>
        /// A vector of the wrong shape was applied as zero: a null pose from a web client moved the
        /// object to the origin. A single value for an array member became an empty array.
        /// </summary>
        [Test]
        public void AVectorOrArrayOfTheWrongShapeIsSkipped()
        {
            _gameObject = new GameObject("mixed");
            var model = _gameObject.AddComponent<MixedModel>();
            model.Id = "mixed";

            LogAssert.Expect(LogType.Warning, new Regex("received null for \\[Sync\\] Where"));
            LogAssert.Expect(LogType.Warning, new Regex("received 5 for \\[Sync\\] Values"));
            model.OnModelUpdate(new JObject { { "id", "mixed" }, { "where", JValue.CreateNull() }, { "values", 5 } });
            // Reported once per member: the second one is skipped without a word.
            model.OnModelUpdate(new JObject { { "id", "mixed" }, { "where", new JArray(1, 2) } });

            Assert.That(model.Where, Is.EqualTo(new Vector3(1f, 2f, 3f)));
            Assert.That(model.Values, Is.EqualTo(new[] { 1f }));
        }
    }
}
