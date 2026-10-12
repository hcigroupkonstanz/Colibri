using System.Collections.Generic;
using HCIKonstanz.Colibri.Synchronization;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEngine;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// Unity's vector, quaternion and colour types in a class of one's own, through Newtonsoft.
    /// Newtonsoft on its own cannot write them: it follows Vector3.normalized, a Vector3 again,
    /// and stops with "Self referencing loop detected" - so the Store could not save such a class,
    /// and JToken.FromObject could not put one into a [Sync] JObject.
    /// </summary>
    public class ColibriJsonTests
    {
        public class Placement
        {
            public string Name;
            public Vector2 Anchor;
            public Vector3 Position;
            public Vector4 Tangent;
            public Quaternion Rotation;
            public Color Tint;
            public List<Vector3> Path = new List<Vector3>();
            public Color[] Palette;
            public Vector3? Target;
            public Vector3? Unset;
        }

        internal static Placement Sample() => new Placement
        {
            Name = "lamp",
            Anchor = new Vector2(0.5f, -1.25f),
            Position = new Vector3(1.5f, 2f, -3.25f),
            Tangent = new Vector4(1f, 0f, 0f, -1f),
            Rotation = new Quaternion(0.1f, 0.2f, 0.3f, 0.9f),
            // Not on an 8-bit step, and above 1: the "#RRGGBBAA" form would lose both.
            Tint = new Color(0.3f, 0.6f, 0.9f, 2.5f),
            Path = new List<Vector3> { new Vector3(0f, 0f, 0f), new Vector3(1f, 1f, 1f) },
            Palette = new[] { new Color(1f, 0f, 0f, 1f), new Color(0f, 0f, 1f, 0.5f) },
            Target = new Vector3(4f, 5f, 6f),
            Unset = null
        };

        internal static void AssertSameAsSample(Placement loaded)
        {
            var saved = Sample();

            Assert.That(loaded.Name, Is.EqualTo(saved.Name));
            Assert.That(loaded.Anchor, Is.EqualTo(saved.Anchor));
            Assert.That(loaded.Position, Is.EqualTo(saved.Position));
            Assert.That(loaded.Tangent, Is.EqualTo(saved.Tangent));
            Assert.That(loaded.Rotation, Is.EqualTo(saved.Rotation));
            Assert.That(loaded.Tint, Is.EqualTo(saved.Tint));
            Assert.That(loaded.Path, Is.EqualTo(saved.Path));
            Assert.That(loaded.Palette, Is.EqualTo(saved.Palette));
            Assert.That(loaded.Target, Is.EqualTo(saved.Target));
            Assert.That(loaded.Unset, Is.Null);
        }

        private static string Compact(JToken token) => token.ToString(Formatting.None);

        [Test]
        public void AClassWithUnityTypesRoundTrips()
        {
            var settings = ColibriJson.CreateSettings();
            var json = JsonConvert.SerializeObject(Sample(), settings);

            AssertSameAsSample(JsonConvert.DeserializeObject<Placement>(json, settings));
        }

        /// <summary>
        /// The shapes [Sync] and Sync.Send use, which colibri-web's types describe - so a web
        /// client reading the same data gets what it gets everywhere else.
        /// </summary>
        [Test]
        public void UnityTypesAreWrittenAsArraysOfTheirComponents()
        {
            var saved = JObject.Parse(JsonConvert.SerializeObject(Sample(), ColibriJson.CreateSettings()));

            Assert.That(Compact(saved["Anchor"]), Is.EqualTo("[0.5,-1.25]"));
            Assert.That(Compact(saved["Position"]), Is.EqualTo("[1.5,2.0,-3.25]"));
            Assert.That(Compact(saved["Tangent"]), Is.EqualTo("[1.0,0.0,0.0,-1.0]"));
            Assert.That(saved["Rotation"].ToObject<float[]>(), Is.EqualTo(new[] { 0.1f, 0.2f, 0.3f, 0.9f }));
            Assert.That(saved["Tint"].ToObject<float[]>(), Is.EqualTo(new[] { 0.3f, 0.6f, 0.9f, 2.5f }));
            Assert.That(Compact(saved["Path"]), Is.EqualTo("[[0.0,0.0,0.0],[1.0,1.0,1.0]]"));
            Assert.That(saved["Unset"].Type, Is.EqualTo(JTokenType.Null));
        }

        /// <summary>
        /// Objects with named components are how JsonUtility - and so Colibri 1.x's Store - wrote
        /// these types, and a colour may come as the "#RRGGBBAA" a [Sync] Color travels as.
        /// </summary>
        [Test]
        public void TheOtherCommonShapesAreReadToo()
        {
            const string json = @"{
                ""Anchor"": { ""x"": 1, ""y"": 2 },
                ""Position"": { ""x"": 1.5, ""y"": 2, ""z"": 3 },
                ""Rotation"": { ""x"": 0, ""y"": 0, ""z"": 0, ""w"": 1 },
                ""Tint"": ""#FF000080"",
                ""Palette"": [ [0, 1, 0], { ""r"": 0, ""g"": 0, ""b"": 1, ""a"": 0.5 } ]
            }";

            var loaded = JsonConvert.DeserializeObject<Placement>(json, ColibriJson.CreateSettings());

            Assert.That(loaded.Anchor, Is.EqualTo(new Vector2(1f, 2f)));
            Assert.That(loaded.Position, Is.EqualTo(new Vector3(1.5f, 2f, 3f)));
            Assert.That(loaded.Rotation, Is.EqualTo(new Quaternion(0f, 0f, 0f, 1f)));
            Assert.That(loaded.Tint.r, Is.EqualTo(1f));
            Assert.That(loaded.Tint.a, Is.EqualTo(128f / 255f).Within(1e-6));
            Assert.That(loaded.Palette, Is.EqualTo(new[] { new Color(0f, 1f, 0f, 1f), new Color(0f, 0f, 1f, 0.5f) }),
                "An [r, g, b] colour without alpha is opaque");
        }

        /// <summary>A [Sync] JObject member, or Sync.Send(channel, JToken), built from such a class.</summary>
        [Test]
        public void TheSerializerConvertsUnityTypesToAndFromJObjects()
        {
            var token = JObject.FromObject(Sample(), ColibriJson.Serializer);

            Assert.That(Compact(token["Position"]), Is.EqualTo("[1.5,2.0,-3.25]"));
            AssertSameAsSample(token.ToObject<Placement>(ColibriJson.Serializer));
        }

        [Test]
        public void AValueOfTheWrongShapeIsReportedWithWhereItIs()
        {
            var e = Assert.Throws<JsonSerializationException>(
                () => JsonConvert.DeserializeObject<Placement>("{ \"Path\": [[1, 2, 3], [1, 2]] }", ColibriJson.CreateSettings()));

            Assert.That(e.Message, Does.Contain("'[1,2]' at 'Path[1]' is not a Vector3"));
        }

        [Test]
        public void NullIsOnlyReadIntoANullableType()
        {
            var settings = ColibriJson.CreateSettings();

            Assert.That(JsonConvert.DeserializeObject<Placement>("{ \"Target\": null }", settings).Target, Is.Null);
            Assert.Throws<JsonSerializationException>(() => JsonConvert.DeserializeObject<Placement>("{ \"Position\": null }", settings));
        }
    }
}
