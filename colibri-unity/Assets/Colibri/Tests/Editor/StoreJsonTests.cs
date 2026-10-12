using System.Collections.Generic;
using System.Text.RegularExpressions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;
using ColibriStore = HCIKonstanz.Colibri.Store.Store;
using Placement = HCIKonstanz.Colibri.Tests.ColibriJsonTests.Placement;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// What the Store makes of a value on the way to the server and back, without the server.
    /// A value Newtonsoft could not convert threw a JsonException out of Put, or out of Get after
    /// the request had succeeded - past the await, into code written against a Store that logs
    /// what went wrong and answers false or default.
    /// </summary>
    public class StoreJsonTests
    {
        [Test]
        public void AClassWithUnityTypesRoundTrips()
        {
            Assert.That(ColibriStore.TryToJson("placement", ColibriJsonTests.Sample(), out var json), Is.True);
            Assert.That(ColibriStore.TryFromJson<Placement>("placement", json, out var loaded), Is.True);

            ColibriJsonTests.AssertSameAsSample(loaded);
        }

        /// <summary>
        /// A saved timestamp loads as the string it was. Newtonsoft's default read it as a DateTime
        /// wherever the type does not say what to expect, and a JToken, an object or a dictionary
        /// of them then held "10/08/2026 12:00:00", or the time moved into this device's time zone.
        /// </summary>
        [Test]
        public void ATimestampStringLoadsExactlyAsItWasSaved()
        {
            const string timestamp = "2026-10-08T12:00:00.1234567+02:00";
            const string json = "{\"started\":\"" + timestamp + "\"}";

            Assert.That(ColibriStore.TryFromJson<JToken>("trial", json, out var token), Is.True);
            Assert.That(token["started"].Type, Is.EqualTo(JTokenType.String));
            Assert.That(token.ToString(Formatting.None), Is.EqualTo(json));

            Assert.That(ColibriStore.TryFromJson<Dictionary<string, object>>("trial", json, out var values), Is.True);
            Assert.That(values["started"], Is.EqualTo(timestamp));

            Assert.That(ColibriStore.TryFromJson<Dictionary<string, string>>("trial", json, out var strings), Is.True);
            Assert.That(strings["started"], Is.EqualTo(timestamp));

            Assert.That(ColibriStore.TryFromJson<string>("trial", "\"" + timestamp + "\"", out var text), Is.True);
            Assert.That(text, Is.EqualTo(timestamp));
        }

        /// <summary>The counterpart: asked for as a date, it is still read as one.</summary>
        [Test]
        public void ATimestampLoadsAsADateWhereTheTypeAsksForOne()
        {
            Assert.That(ColibriStore.TryFromJson<System.DateTimeOffset>("trial", "\"2026-10-08T12:00:00.5+02:00\"", out var started), Is.True);
            Assert.That(started, Is.EqualTo(new System.DateTimeOffset(2026, 10, 8, 12, 0, 0, 500, System.TimeSpan.FromHours(2))));
            Assert.That(started.Offset, Is.EqualTo(System.TimeSpan.FromHours(2)));

            Assert.That(ColibriStore.TryFromJson<Dictionary<string, System.DateTime>>("trial", "{\"started\":\"2026-10-08T12:00:00Z\"}", out var dates), Is.True);
            Assert.That(dates["started"], Is.EqualTo(new System.DateTime(2026, 10, 8, 12, 0, 0, System.DateTimeKind.Utc)));
            Assert.That(dates["started"].Kind, Is.EqualTo(System.DateTimeKind.Utc));
        }

        [Test]
        public void SomethingThatIsNotJsonLoadsAsDefaultAndSaysSo()
        {
            LogAssert.Expect(LogType.Error, new Regex("^Colibri: could not load \"broken\" as Placement - "));

            Assert.That(ColibriStore.TryFromJson<Placement>("broken", "{ \"Name\": ", out var loaded), Is.False);
            Assert.That(loaded, Is.Null);
        }

        [Test]
        public void AValueThatDoesNotFitTheTypeLoadsAsDefaultAndSaysSo()
        {
            LogAssert.Expect(LogType.Error, new Regex("^Colibri: could not load \"scores\" as List<Int32> - "));

            Assert.That(ColibriStore.TryFromJson<List<int>>("scores", "{ \"not\": \"a list\" }", out var loaded), Is.False);
            Assert.That(loaded, Is.Null);
        }

        [Test]
        public void AVectorOfTheWrongShapeLoadsAsDefaultAndSaysWhere()
        {
            LogAssert.Expect(LogType.Error, new Regex("^Colibri: could not load \"placement\" as Placement - .*'\\[1,2\\]' at 'Position' is not a Vector3"));

            Assert.That(ColibriStore.TryFromJson<Placement>("placement", "{ \"Position\": [1, 2] }", out var loaded), Is.False);
            Assert.That(loaded, Is.Null);
        }

        private class Loop
        {
            public Loop Next;
        }

        [Test]
        public void AValueThatCannotBeConvertedIsNotSavedAndSaysSo()
        {
            var loop = new Loop();
            loop.Next = loop;

            LogAssert.Expect(LogType.Error, new Regex("^Colibri: could not save \"loop\" - Loop cannot be converted to JSON: "));

            Assert.That(ColibriStore.TryToJson("loop", loop, out var json), Is.False);
            Assert.That(json, Is.Null);
        }
    }
}
