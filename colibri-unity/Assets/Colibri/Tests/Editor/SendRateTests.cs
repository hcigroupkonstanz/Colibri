using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using HCIKonstanz.Colibri.Core;
using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Setup;
using HCIKonstanz.Colibri.Synchronization;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;
using Object = UnityEngine.Object;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// The per-object send-rate limit, on a clock the tests drive themselves.
    ///
    /// A headset renders 72 to 120 frames per second, and every moving synced object used to send
    /// an update in every one of them - traffic that one server and one Wi-Fi network cannot keep
    /// up with from dozens of headsets. The limit must not cost anything else, though: a one-off
    /// change still goes out at once, and the last values of a burst always arrive, even when
    /// nothing changes after them.
    /// </summary>
    public class SendRateTests
    {
        private class RateModel : SyncBehaviour<RateModel>
        {
            [Sync]
            public string Label = "";

            [Sync]
            public int Count;

            /// <summary>Edit mode never calls Awake, which is where change tracking is set up.</summary>
            public void Wake() => Awake();
        }

        private class RateTransform : GenericSyncTransform<RateTransform>
        {
            public void Wake() => Awake();
        }

        /// <summary>The default limit, 30 updates per second.</summary>
        private const double Interval = 1.0 / ColibriConfig.DEFAULT_MAX_SEND_RATE;

        /// <summary>Somewhere well into a session, so a "quiet spell" is not just the start of time.</summary>
        private const double Start = 100.0;

        private readonly List<GameObject> _gameObjects = new List<GameObject>();

        [TearDown]
        public void Cleanup()
        {
            foreach (var gameObject in _gameObjects)
            {
                if (gameObject != null)
                    Object.DestroyImmediate(gameObject);
            }
            _gameObjects.Clear();

            SyncSettings.ResetMaxSendRate();

            // Awake registers listeners, and that creates the connection singleton - in edit mode
            // an inert component on a GameObject in the open scene. It is not this test's to keep.
            foreach (var connection in UnityCompat.FindAll<WebServerConnection>(FindObjectsInactive.Include))
                Object.DestroyImmediate(connection.gameObject);
        }

        /// <summary>
        /// A model that has had its first update from the server: until then, a model compares
        /// nothing, and the first answer decides which of its members go out.
        /// </summary>
        private RateModel SpawnModel()
        {
            var gameObject = new GameObject("send-rate-model");
            _gameObjects.Add(gameObject);

            var model = gameObject.AddComponent<RateModel>();
            model.Wake();
            model.OnModelUpdate(new JObject { { "id", model.Id } });
            return model;
        }

        private RateTransform SpawnTransform()
        {
            var gameObject = new GameObject("send-rate-transform");
            _gameObjects.Add(gameObject);

            var sync = gameObject.AddComponent<RateTransform>();
            sync.Wake();
            sync.OnModelUpdate(new JObject { { "id", sync.Id } });
            return sync;
        }

        /// <summary>One frame of the ticker: the poll in Update, then the flush in LateUpdate.</summary>
        private static JObject Frame<T>(SyncBehaviour<T> model, double now, double interval = Interval)
            where T : SyncBehaviour<T>
        {
            ((SyncTicker.ITickable)model).PollChanges();
            return model.TakeDueUpdate(now, interval, heardAt: now);
        }

        /// <summary>Frames at <paramref name="fps"/> from <paramref name="from"/> up to <paramref name="to"/>, collecting what is sent.</summary>
        private static void RunFrames<T>(SyncBehaviour<T> model, double from, double to, double fps, List<JObject> sent)
            where T : SyncBehaviour<T>
        {
            for (var frame = 0; from + frame / fps < to; frame++)
            {
                var update = Frame(model, from + frame / fps);
                if (update != null)
                    sent.Add(update);
            }
        }


        /*
         *  The limit itself
         */

        [Test]
        public void AChangeAfterAQuietSpellGoesOutInTheSameFrame()
        {
            var model = SpawnModel();
            Assert.That(Frame(model, Start), Is.Null, "Nothing changed, yet something was sent");

            model.Label = "first";
            var sent = Frame(model, Start + 0.011);
            Assert.That(sent?["label"]?.Value<string>(), Is.EqualTo("first"), "A one-off change was held back");

            model.Label = "much later";
            sent = Frame(model, Start + 5.0);
            Assert.That(sent?["label"]?.Value<string>(), Is.EqualTo("much later"), "A one-off change was held back");
        }

        [Test]
        public void ABurstSendsItsFirstChangeAtOnceAndThenOneUpdateWithTheLatestValues()
        {
            var model = SpawnModel();
            var sent = new List<JObject>();

            void Collect(JObject update)
            {
                if (update != null)
                    sent.Add(update);
            }

            model.Label = "a";
            Collect(Frame(model, Start));
            model.Label = "b";
            Collect(Frame(model, Start + 0.011));
            model.Count = 5;
            Collect(Frame(model, Start + 0.022));
            model.Label = "c";
            Collect(Frame(model, Start + 0.030));

            Assert.That(sent.Count, Is.EqualTo(1), "Changes within one interval of the first were sent one by one");

            // Nothing changes any more - the held update must still go out, and only once.
            RunFrames(model, Start + 0.033, Start + 2.0, 90, sent);

            Assert.That(sent.Count, Is.EqualTo(2), $"Expected the first change and one update after it, got: {string.Join(" | ", sent)}");
            Assert.That(sent[0]["label"].Value<string>(), Is.EqualTo("a"));
            Assert.That(sent[1]["id"].Value<string>(), Is.EqualTo(model.Id));
            Assert.That(sent[1]["label"].Value<string>(), Is.EqualTo("c"), "The held update does not carry the latest value");
            Assert.That(sent[1]["count"].Value<int>(), Is.EqualTo(5), "A member changed earlier in the burst was lost");
        }

        [Test]
        public void TheHeldUpdateGoesOutAsSoonAsTheIntervalIsUp()
        {
            var model = SpawnModel();

            model.Label = "a";
            Assert.That(Frame(model, Start), Is.Not.Null);

            model.Label = "b";
            Assert.That(Frame(model, Start + 0.010), Is.Null);
            Assert.That(Frame(model, Start + Interval - 0.001), Is.Null, "Sent before the interval was up");

            var held = Frame(model, Start + Interval);
            Assert.That(held?["label"]?.Value<string>(), Is.EqualTo("b"), "Not sent once the interval was up");
        }

        [Test]
        public void AnObjectThatDoesNotChangeSendsNothing()
        {
            var model = SpawnModel();
            var sent = new List<JObject>();

            RunFrames(model, Start, Start + 3.0, 72, sent);

            Assert.That(sent, Is.Empty);
        }

        [TestCase(72)]
        [TestCase(90)]
        [TestCase(120)]
        public void AnObjectChangingInEveryFrameSendsAtTheLimitAndNotAtTheFrameRate(int fps)
        {
            var model = SpawnModel();
            var sent = new List<JObject>();

            for (var frame = 0; frame < fps * 2; frame++)
            {
                model.Count = frame + 1;
                var update = Frame(model, Start + (double)frame / fps);
                if (update != null)
                    sent.Add(update);
            }

            // Then it stops; the last value still arrives.
            RunFrames(model, Start + 2.0, Start + 3.0, fps, sent);

            // Two seconds at 30 per second. Counting each interval from the frame that happened to
            // send would round it up to whole frames - 24 per second at 72 fps.
            Assert.That(sent.Count, Is.InRange(59, 62), $"{sent.Count} updates in two seconds at {fps} fps");
            Assert.That(sent[sent.Count - 1]["count"].Value<int>(), Is.EqualTo(fps * 2), "The last value never arrived");
        }

        [Test]
        public void ZeroTurnsTheLimitOff()
        {
            var model = SpawnModel();
            var sent = new List<JObject>();

            for (var frame = 0; frame < 10; frame++)
            {
                model.Count = frame + 1;
                var update = Frame(model, Start + frame / 120.0, interval: 0);
                if (update != null)
                    sent.Add(update);
            }

            Assert.That(sent.Count, Is.EqualTo(10), "Without a limit every frame with a change sends");
        }

        /// <summary>
        /// SyncSettings.MaxSendRate can be raised while the app runs. The slot for an object's next
        /// send used to be fixed with the interval of its last send, so what it held then still
        /// waited out the old, longer interval: a full second after going from 1 to 30 a second.
        /// </summary>
        [Test]
        public void RaisingTheLimitSendsWhatIsHeldOnTheNewInterval()
        {
            var model = SpawnModel();

            model.Label = "a";
            Assert.That(Frame(model, Start, interval: 1.0), Is.Not.Null);

            model.Label = "b";
            Assert.That(Frame(model, Start + 0.010, interval: 1.0), Is.Null, "Precondition: the change is held");

            // From here on the limit is 30 per second.
            Assert.That(Frame(model, Start + Interval - 0.001), Is.Null, "Sent before even the new interval was up");

            var held = Frame(model, Start + Interval);
            Assert.That(held?["label"]?.Value<string>(), Is.EqualTo("b"),
                "The change held under the old limit waited for the old interval");

            // And the new limit goes on from there, not the old one.
            model.Label = "c";
            Assert.That(Frame(model, Start + Interval + 0.010), Is.Null);
            Assert.That(Frame(model, Start + 2 * Interval + 0.001)?["label"]?.Value<string>(), Is.EqualTo("c"));
        }

        /// <summary>A lowered limit holds the next change for the new, longer interval.</summary>
        [Test]
        public void LoweringTheLimitHoldsTheNextChangeLonger()
        {
            var model = SpawnModel();

            model.Label = "a";
            Assert.That(Frame(model, Start), Is.Not.Null);
            model.Label = "b";
            Assert.That(Frame(model, Start + Interval + 0.001), Is.Not.Null, "Precondition: sent once the interval was up");

            // From here on the limit is 1 per second.
            model.Label = "c";
            Assert.That(Frame(model, Start + 2 * Interval + 0.002, interval: 1.0)?["label"]?.Value<string>(), Is.EqualTo("c"),
                "The slot set under the old limit still stands");

            model.Label = "d";
            Assert.That(Frame(model, Start + 3 * Interval, interval: 1.0), Is.Null, "Sent on the old interval after a lowered limit");
            Assert.That(Frame(model, Start + 2 * Interval + 1.003, interval: 1.0)?["label"]?.Value<string>(), Is.EqualTo("d"));
        }

        [Test]
        public void EveryObjectIsLimitedOnItsOwn()
        {
            var first = SpawnModel();
            var second = SpawnModel();

            first.Label = "first";
            Assert.That(Frame(first, Start), Is.Not.Null);

            second.Label = "second";
            var sent = Frame(second, Start + 0.011);

            Assert.That(sent?["label"]?.Value<string>(), Is.EqualTo("second"),
                "One object's update held back another object's first change");
        }


        /*
         *  Switching an object off or on is not held back
         */

        [Test]
        public void SwitchingTheObjectOffGoesOutAtOnceWithWhatWasHeld()
        {
            var sync = SpawnTransform();

            sync.transform.position = new Vector3(1f, 0f, 0f);
            Assert.That(Frame(sync, Start), Is.Not.Null);

            sync.transform.position = new Vector3(2f, 0f, 0f);
            Assert.That(Frame(sync, Start + 0.011), Is.Null, "Precondition: the second move is held");

            sync.gameObject.SetActive(false);
            var sent = Frame(sync, Start + 0.022);

            Assert.That(sent, Is.Not.Null, "Switching the object off was held back by the send-rate limit");
            Assert.That(sent["active"].Value<bool>(), Is.False);
            Assert.That(sent["position"].ToObject<float[]>(), Is.EqualTo(new[] { 2f, 0f, 0f }),
                "The move held back before the object was switched off was not sent with it");
        }

        [Test]
        public void SwitchingTheObjectBackOnGoesOutAtOnce()
        {
            var sync = SpawnTransform();

            sync.gameObject.SetActive(false);
            Assert.That(Frame(sync, Start)?["active"]?.Value<bool>(), Is.False);

            sync.gameObject.SetActive(true);
            var sent = Frame(sync, Start + 0.011);

            Assert.That(sent?["active"]?.Value<bool>(), Is.True, "Switching the object back on was held back");
        }

        /// <summary>
        /// Going out early is reserved for the switch itself: it must not leave a pass behind for
        /// the next ordinary change.
        /// </summary>
        [Test]
        public void ASwitchDoesNotLetTheNextChangePastTheLimit()
        {
            var sync = SpawnTransform();

            sync.transform.position = new Vector3(1f, 0f, 0f);
            Assert.That(Frame(sync, Start), Is.Not.Null);

            sync.gameObject.SetActive(false);
            Assert.That(Frame(sync, Start + 0.005), Is.Not.Null);

            sync.transform.position = new Vector3(2f, 0f, 0f);
            Assert.That(Frame(sync, Start + 0.010), Is.Null, "A move right after the switch skipped the limit");
            Assert.That(Frame(sync, Start + 0.005 + Interval)?["position"], Is.Not.Null, "The held move never went out");
        }


        /*
         *  A SyncTransform box unticked while the app runs
         */

        /// <summary>
        /// Unticking SyncPosition switches what Position reads to Vector3.zero. The poll saw that
        /// as a move and sent it, and every client with the box still ticked moved the object to
        /// the origin.
        /// </summary>
        [Test]
        public void UntickingABoxSendsNoPlaceholderAndTickingItAgainSendsTheValue()
        {
            var sync = SpawnTransform();

            sync.transform.position = new Vector3(1f, 2f, 3f);
            Assert.That(Frame(sync, Start)?["position"], Is.Not.Null, "Precondition: the move goes out");

            sync.SyncPosition = false;
            var sent = new List<JObject>();
            RunFrames(sync, Start + 1.0, Start + 2.0, 90, sent);
            Assert.That(sent, Is.Empty, $"Unticking the box sent: {string.Join(" | ", sent)}");

            sync.SyncPosition = true;
            var resumed = Frame(sync, Start + 3.0);
            Assert.That(resumed?["position"]?.ToObject<float[]>(), Is.EqualTo(new[] { 1f, 2f, 3f }),
                "Ticking the box again should send the position the object has");
        }

        /// <summary>
        /// While SyncScale is off, Scale reads Vector3.one. A scale set back to one meanwhile read
        /// the same once the box was ticked again, so it did not count as a change: nothing was
        /// sent, and the other clients kept showing the object at its old size.
        /// </summary>
        [Test]
        public void TickingABoxAgainSendsTheValueEvenWhenItEqualsThePlaceholder()
        {
            var sync = SpawnTransform();

            sync.transform.localScale = new Vector3(2f, 2f, 2f);
            Assert.That(Frame(sync, Start)?["scale"], Is.Not.Null, "Precondition: the new scale goes out");

            sync.SyncScale = false;
            sync.transform.localScale = Vector3.one;
            var sent = new List<JObject>();
            RunFrames(sync, Start + 1.0, Start + 2.0, 90, sent);
            Assert.That(sent, Is.Empty, $"Changing the scale with the box unticked sent: {string.Join(" | ", sent)}");

            sync.SyncScale = true;
            var resumed = Frame(sync, Start + 3.0);
            Assert.That(resumed?["scale"]?.ToObject<float[]>(), Is.EqualTo(new[] { 1f, 1f, 1f }),
                "Ticking the box again should send the scale the object has, also when it is one");
            Assert.That(Frame(sync, Start + 4.0), Is.Null, "Ticking the box should send the value once, not in every frame");
        }

        /// <summary>
        /// The same for Active, whose placeholder is true: an object hidden while SyncActive was
        /// ticked, shown again with the box unticked, stayed hidden on every other client after
        /// the box was ticked again.
        /// </summary>
        [Test]
        public void TickingSyncActiveAgainSendsThatTheObjectIsShown()
        {
            var sync = SpawnTransform();

            sync.gameObject.SetActive(false);
            Assert.That(Frame(sync, Start)?["active"]?.Value<bool>(), Is.False, "Precondition: hiding the object goes out");

            sync.SyncActive = false;
            sync.gameObject.SetActive(true);
            Assert.That(Frame(sync, Start + 1.0), Is.Null, "Showing the object with the box unticked sent something");

            sync.SyncActive = true;
            Assert.That(Frame(sync, Start + 2.0)?["active"]?.Value<bool>(), Is.True,
                "Ticking the box again should send that the object is shown");
        }


        /*
         *  A value from the server meets a local change that has not gone out yet
         */

        /// <summary>
        /// This client applies and shows the server's value. Sending its own older change of the
        /// same member afterwards would put that on the server and every other client instead,
        /// and the copies would disagree from then on.
        /// </summary>
        [Test]
        public void AValueFromTheServerReplacesAHeldChangeOfTheSameMember()
        {
            var model = SpawnModel();

            model.Label = "mine";
            Assert.That(Frame(model, Start), Is.Not.Null);

            model.Label = "mine, later";
            model.Count = 2;
            Assert.That(Frame(model, Start + 0.010), Is.Null, "Precondition: the changes are held");

            model.OnModelUpdate(new JObject { { "id", model.Id }, { "label", "theirs" } });
            var sent = Frame(model, Start + Interval);

            Assert.That(model.Label, Is.EqualTo("theirs"));
            Assert.That(sent, Is.Not.Null, "The held change of the other member was lost");
            Assert.That(sent["count"].Value<int>(), Is.EqualTo(2));
            Assert.That(sent.ContainsKey("label"), Is.False, $"The older local label went out over the server's: {sent}");
        }

        [Test]
        public void AValueFromTheServerForTheOnlyHeldMemberLeavesNothingToSend()
        {
            var model = SpawnModel();

            model.Label = "mine";
            Assert.That(Frame(model, Start), Is.Not.Null);

            model.Label = "mine, later";
            Assert.That(Frame(model, Start + 0.010), Is.Null, "Precondition: the change is held");

            model.OnModelUpdate(new JObject { { "id", model.Id }, { "label", "theirs" } });

            var sent = new List<JObject>();
            RunFrames(model, Start + Interval, Start + 1.0, 90, sent);
            Assert.That(sent, Is.Empty, "An update without anything left in it, or with the older label, was sent");
        }

        /// <summary>
        /// Not only the limit's doing: without it, a change polled in Update and a server value
        /// delivered before LateUpdate's flush - both in one frame - ended the same way.
        /// </summary>
        [Test]
        public void WithoutALimitAValueFromTheServerStillReplacesAChangeFromTheSameFrame()
        {
            var model = SpawnModel();

            model.Label = "mine";
            ((SyncTicker.ITickable)model).PollChanges();
            model.OnModelUpdate(new JObject { { "id", model.Id }, { "label", "theirs" } });

            Assert.That(model.TakeDueUpdate(Start, interval: 0, heardAt: Start), Is.Null);
            Assert.That(model.Label, Is.EqualTo("theirs"));
        }


        /*
         *  Another client deletes the object
         */

        /// <summary>
        /// The object is destroyed a moment after the delete arrives, not at once. Sent in that
        /// moment, what the limit holds would reach the server after the delete and create the
        /// model there afresh - a ghost on every other client that nobody deletes again.
        /// </summary>
        [Test]
        public void ADeleteFromAnotherClientDropsWhatTheLimitHolds()
        {
            var model = SpawnModel();

            model.Label = "sent";
            Assert.That(Frame(model, Start), Is.Not.Null);

            model.Label = "held";
            Assert.That(Frame(model, Start + 0.010), Is.Null, "Precondition: the change is held");

            // Edit mode refuses Destroy, and says so - which leaves the object here to look at.
            LogAssert.Expect(LogType.Error, new Regex("Destroy may not be called from edit mode"));
            Sync.OnServerMessage(model.Channel, "model::delete", new JObject { { "id", model.Id } });

            Assert.That(model.TakeDueUpdate(Start + Interval, Interval, heardAt: Start + Interval), Is.Null,
                "The held update was still sent after the model had been deleted");
        }


        /*
         *  Where the limit comes from
         */

        [Test]
        public void ANewConfigurationLimitsTo30UpdatesPerSecond()
        {
            var config = ScriptableObject.CreateInstance<ColibriConfig>();
            try
            {
                Assert.That(config.MaxSendRate, Is.EqualTo(30));
            }
            finally
            {
                Object.DestroyImmediate(config);
            }
        }

        /// <summary>
        /// Runs <paramref name="test"/> with the configuration's rate set to <paramref name="rate"/>,
        /// and puts the project's own value back afterwards.
        /// </summary>
        private static void WithConfiguredRate(int rate, Action test)
        {
            var config = ColibriConfig.Load();
            var configured = config.MaxSendRate;
            config.MaxSendRate = rate;
            try
            {
                SyncSettings.ResetMaxSendRate();
                test();
            }
            finally
            {
                config.MaxSendRate = configured;
                SyncSettings.ResetMaxSendRate();
            }
        }

        [Test]
        public void TheLimitStartsOutAsTheConfiguredOne()
        {
            WithConfiguredRate(12, () => Assert.That(SyncSettings.MaxSendRate, Is.EqualTo(12)));
        }

        [Test]
        public void SettingTheLimitFromCodeLeavesTheConfigurationAlone()
        {
            WithConfiguredRate(12, () =>
            {
                SyncSettings.MaxSendRate = 10;

                Assert.That(SyncSettings.MaxSendRate, Is.EqualTo(10));
                Assert.That(SyncSettings.SendInterval, Is.EqualTo(0.1).Within(1e-9));
                Assert.That(ColibriConfig.Load().MaxSendRate, Is.EqualTo(12));

                SyncSettings.ResetMaxSendRate();
                Assert.That(SyncSettings.MaxSendRate, Is.EqualTo(12));
            });
        }

        /// <summary>
        /// The setup window refuses a negative rate, but the configuration asset's own Inspector
        /// and a hand edit did not, and one used to be clamped to 0 - no limit at all, every moving
        /// object sending in every frame - without a word. The limit is read every frame, so the
        /// warning has to come once, not with every read.
        /// </summary>
        [Test]
        public void ANegativeConfiguredRateIsReportedOnceAndTheDefaultIsUsed()
        {
            WithConfiguredRate(-5, () =>
            {
                var warnings = 0;
                Application.LogCallback count = (message, stackTrace, type) =>
                {
                    if (type == LogType.Warning && message.StartsWith("Colibri: Max Send Rate in the Colibri configuration is -5"))
                        warnings++;
                };

                LogAssert.Expect(LogType.Warning, new Regex("^Colibri: Max Send Rate in the Colibri configuration is -5"));
                Application.logMessageReceived += count;
                try
                {
                    for (var frame = 0; frame < 3; frame++)
                    {
                        Assert.That(SyncSettings.MaxSendRate, Is.EqualTo(ColibriConfig.DEFAULT_MAX_SEND_RATE));
                        Assert.That(SyncSettings.SendInterval, Is.EqualTo(1.0 / ColibriConfig.DEFAULT_MAX_SEND_RATE).Within(1e-9));
                    }
                }
                finally
                {
                    Application.logMessageReceived -= count;
                }

                Assert.That(warnings, Is.EqualTo(1));
            });
        }

        [Test]
        public void TheConfigurationAssetsInspectorTakesNoNegativeRate()
        {
            var field = typeof(ColibriConfig).GetField(nameof(ColibriConfig.MaxSendRate));
            var min = (MinAttribute)Attribute.GetCustomAttribute(field, typeof(MinAttribute));

            Assert.That(min, Is.Not.Null);
            Assert.That(min.min, Is.EqualTo(0f));
        }

        [Test]
        public void ALimitOfZeroMeansNoInterval()
        {
            SyncSettings.MaxSendRate = 0;

            Assert.That(SyncSettings.SendInterval, Is.EqualTo(0.0));
        }

        [Test]
        public void ANegativeLimitIsRefused()
        {
            Assert.Throws<ArgumentOutOfRangeException>(() => SyncSettings.MaxSendRate = -1);
        }
    }
}
