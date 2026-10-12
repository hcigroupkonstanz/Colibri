using System;
using System.IO;
using HCIKonstanz.Colibri.Synchronization;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEngine;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// The decision behind the answers to the request a model makes again after a reconnect: the
    /// server's value for one member, held against the values that member sent recently. What the
    /// model then does with the verdict is in <see cref="ModelResyncTests"/>.
    /// </summary>
    public class SentValuesTests
    {
        private const double Always = double.NegativeInfinity;

        /// <summary>The values in the order they were sent, one second apart from 100 on.</summary>
        private static SentValues Sent(params JToken[] values)
        {
            var sent = new SentValues();
            for (var i = 0; i < values.Length; i++)
                Send(sent, values[i], 100 + i);
            return sent;
        }

        /// <summary>
        /// A value sent at <paramref name="time"/> over a connection that works: this client heard
        /// from the server at that moment.
        /// </summary>
        private static void Send(SentValues sent, JToken value, double time) => sent.Remember(value, time, heardAt: time);

        /// <summary>
        /// A value as an answer from the server carries it: JSON the server wrote, read the way the
        /// connection reads every payload, with dates left as strings.
        /// </summary>
        private static JToken Wire(string json)
        {
            using (var reader = new JsonTextReader(new StringReader(json)) { DateParseHandling = DateParseHandling.None })
                return JToken.ReadFrom(reader);
        }


        /*
         *  The four cases
         */

        [Test]
        public void TheValueSentLastHasArrived()
            => Assert.That(Sent("a", "b").Judge(Wire("\"b\""), Always), Is.EqualTo(SentValues.Verdict.Arrived));

        [Test]
        public void AValueSentBeforeTheLastOneMeansTheLastOneWasLost()
            => Assert.That(Sent("a", "b").Judge(Wire("\"a\""), Always), Is.EqualTo(SentValues.Verdict.Lost));

        [Test]
        public void AValueThisMemberNeverSentWasSetByAnotherClient()
            => Assert.That(Sent("a", "b").Judge(Wire("\"c\""), Always), Is.EqualTo(SentValues.Verdict.ChangedElsewhere));

        [Test]
        public void AMemberThatSentNothingHasNothingToJudge()
            => Assert.That(new SentValues().Judge(Wire("\"a\""), Always), Is.EqualTo(SentValues.Verdict.NotSentRecently));

        /// <summary>
        /// Back to an earlier value and sent again: the newest send decides. The server holding it
        /// is the server holding what this client shows, whichever of the sends arrived.
        /// </summary>
        [Test]
        public void AValueSentAgainLastCountsAsTheLastOne()
            => Assert.That(Sent("a", "b", "a").Judge(Wire("\"a\""), Always), Is.EqualTo(SentValues.Verdict.Arrived));


        /*
         *  Which values count
         */

        /// <summary>
        /// Over a connection that works, the ninth value sent drops the first, which stays known as
        /// the value held before the oldest one kept. The tenth drops that for good.
        /// </summary>
        [Test]
        public void TheLastEightValuesAndTheOneBeforeThemAreKept()
        {
            var sent = Sent("v0", "v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8");

            Assert.That(sent.Judge(Wire("\"v1\""), Always), Is.EqualTo(SentValues.Verdict.Lost));
            Assert.That(sent.Judge(Wire("\"v0\""), Always), Is.EqualTo(SentValues.Verdict.Lost),
                "The value dropped was held before the oldest one kept");

            Send(sent, "v9", 109);
            Assert.That(sent.Judge(Wire("\"v1\""), Always), Is.EqualTo(SentValues.Verdict.Lost));
            Assert.That(sent.Judge(Wire("\"v0\""), Always), Is.EqualTo(SentValues.Verdict.ChangedElsewhere),
                "The tenth value sent should have dropped the first for good");
        }

        /// <summary>
        /// Of what was sent before the window, only the newest counts: the value the member held
        /// when the window began. One sent before that cannot tell a lost change from another
        /// client's: set back to it by someone else, it would look as if everything after it had
        /// been lost.
        /// </summary>
        [Test]
        public void OfTheValuesSentBeforeTheWindowOnlyTheOneHeldWhenItBeganCounts()
        {
            var sent = Sent("a", "b", "c"); // at 100, 101 and 102

            Assert.That(sent.Judge(Wire("\"c\""), since: 101.5), Is.EqualTo(SentValues.Verdict.Arrived));
            Assert.That(sent.Judge(Wire("\"b\""), since: 101.5), Is.EqualTo(SentValues.Verdict.Lost),
                "b was held when the window began, so c was lost");
            Assert.That(sent.Judge(Wire("\"a\""), since: 101.5), Is.EqualTo(SentValues.Verdict.ChangedElsewhere),
                "a had been replaced before the window began, so someone else set it");
            Assert.That(sent.Judge(Wire("\"c\""), since: 103), Is.EqualTo(SentValues.Verdict.NotSentRecently));
        }

        /// <summary>
        /// The case this is for: switched on long ago, switched off at the drop. Only the switch-off
        /// was sent in the window, and the answer holding the value from before it means it was lost.
        /// </summary>
        [Test]
        public void AfterAQuietSpellTheValueHeldWhenTheWindowBeganCounts()
        {
            var sent = new SentValues();
            Send(sent, true, 100);
            Send(sent, false, 200);

            Assert.That(sent.Judge(Wire("true"), since: 190), Is.EqualTo(SentValues.Verdict.Lost));
            Assert.That(sent.Judge(Wire("false"), since: 190), Is.EqualTo(SentValues.Verdict.Arrived));
        }

        /// <summary>
        /// Dropped to make room for values sent in the window, the value from before them still
        /// counts: it is what the member held when the window began, or one it sent in the window.
        /// </summary>
        [Test]
        public void ADroppedValueCountsAsTheOneHeldBeforeTheOldestKept()
        {
            var sent = new SentValues();
            Send(sent, "held for a minute", 100);
            for (var i = 0; i < SentValues.Capacity; i++)
                Send(sent, $"moved {i}", 200 + i * 0.1);

            Assert.That(sent.Judge(Wire("\"held for a minute\""), since: 190), Is.EqualTo(SentValues.Verdict.Lost));
            Assert.That(sent.Judge(Wire("\"moved 0\""), since: 190), Is.EqualTo(SentValues.Verdict.Lost));
            Assert.That(sent.Judge(Wire("\"elsewhere\""), since: 190), Is.EqualTo(SentValues.Verdict.ChangedElsewhere));
        }

        /// <summary>
        /// Moved at 30 updates a second from 199 on, to x1 ... x90, while the server was last heard
        /// from at 200, right after x30 was sent. The link died a moment later, and the outage was
        /// noticed at 202.
        /// </summary>
        private static SentValues MovedAcrossTheDrop()
        {
            var sent = new SentValues();
            for (var i = 1; i <= 90; i++)
            {
                var time = 199 + i / 30.0;
                sent.Remember($"x{i}", time, heardAt: Math.Min(time, 200));
            }
            return sent;
        }

        /// <summary>
        /// Everything sent after the server was last heard from went into the dead link, 60 values
        /// here, and the server has one sent around then. The first values sent after that time are
        /// kept, as are the latest before it, so it is recognised however many follow.
        /// </summary>
        [Test]
        public void AroundTheTimeTheServerWasLastHeardFromValuesAreKeptHoweverManyFollow()
        {
            var sent = MovedAcrossTheDrop();
            const double since = 202 - 10;

            Assert.That(sent.Judge(Wire("\"x90\""), since), Is.EqualTo(SentValues.Verdict.Arrived));
            foreach (var kept in new[] { "x22", "x23", "x30", "x31", "x32", "x38" })
                Assert.That(sent.Judge(Wire($"\"{kept}\""), since), Is.EqualTo(SentValues.Verdict.Lost), kept);

            // The limit: the ninth value after the server was last heard from, and those up to the
            // newest, are not kept.
            Assert.That(sent.Judge(Wire("\"x39\""), since), Is.EqualTo(SentValues.Verdict.ChangedElsewhere));
            Assert.That(sent.Judge(Wire("\"x89\""), since), Is.EqualTo(SentValues.Verdict.ChangedElsewhere));
            Assert.That(sent.Judge(Wire("\"x21\""), since), Is.EqualTo(SentValues.Verdict.ChangedElsewhere));
        }

        /// <summary>
        /// Heard from again, the server has had everything sent up to then: of that, only the latest
        /// values are kept, as over a connection that works.
        /// </summary>
        [Test]
        public void OnceTheServerIsHeardFromAgainOnlyTheLatestValuesAreKept()
        {
            var sent = MovedAcrossTheDrop();

            sent.Remember("later", 210, heardAt: 209.9);

            Assert.That(sent.Judge(Wire("\"later\""), Always), Is.EqualTo(SentValues.Verdict.Arrived));
            Assert.That(sent.Judge(Wire("\"x90\""), Always), Is.EqualTo(SentValues.Verdict.Lost));
            Assert.That(sent.Judge(Wire("\"x32\""), Always), Is.EqualTo(SentValues.Verdict.Lost));
            Assert.That(sent.Judge(Wire("\"x31\""), Always), Is.EqualTo(SentValues.Verdict.Lost),
                "The value before the oldest one kept");
            Assert.That(sent.Judge(Wire("\"x30\""), Always), Is.EqualTo(SentValues.Verdict.ChangedElsewhere));
        }

        /// <summary>
        /// Not while the answers to the requests made again after a reconnect are coming in: they
        /// hold what the server had before it read anything sent after the requests, and hearing
        /// from the server on the new connection says nothing about what went into the dead one.
        /// The values kept when the requests went out stay, and of those sent since, the newest is
        /// kept besides. Once the answers are in, the values follow the last-heard time again.
        /// </summary>
        [Test]
        public void UntilTheAnswersAreInTheValuesKeptWhenTheRequestsWentOutStay()
        {
            var sent = MovedAcrossTheDrop();
            sent.KeepUntilAnswered();

            sent.Remember("moved on", 210, heardAt: 209.9, answersPending: true);
            sent.Remember("moved on again", 210.1, heardAt: 210, answersPending: true);

            foreach (var kept in new[] { "x22", "x23", "x30", "x31", "x38", "x90" })
                Assert.That(sent.Judge(Wire($"\"{kept}\""), Always), Is.EqualTo(SentValues.Verdict.Lost), kept);
            Assert.That(sent.Judge(Wire("\"moved on again\""), Always), Is.EqualTo(SentValues.Verdict.Arrived));

            sent.Remember("after the answers", 211, heardAt: 210.9);
            Assert.That(sent.Judge(Wire("\"x31\""), Always), Is.EqualTo(SentValues.Verdict.ChangedElsewhere),
                "Once the answers are in, only the latest values sent by the time the server was last heard from are kept");
        }

        /// <summary>
        /// A round that follows one whose answers never came keeps that one's values, and the newest
        /// sent in between, in the same slots: should they fill every one, the oldest goes.
        /// </summary>
        [Test]
        public void ARoundAfterOneWhoseAnswersNeverCameKeepsTheValuesOfBoth()
        {
            var sent = MovedAcrossTheDrop();
            sent.KeepUntilAnswered();
            sent.Remember("sent on the second link", 210, heardAt: 210, answersPending: true);

            sent.KeepUntilAnswered();
            sent.Remember("sent on the third link", 220, heardAt: 220, answersPending: true);

            foreach (var kept in new[] { "x23", "x31", "x38", "x90", "sent on the second link" })
                Assert.That(sent.Judge(Wire($"\"{kept}\""), Always), Is.EqualTo(SentValues.Verdict.Lost), kept);
            Assert.That(sent.Judge(Wire("\"sent on the third link\""), Always), Is.EqualTo(SentValues.Verdict.Arrived));
        }

        /// <summary>
        /// Once the member has taken a value from elsewhere, what it sent before says nothing about
        /// the server any more. The value it took does: the server held it, and holding it still
        /// after the member's next change means that change was lost.
        /// </summary>
        [Test]
        public void TakingAValueForgetsWhatWasSentAndKeepsTheValueTaken()
        {
            var sent = Sent("a", "b");
            sent.ServerShowed(Wire("\"theirs\""));

            Assert.That(sent.Judge(Wire("\"theirs\""), Always), Is.EqualTo(SentValues.Verdict.NotSentRecently),
                "Nothing was sent since the value was taken");
            Assert.That(sent.HasSentSince(Always), Is.False);

            Send(sent, "mine", 200);
            Assert.That(sent.Judge(Wire("\"mine\""), since: 190), Is.EqualTo(SentValues.Verdict.Arrived));
            Assert.That(sent.Judge(Wire("\"theirs\""), since: 190), Is.EqualTo(SentValues.Verdict.Lost),
                "The value taken long before was still held when the window began");
            Assert.That(sent.Judge(Wire("\"a\""), since: 190), Is.EqualTo(SentValues.Verdict.ChangedElsewhere),
                "A value sent before the one taken was set back by someone else");
            Assert.That(sent.Judge(Wire("\"b\""), Always), Is.EqualTo(SentValues.Verdict.ChangedElsewhere));
        }

        /// <summary>
        /// An answer showed the last change lost, and the change went out again, into a link that
        /// dropped again soon after. The server still holds the value that answer held, and that
        /// value tells the second loss, though the change it replaced was sent before the window.
        /// </summary>
        [Test]
        public void TheValueAnAnswerShowedTellsAChangeSentAgainLostAsWell()
        {
            var sent = new SentValues();
            Send(sent, true, 100);
            Send(sent, false, 200);
            Assert.That(sent.Judge(Wire("true"), since: 192), Is.EqualTo(SentValues.Verdict.Lost), "Precondition");

            sent.ServerShowed(Wire("true"));
            Send(sent, false, 210);

            Assert.That(sent.Judge(Wire("true"), since: 202), Is.EqualTo(SentValues.Verdict.Lost));
            Assert.That(sent.Judge(Wire("false"), since: 202), Is.EqualTo(SentValues.Verdict.Arrived));
        }

        /// <summary>
        /// The newest value sent before the window is the one held when it began, not the value
        /// the server showed before that: the member had moved on from it, so another client that
        /// set it again during the outage made a change of its own, and wins.
        /// </summary>
        [Test]
        public void AValueSentBeforeTheWindowComesBeforeTheOneTheServerShowedEarlier()
        {
            var sent = new SentValues();
            sent.ServerShowed(Wire("\"theirs\""));
            Send(sent, "a", 100);
            Send(sent, "b", 200);

            Assert.That(sent.Judge(Wire("\"theirs\""), since: 190), Is.EqualTo(SentValues.Verdict.ChangedElsewhere));
            Assert.That(sent.Judge(Wire("\"a\""), since: 190), Is.EqualTo(SentValues.Verdict.Lost));
        }

        /// <summary>A member that takes a value before it ever sends one has it all the same.</summary>
        [Test]
        public void AValueTakenBeforeTheFirstSendCounts()
        {
            var sent = new SentValues();
            sent.ServerShowed(Wire("[0,-3,0]"));
            Send(sent, new Vector3(7, 0, 7).ToJson(), 200);

            Assert.That(sent.Judge(Wire("[0,-3,0]"), since: 190), Is.EqualTo(SentValues.Verdict.Lost));
        }

        /// <summary>
        /// The residual: a member whose very first value is lost has held nothing before it, so any
        /// answer is someone else's.
        /// </summary>
        [Test]
        public void BeforeTheFirstValueNothingWasHeld()
        {
            var sent = new SentValues();
            Send(sent, "first", 200);

            Assert.That(sent.Judge(Wire("\"\""), since: 190), Is.EqualTo(SentValues.Verdict.ChangedElsewhere));
        }

        /// <summary>
        /// The trade-off, accepted: another client that sets the member back during the outage, to
        /// the value it held when the window began, looks exactly like the change after it being
        /// lost, and is undone.
        /// </summary>
        [Test]
        public void AnotherClientSettingTheValueHeldWhenTheWindowBeganBackLooksLikeALostChange()
        {
            var sent = new SentValues();
            Send(sent, true, 100);
            Send(sent, false, 200); // arrived; then another client set it back to true

            Assert.That(sent.Judge(Wire("true"), since: 190), Is.EqualTo(SentValues.Verdict.Lost));
        }


        /*
         *  Values compared as they read on the wire
         */

        /// <summary>
        /// The values from the trace that found this: a Vector3 goes out as floats, [0.0,-3.0,0.0],
        /// and the server, which is JavaScript, writes the same numbers back as [0,-3,0].
        /// </summary>
        [Test]
        public void AVectorOfWholeNumbersEqualsTheServersIntegers()
        {
            var sent = Sent(new Vector3(0, -3, 0).ToJson(), new Vector3(7, 0, 7).ToJson());

            Assert.That(sent.Judge(Wire("[0,-3,0]"), Always), Is.EqualTo(SentValues.Verdict.Lost));
            Assert.That(sent.Judge(Wire("[7,0,7]"), Always), Is.EqualTo(SentValues.Verdict.Arrived));
        }

        /// <summary>Held as the float 0.1f, sent as 0.1, which reads back as the double 0.1.</summary>
        [Test]
        public void AFloatEqualsTheDoubleItReadsBackAs()
        {
            var sent = Sent(new Vector3(0.1f, 0.25f, -1.5f).ToJson(), new Vector3(0.2f, 0.25f, -1.5f).ToJson());

            Assert.That(sent.Judge(Wire("[0.1,0.25,-1.5]"), Always), Is.EqualTo(SentValues.Verdict.Lost));
            Assert.That(sent.Judge(Wire("[0.2,0.25,-1.5]"), Always), Is.EqualTo(SentValues.Verdict.Arrived));
            Assert.That(sent.Judge(Wire("[0.1,0.25,-1.6]"), Always), Is.EqualTo(SentValues.Verdict.ChangedElsewhere));
        }

        [Test]
        public void AQuaternionIsComparedByItsNumbers()
        {
            var sent = Sent(Quaternion.identity.ToJson(), new Quaternion(0.5f, -0.5f, 0.5f, 0.5f).ToJson());

            Assert.That(sent.Judge(Wire("[0,0,0,1]"), Always), Is.EqualTo(SentValues.Verdict.Lost));
            Assert.That(sent.Judge(Wire("[0.5,-0.5,0.5,0.5]"), Always), Is.EqualTo(SentValues.Verdict.Arrived));
            Assert.That(sent.Judge(Wire("[0.5,-0.5,0.5]"), Always), Is.EqualTo(SentValues.Verdict.ChangedElsewhere),
                "An array of another length is another value");
        }

        /// <summary>
        /// Colibri sends a colour as its HTML string. colibri-web may send one as [r,g,b,a], which is
        /// another value on the wire, so another client's.
        /// </summary>
        [Test]
        public void AColourIsComparedAsTheStringItIsSentAs()
        {
            var red = new Color(1, 0, 0, 1);
            var blue = new Color(0, 0, 1, 1);
            var sent = Sent(red.ToJson(), blue.ToJson());

            Assert.That(sent.Judge(Wire($"\"{red.ToJson()}\""), Always), Is.EqualTo(SentValues.Verdict.Lost));
            Assert.That(sent.Judge(Wire($"\"{blue.ToJson()}\""), Always), Is.EqualTo(SentValues.Verdict.Arrived));
            Assert.That(sent.Judge(Wire("[1,0,0,1]"), Always), Is.EqualTo(SentValues.Verdict.ChangedElsewhere));
        }

        [Test]
        public void ArraysAreComparedElementByElement()
        {
            var floats = Sent(new JArray(new[] { 1f, 2.5f }), new JArray(new[] { 1f, 3f }));
            Assert.That(floats.Judge(Wire("[1,2.5]"), Always), Is.EqualTo(SentValues.Verdict.Lost));
            Assert.That(floats.Judge(Wire("[1,3]"), Always), Is.EqualTo(SentValues.Verdict.Arrived));
            Assert.That(floats.Judge(Wire("[2.5,1]"), Always), Is.EqualTo(SentValues.Verdict.ChangedElsewhere), "Order matters");
            Assert.That(floats.Judge(Wire("[1,3,0]"), Always), Is.EqualTo(SentValues.Verdict.ChangedElsewhere), "Length matters");

            var vectors = Sent(new JArray(new Vector3(1, 2, 3).ToJson(), new Vector3(0, 0, 0).ToJson()), new JArray());
            Assert.That(vectors.Judge(Wire("[[1,2,3],[0,0,0]]"), Always), Is.EqualTo(SentValues.Verdict.Lost));
            Assert.That(vectors.Judge(Wire("[]"), Always), Is.EqualTo(SentValues.Verdict.Arrived));

            var strings = Sent(new JArray("a", "b"), new JArray("b", "a"));
            Assert.That(strings.Judge(Wire("[\"a\",\"b\"]"), Always), Is.EqualTo(SentValues.Verdict.Lost));
        }

        [Test]
        public void AnObjectIsComparedByItsPropertiesInAnyOrder()
        {
            var sent = Sent(new JObject { { "a", 1 }, { "b", new JArray(2f) } }, new JObject { { "a", 2 } });

            Assert.That(sent.Judge(Wire("{\"b\":[2],\"a\":1}"), Always), Is.EqualTo(SentValues.Verdict.Lost));
            Assert.That(sent.Judge(Wire("{\"a\":1}"), Always), Is.EqualTo(SentValues.Verdict.ChangedElsewhere), "A property missing is another value");
            Assert.That(sent.Judge(Wire("{\"a\":2.0}"), Always), Is.EqualTo(SentValues.Verdict.Arrived));
        }

        [Test]
        public void ScalarsAreComparedAsTheyReadOnTheWire()
        {
            Assert.That(Sent(2f, 2.5f).Judge(Wire("2"), Always), Is.EqualTo(SentValues.Verdict.Lost), "2.0 went out, 2 came back");
            Assert.That(Sent(1, 2).Judge(Wire("1"), Always), Is.EqualTo(SentValues.Verdict.Lost));
            Assert.That(Sent(true, false).Judge(Wire("true"), Always), Is.EqualTo(SentValues.Verdict.Lost));
            Assert.That(Sent(true, false).Judge(Wire("1"), Always), Is.EqualTo(SentValues.Verdict.ChangedElsewhere), "1 is not true on the wire");
            Assert.That(Sent("1", "2").Judge(Wire("1"), Always), Is.EqualTo(SentValues.Verdict.ChangedElsewhere), "Nor is it \"1\"");

            // A string that looks like a date stays a string on both sides.
            var stamp = "2026-10-08T12:00:00Z";
            Assert.That(Sent(stamp, "later").Judge(Wire($"\"{stamp}\""), Always), Is.EqualTo(SentValues.Verdict.Lost));
        }
    }
}
