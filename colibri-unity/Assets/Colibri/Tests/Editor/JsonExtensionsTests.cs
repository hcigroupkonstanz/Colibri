using HCIKonstanz.Colibri.Synchronization;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// The conversions every inbound message passes through on its way from JSON to a Unity type.
    ///
    /// These had no tests at all, which is how a colour sent from a web client came to reach Unity
    /// as an <c>InvalidCastException</c> out of <c>WebServerConnection.Update</c> - and, because
    /// that is the frame's single dispatch loop, took every message queued behind it down with it.
    /// A payload of the wrong shape is a routine thing to receive from another implementation: it
    /// has to be reported and skipped, never thrown.
    /// </summary>
    public class JsonExtensionsTests
    {
        private const float Tolerance = 1e-6f;

        [TearDown]
        public void StopIgnoringFailingMessages() => LogAssert.ignoreFailingMessages = false;


        /*
         *  Egress: what Colibri puts on the wire
         */

        [Test]
        public void Vector2SerializesAsAPairOfNumbers()
            => Assert.That(Json(new Vector2(1f, 2f).ToJson()), Is.EqualTo("[1.0,2.0]"));

        [Test]
        public void Vector3SerializesAsATripleOfNumbers()
            => Assert.That(Json(new Vector3(1f, 2f, 3f).ToJson()), Is.EqualTo("[1.0,2.0,3.0]"));

        [Test]
        public void QuaternionSerializesAsXyzw()
            => Assert.That(Json(new Quaternion(0f, 0f, 0f, 1f).ToJson()), Is.EqualTo("[0.0,0.0,0.0,1.0]"));

        [Test]
        public void ColorSerializesAsAnHtmlStringWithAlpha()
            => Assert.That(Color.red.ToJson(), Is.EqualTo("#FF0000FF"));


        /*
         *  Ingress: round-tripping our own wire form
         */

        [Test]
        public void Vector2RoundTrips()
            => AssertVector2(new Vector2(1.5f, -2.5f), new Vector2(1.5f, -2.5f).ToJson().ToVector2());

        [Test]
        public void Vector3RoundTrips()
            => AssertVector3(new Vector3(1.5f, -2.5f, 3.5f), new Vector3(1.5f, -2.5f, 3.5f).ToJson().ToVector3());

        [Test]
        public void QuaternionRoundTrips()
        {
            var expected = new Quaternion(0.5f, -0.5f, 0.5f, 0.5f);

            AssertQuaternion(expected, expected.ToJson().ToQuaternion());
        }

        [Test]
        public void ColorRoundTrips()
            => AssertColor(Color.red, new JValue(Color.red.ToJson()).ToColor());

        /// <summary>
        /// JSON has one number type, so a float that happens to land on a whole number arrives as
        /// an integer token. Rejecting those would break every axis that reaches a round value.
        /// </summary>
        [Test]
        public void IntegerTokensAreAcceptedAsNumbers()
            => AssertVector3(new Vector3(1f, 2f, 3f), new JArray(1, 2, 3).ToVector3());


        /*
         *  Ingress: colibri-web's wire form for a colour, which Unity has to accept too
         */

        [Test]
        public void ColorAcceptsTheRgbaArrayWebClientsSend()
            => AssertColor(Color.red, new JArray(1f, 0f, 0f, 1f).ToColor());

        [Test]
        public void ColorAcceptsAnRgbArrayAndAssumesFullAlpha()
            => AssertColor(Color.red, new JArray(1f, 0f, 0f).ToColor());

        [Test]
        public void ColorAcceptsAnHtmlStringWithoutAlpha()
            => AssertColor(Color.red, new JValue("#FF0000").ToColor());

        [Test]
        public void ColorAcceptsALowercaseHtmlString()
            => AssertColor(Color.red, new JValue("#ff0000ff").ToColor());


        /*
         *  Ingress: payloads of the wrong shape are reported once and skipped, never thrown
         */

        [Test]
        public void AVector3ThatIsNotAnArrayFallsBackToZero()
        {
            ExpectShapeWarning("vector3", "5", 3);

            AssertVector3(Vector3.zero, new JValue(5).ToVector3());
            LogAssert.NoUnexpectedReceived();
        }

        [Test]
        public void AVector3WithTooFewValuesFallsBackToZero()
        {
            ExpectCountWarning("vector3", 2, 3);

            AssertVector3(Vector3.zero, new JArray(1f, 2f).ToVector3());
            LogAssert.NoUnexpectedReceived();
        }

        [Test]
        public void AVector3WithANonNumericValueFallsBackToZero()
        {
            ExpectElementWarning("vector3", 1, "nope");

            AssertVector3(Vector3.zero, new JArray(1f, "nope", 3f).ToVector3());
            LogAssert.NoUnexpectedReceived();
        }

        [Test]
        public void AVector2OfTheWrongShapeFallsBackToZero()
        {
            ExpectCountWarning("vector2", 1, 2);

            AssertVector2(Vector2.zero, new JArray(1f).ToVector2());
            LogAssert.NoUnexpectedReceived();
        }

        [Test]
        public void AQuaternionOfTheWrongShapeFallsBackToIdentity()
        {
            ExpectCountWarning("quaternion", 3, 4);

            AssertQuaternion(Quaternion.identity, new JArray(0f, 0f, 0f).ToQuaternion());
            LogAssert.NoUnexpectedReceived();
        }

        [Test]
        public void AnUnparseableColorStringFallsBackToBlack()
        {
            LogAssert.Expect(LogType.Warning,
                "Colibri: 'chartreuse' is not a colour Unity can parse - expected an HTML colour like \"#RRGGBBAA\". Using black.");

            AssertColor(Color.black, new JValue("chartreuse").ToColor());
            LogAssert.NoUnexpectedReceived();
        }

        [Test]
        public void AColorWithTooFewComponentsFallsBackToBlack()
        {
            ExpectCountWarning("color", 2, 3);

            AssertColor(Color.black, new JArray(1f, 0f).ToColor());
            LogAssert.NoUnexpectedReceived();
        }

        [Test]
        public void AColorThatIsNeitherStringNorArrayFallsBackToBlack()
        {
            ExpectShapeWarning("color", "{}", 3);

            AssertColor(Color.black, new JObject().ToColor());
            LogAssert.NoUnexpectedReceived();
        }

        /// <summary>The exception that started all this: whatever arrives, the call returns.</summary>
        [Test]
        public void NoConversionThrowsForAnyMalformedPayload()
        {
            LogAssert.ignoreFailingMessages = true;

            foreach (var payload in new JToken[] { null, JValue.CreateNull(), new JValue("x"), new JObject(), new JArray() })
            {
                Assert.DoesNotThrow(() => payload.ToVector2());
                Assert.DoesNotThrow(() => payload.ToVector3());
                Assert.DoesNotThrow(() => payload.ToQuaternion());
                Assert.DoesNotThrow(() => payload.ToColor());
            }
        }


        /*
         *  The untyped dispatch behind [Sync], whose field type is only known at runtime
         */

        [TestCase(true, "true")]
        [TestCase(5, "5")]
        [TestCase(1.5f, "1.5")]
        [TestCase("hi", "\"hi\"")]
        public void ObjectDispatchWritesPrimitives(object value, string expected)
            => Assert.That(Json(value.ToJson()), Is.EqualTo(expected));

        [Test]
        public void ObjectDispatchWritesUnityTypes()
        {
            Assert.That(Json(((object)new Vector2(1f, 2f)).ToJson()), Is.EqualTo("[1.0,2.0]"));
            Assert.That(Json(((object)new Vector3(1f, 2f, 3f)).ToJson()), Is.EqualTo("[1.0,2.0,3.0]"));
            Assert.That(Json(((object)new Quaternion(0f, 0f, 0f, 1f)).ToJson()), Is.EqualTo("[0.0,0.0,0.0,1.0]"));
            Assert.That(Json(((object)Color.red).ToJson()), Is.EqualTo("\"#FF0000FF\""));
        }

        [Test]
        public void ObjectDispatchWritesArrays()
        {
            Assert.That(Json(((object)new[] { true, false }).ToJson()), Is.EqualTo("[true,false]"));
            Assert.That(Json(((object)new[] { 1, 2 }).ToJson()), Is.EqualTo("[1,2]"));
            Assert.That(Json(((object)new[] { "a" }).ToJson()), Is.EqualTo("[\"a\"]"));
            Assert.That(Json(((object)new[] { new Vector3(1f, 2f, 3f) }).ToJson()), Is.EqualTo("[[1.0,2.0,3.0]]"));
            Assert.That(Json(((object)new[] { Color.red }).ToJson()), Is.EqualTo("[\"#FF0000FF\"]"));
        }

        [Test]
        public void ObjectDispatchPassesJsonThrough()
        {
            var payload = new JObject { { "a", 1 } };

            Assert.That(((object)payload).ToJson(), Is.SameAs(payload));
        }

        /// <summary>
        /// A <c>[Sync]</c> field of a type Colibri cannot represent is a mistake in the user's own
        /// code, so it has to say so rather than put something unreadable on the wire.
        /// </summary>
        [Test]
        public void ObjectDispatchReportsATypeItCannotRepresent()
        {
            LogAssert.Expect(LogType.Warning, "Cannot synchronize unknown type");

            Assert.That(((object)new Vector4(1f, 2f, 3f, 4f)).ToJson().Value<string>(), Is.EqualTo("UNKNOWN TYPE"));
        }


        /*
         *  Helpers
         */

        private static string Json(JToken token) => token.ToString(Formatting.None);

        private static void ExpectShapeWarning(string typeName, string payload, int minCount)
            => LogAssert.Expect(LogType.Warning,
                $"Colibri: received a {typeName} shaped like '{payload}' - expected an array of {minCount} numbers. Ignoring it.");

        private static void ExpectCountWarning(string typeName, int actual, int minCount)
            => LogAssert.Expect(LogType.Warning,
                $"Colibri: received a {typeName} with {actual} value(s), expected at least {minCount}. Ignoring it.");

        private static void ExpectElementWarning(string typeName, int index, string value)
            => LogAssert.Expect(LogType.Warning,
                $"Colibri: received a {typeName} whose value #{index} is '{value}', not a number. Ignoring it.");

        private static void AssertVector2(Vector2 expected, Vector2 actual)
        {
            Assert.That(actual.x, Is.EqualTo(expected.x).Within(Tolerance));
            Assert.That(actual.y, Is.EqualTo(expected.y).Within(Tolerance));
        }

        private static void AssertVector3(Vector3 expected, Vector3 actual)
        {
            Assert.That(actual.x, Is.EqualTo(expected.x).Within(Tolerance));
            Assert.That(actual.y, Is.EqualTo(expected.y).Within(Tolerance));
            Assert.That(actual.z, Is.EqualTo(expected.z).Within(Tolerance));
        }

        private static void AssertQuaternion(Quaternion expected, Quaternion actual)
        {
            Assert.That(actual.x, Is.EqualTo(expected.x).Within(Tolerance));
            Assert.That(actual.y, Is.EqualTo(expected.y).Within(Tolerance));
            Assert.That(actual.z, Is.EqualTo(expected.z).Within(Tolerance));
            Assert.That(actual.w, Is.EqualTo(expected.w).Within(Tolerance));
        }

        private static void AssertColor(Color expected, Color actual)
        {
            Assert.That(actual.r, Is.EqualTo(expected.r).Within(Tolerance));
            Assert.That(actual.g, Is.EqualTo(expected.g).Within(Tolerance));
            Assert.That(actual.b, Is.EqualTo(expected.b).Within(Tolerance));
            Assert.That(actual.a, Is.EqualTo(expected.a).Within(Tolerance));
        }
    }
}
