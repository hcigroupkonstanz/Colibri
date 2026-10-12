using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Threading;
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
    /// What a model does with the server's answer to the request it makes again after every
    /// reconnect. The server clears an app's models when its last client leaves, so a client that
    /// was alone when its connection dropped comes back to a server that holds nothing of its
    /// objects - and answers each request with a bare <c>{ id }</c>. Nothing put the state back,
    /// and every client that joined afterwards was missing those objects.
    ///
    /// A model another client deleted meanwhile is answered with <c>model::delete</c> instead, as
    /// long as the server remembers the delete; ReconnectTests checks that against the server.
    ///
    /// Also what a model does with the first answer, to the request it makes when it registers,
    /// when this client changed it before that answer arrived.
    /// </summary>
    public class ModelResyncTests
    {
        private class ResyncModel : SyncBehaviour<ResyncModel>
        {
            [Sync]
            public string Label = "";

            [Sync]
            public int Count;

            /// <summary>Edit mode never calls Awake, which is where change tracking is set up.</summary>
            public void Wake() => Awake();
        }

        private class ResyncTransform : GenericSyncTransform<ResyncTransform>
        {
            public void Wake() => Awake();
        }

        private class ResyncJsonModel : SyncBehaviour<ResyncJsonModel>
        {
            [Sync]
            public JObject Data;

            public void Wake() => Awake();
        }

        private readonly List<GameObject> _gameObjects = new List<GameObject>();

        /// <summary>A round of answers an earlier test left open would count as one this test's reconnect follows.</summary>
        [SetUp]
        public void StartASession() => Sync.ResetListeners();

        [TearDown]
        public void Cleanup()
        {
            foreach (var gameObject in _gameObjects)
            {
                if (gameObject != null)
                    Object.DestroyImmediate(gameObject);
            }
            _gameObjects.Clear();

            // Awake registers listeners, and that creates the connection singleton - in edit mode
            // an inert component on a GameObject in the open scene. It is not this test's to keep.
            foreach (var connection in UnityCompat.FindAll<WebServerConnection>(FindObjectsInactive.Include))
                Object.DestroyImmediate(connection.gameObject);
        }

        private T Spawn<T>(string name) where T : Component
        {
            var gameObject = new GameObject(name);
            _gameObjects.Add(gameObject);
            return gameObject.AddComponent<T>();
        }

        private ResyncModel SpawnModel()
        {
            var model = Spawn<ResyncModel>("resync-model");
            model.Wake();
            return model;
        }

        private static JObject Bare(string id) => new JObject { { "id", id } };

        /// <summary>Whatever the model would send now, without a send-rate limit.</summary>
        private static JObject Sent<T>(SyncBehaviour<T> model) where T : SyncBehaviour<T>
            => SentAt(model, 100.0);

        /// <summary>
        /// Whatever the model would send at <paramref name="time"/>, on SyncTicker's clock, over a
        /// connection that works: this client heard from the server at that moment.
        /// </summary>
        private static JObject SentAt<T>(SyncBehaviour<T> model, double time) where T : SyncBehaviour<T>
            => model.TakeDueUpdate(time, interval: 0, heardAt: time);

        private static void Poll(object model) => ((SyncTicker.ITickable)model).PollChanges();

        private static string[] Members(JObject update)
            => update.Properties().Select(p => p.Name).OrderBy(n => n).ToArray();

        /// <summary>
        /// The first bare answer is how every new object starts, and sends nothing of its own: a
        /// manager's TriggerSync decides whether the full state goes out, as it always did.
        /// </summary>
        [Test]
        public void TheFirstBareAnswerSendsNothing()
        {
            var model = SpawnModel();

            model.OnModelUpdate(Bare(model.Id));

            Assert.That(Sent(model), Is.Null);
        }

        [Test]
        public void ALaterBareAnswerSendsTheFullState()
        {
            var model = SpawnModel();
            model.OnModelUpdate(Bare(model.Id));

            model.Label = "mine";
            model.Count = 3;
            ((SyncTicker.ITickable)model).PollChanges();
            Assert.That(Sent(model), Is.Not.Null, "Precondition: the change goes out");

            model.OnModelUpdate(Bare(model.Id));
            var sent = Sent(model);

            Assert.That(sent, Is.Not.Null, "The server has lost the model, and nothing put it back");
            Assert.That(Members(sent), Is.EqualTo(new[] { "count", "id", "label" }));
            Assert.That(sent["id"].Value<string>(), Is.EqualTo(model.Id));
            Assert.That(sent["label"].Value<string>(), Is.EqualTo("mine"));
            Assert.That(sent["count"].Value<int>(), Is.EqualTo(3));
        }

        /// <summary>
        /// The full state that answers a bare answer reaches every other client as an update with
        /// members, and one of those is applied without anything going back - so two clients
        /// cannot set each other off.
        /// </summary>
        [Test]
        public void AnUpdateWithMembersSendsNothingBack()
        {
            var model = SpawnModel();
            model.OnModelUpdate(Bare(model.Id));

            model.OnModelUpdate(new JObject { { "id", model.Id }, { "label", "theirs" }, { "count", 5 } });
            ((SyncTicker.ITickable)model).PollChanges();

            Assert.That(model.Label, Is.EqualTo("theirs"));
            Assert.That(Sent(model), Is.Null);
        }

        [Test]
        public void AnAnswerForAnotherModelSendsNothing()
        {
            var model = SpawnModel();
            model.OnModelUpdate(Bare(model.Id));

            model.OnModelUpdate(Bare("someone-else"));

            Assert.That(Sent(model), Is.Null);
        }

        /// <summary>The full state goes by a SyncTransform's boxes, like every other full state.</summary>
        [Test]
        public void TheFullStateLeavesOutTheMembersThatAreSwitchedOff()
        {
            var sync = Spawn<ResyncTransform>("resync-transform");
            sync.SyncPosition = false;
            sync.Wake();
            sync.OnModelUpdate(Bare(sync.Id));

            sync.OnModelUpdate(Bare(sync.Id));
            var sent = Sent(sync);

            Assert.That(sent, Is.Not.Null);
            Assert.That(Members(sent), Does.Not.Contain("position"), $"The unticked position went out: {sent}");
            Assert.That(Members(sent), Does.Contain("rotation"));
        }


        /*
         *  An answer holding what the server had before this client's last changes, which were
         *  written into the connection as it died and lost. See SentValuesTests for the comparison.
         */

        /// <summary>The model, answered once and with a label that reached the server at 100.</summary>
        private ResyncModel SpawnModelThatSent(string label)
        {
            var model = SpawnModel();
            model.OnModelUpdate(Bare(model.Id));

            model.Label = label;
            Poll(model);
            Assert.That((string)SentAt(model, 100)["label"], Is.EqualTo(label), "Precondition: the change goes out");
            return model;
        }

        /// <summary>A change polled and sent at <paramref name="time"/>, into a connection that may be dead.</summary>
        private static void Change(ResyncModel model, string label, double time)
        {
            model.Label = label;
            Poll(model);
            Assert.That(SentAt(model, time), Is.Not.Null, "Precondition: the change goes out");
        }

        private static JObject Answer(ResyncModel model, string label, int count = 0)
            => new JObject { { "id", model.Id }, { "label", label }, { "count", count } };

        /// <summary>
        /// The answer to the request sent after all the others (see Sync.ReconnectRound): the
        /// answers to the requests made again are all in.
        /// </summary>
        private static void EndOfAnswers()
        {
            var marker = Sync.ReconnectRoundEndMarker;
            Assert.That(marker, Is.Not.Null, "Precondition: the answers to a reconnect's requests are still coming in");
            Sync.OnServerMessage(Sync.ReconnectRoundChannel, "model::update", new JObject { { "id", marker } });
        }

        /// <summary>A model::update another client sends, as the server relays it.</summary>
        private static JObject Relayed(ResyncModel model, string member, JToken value)
            => new JObject { { "id", model.Id }, { member, value } };

        /// <summary>The bug: the answer put the value from before the outage back, and nothing went out.</summary>
        [Test]
        public void AValueLostWithTheConnectionIsKeptAndSentAgain()
        {
            var model = SpawnModelThatSent("before");
            Change(model, "lost at the drop", 101);

            Sync.RequestModelsAgain(disconnectedAt: 103);
            model.OnModelUpdate(Answer(model, "before"));

            Assert.That(model.Label, Is.EqualTo("lost at the drop"), "The answer put the value from before the outage back");
            var sent = SentAt(model, 104);
            Assert.That(sent, Is.Not.Null, "The value that was lost was not sent again");
            Assert.That(Members(sent), Is.EqualTo(new[] { "id", "label" }), $"Only what was lost goes out again: {sent}");
            Assert.That((string)sent["label"], Is.EqualTo("lost at the drop"));
        }

        /// <summary>The trace that found it: a SyncTransform moved at the drop, answered in the server's own number format.</summary>
        [Test]
        public void APositionLostWithTheConnectionIsKeptAndSentAgain()
        {
            var sync = Spawn<ResyncTransform>("resync-transform");
            sync.Wake();
            sync.OnModelUpdate(Bare(sync.Id));

            sync.transform.position = new Vector3(0, -3, 0);
            Poll(sync);
            Assert.That(SentAt(sync, 100), Is.Not.Null);
            sync.transform.position = new Vector3(7, 0, 7);
            Poll(sync);
            Assert.That(SentAt(sync, 101), Is.Not.Null);

            Sync.RequestModelsAgain(disconnectedAt: 103);
            sync.OnModelUpdate(JObject.Parse($"{{\"id\":\"{sync.Id}\",\"active\":true,\"position\":[0,-3,0],\"scale\":[1,1,1]}}"));

            Assert.That(sync.transform.position, Is.EqualTo(new Vector3(7, 0, 7)), "The answer put the position from before the outage back");
            var sent = SentAt(sync, 104);
            Assert.That(sent, Is.Not.Null, "The position that was lost was not sent again");
            Assert.That(Members(sent), Is.EqualTo(new[] { "id", "position" }), $"Only what was lost goes out again: {sent}");
            Assert.That(sent["position"].ToVector3(), Is.EqualTo(new Vector3(7, 0, 7)));
        }

        /// <summary>
        /// An object moved across the drop at 30 updates a second, and let go before the outage was
        /// noticed: every position sent after the server was last heard from went into the dead
        /// link, 30 of them, and the answer holds one from about when the link died. It is still
        /// recognised, and the object stays where it was let go.
        /// </summary>
        [Test]
        public void AnObjectMovedAcrossTheDropStaysWhereItWasLetGo()
        {
            var sync = Spawn<ResyncTransform>("resync-transform");
            sync.Wake();
            sync.OnModelUpdate(Bare(sync.Id));

            // Heard from until 200, after x = 30 was sent; the link died a moment later.
            for (var x = 1; x <= 60; x++)
            {
                var time = 199 + x / 30.0;
                sync.transform.position = new Vector3(x, 0, 0);
                Poll(sync);
                Assert.That(sync.TakeDueUpdate(time, interval: 0, heardAt: System.Math.Min(time, 200)), Is.Not.Null,
                    "Precondition: the move goes out");
            }

            Sync.RequestModelsAgain(disconnectedAt: 202);
            sync.OnModelUpdate(JObject.Parse($"{{\"id\":\"{sync.Id}\",\"active\":true,\"position\":[32,0,0],\"scale\":[1,1,1]}}"));

            Assert.That(sync.transform.position, Is.EqualTo(new Vector3(60, 0, 0)), "The answer put the object back where it was when the link died");
            var sent = SentAt(sync, 203);
            Assert.That(sent, Is.Not.Null, "The position the object was let go at was not sent again");
            Assert.That(Members(sent), Is.EqualTo(new[] { "id", "position" }), $"Only what was lost goes out again: {sent}");
            Assert.That(sent["position"].ToVector3(), Is.EqualTo(new Vector3(60, 0, 0)));
        }

        /// <summary>
        /// The same, but moved on as soon as the connection is back, before the answers arrive. The
        /// client hears from the server again, but that says nothing about the positions sent into
        /// the dead link: the answer holding one is still recognised, and the object stays where it
        /// is now. Those moves pushed the positions out, and the answer put the object back.
        /// </summary>
        [Test]
        public void AnObjectMovedOnBeforeTheAnswersStillTellsThePositionLostAtTheDrop()
        {
            var sync = Spawn<ResyncTransform>("resync-transform");
            sync.Wake();
            sync.OnModelUpdate(Bare(sync.Id));

            // Heard from until 200, after x = 30 was sent; the link died a moment later.
            for (var x = 1; x <= 60; x++)
            {
                var time = 199 + x / 30.0;
                sync.transform.position = new Vector3(x, 0, 0);
                Poll(sync);
                Assert.That(sync.TakeDueUpdate(time, interval: 0, heardAt: System.Math.Min(time, 200)), Is.Not.Null,
                    "Precondition: the move goes out");
            }

            // Back at 203, heard from from then on, and moved on twice before the answers arrive.
            Sync.RequestModelsAgain(disconnectedAt: 202);
            for (var x = 61; x <= 62; x++)
            {
                sync.transform.position = new Vector3(x, 0, 0);
                Poll(sync);
                Assert.That(SentAt(sync, 203 + (x - 60) / 30.0), Is.Not.Null, "Precondition: the move goes out");
            }
            sync.OnModelUpdate(JObject.Parse($"{{\"id\":\"{sync.Id}\",\"active\":true,\"position\":[31,0,0],\"scale\":[1,1,1]}}"));

            Assert.That(sync.transform.position, Is.EqualTo(new Vector3(62, 0, 0)), "The answer put the object back where it was when the link died");
            var sent = SentAt(sync, 204);
            Assert.That(sent, Is.Not.Null, "The position the object is at now was not sent again");
            Assert.That(sent["position"].ToVector3(), Is.EqualTo(new Vector3(62, 0, 0)));
        }

        /// <summary>
        /// Moved on earlier still, in the frame between the new connection first hearing from the
        /// server and the requests going out, and the link drops again before the answers. The
        /// answer after the next reconnect still holds a position sent into the first dead link,
        /// and is recognised. Counted as sent after the server was last heard from on the new
        /// connection, the move pushed those positions out.
        /// </summary>
        [Test]
        public void AnObjectMovedOnBeforeTheRequestsStillTellsThePositionLostAtTheDrop()
        {
            var sync = Spawn<ResyncTransform>("resync-transform");
            sync.Wake();
            sync.OnModelUpdate(Bare(sync.Id));

            // Heard from until 200, after x = 30 was sent; the link died a moment later.
            for (var x = 1; x <= 60; x++)
            {
                var time = 199 + x / 30.0;
                if (time <= 200)
                    WebServerConnection.Instance.StampLiveness();
                sync.transform.position = new Vector3(x, 0, 0);
                Poll(sync);
                Assert.That(sync.TakeDueUpdate(time, interval: 0, heardAt: Sync.LastHeardAt(time)), Is.Not.Null,
                    "Precondition: the move goes out");
            }
            Sync.OnDisconnected(now: 202);

            // Accepted at 203, and moved on in that frame; the requests go out in the next.
            WebServerConnection.Instance.StampLiveness();
            sync.transform.position = new Vector3(61, 0, 0);
            Poll(sync);
            Assert.That(sync.TakeDueUpdate(203, interval: 0, heardAt: Sync.LastHeardAt(203)), Is.Not.Null,
                "Precondition: the move goes out");
            Sync.RequestModelsAgain();

            // Dropped again before the answers, and back.
            Sync.OnDisconnected(now: 206);
            Sync.RequestModelsAgain();
            sync.OnModelUpdate(JObject.Parse($"{{\"id\":\"{sync.Id}\",\"active\":true,\"position\":[31,0,0],\"scale\":[1,1,1]}}"));

            Assert.That(sync.transform.position, Is.EqualTo(new Vector3(61, 0, 0)), "The answer put the object back where it was when the first link died");
            var sent = SentAt(sync, 210);
            Assert.That(sent, Is.Not.Null, "The position the object is at now was not sent again");
            Assert.That(sent["position"].ToVector3(), Is.EqualTo(new Vector3(61, 0, 0)));
        }

        /// <summary>
        /// The other side: what the server holds is no value of this client's, so another client set
        /// it while this one was away - and that is the newer change.
        /// </summary>
        [Test]
        public void AValueAnotherClientSetDuringTheOutageIsApplied()
        {
            var model = SpawnModelThatSent("mine");
            Change(model, "mine, lost at the drop", 101);

            Sync.RequestModelsAgain(disconnectedAt: 103);
            model.OnModelUpdate(Answer(model, "theirs"));

            Assert.That(model.Label, Is.EqualTo("theirs"));
            Assert.That(SentAt(model, 104), Is.Null);
        }

        /// <summary>
        /// What was sent last arrived: nothing to do, and nothing to undo either - a change made here
        /// since then stays and goes out as usual.
        /// </summary>
        [Test]
        public void AnAnswerHoldingTheValueSentLastLeavesTheObjectAlone()
        {
            var model = SpawnModelThatSent("mine");

            model.Label = "changed since";
            Sync.RequestModelsAgain(disconnectedAt: 103);
            model.OnModelUpdate(Answer(model, "mine"));

            Assert.That(model.Label, Is.EqualTo("changed since"));
            Poll(model);
            var sent = SentAt(model, 104);
            Assert.That(Members(sent), Is.EqualTo(new[] { "id", "label" }));
            Assert.That((string)sent["label"], Is.EqualTo("changed since"));
        }

        /// <summary>Everything the answer shows to have been lost goes out again, as one update.</summary>
        [Test]
        public void EverythingLostWithTheConnectionGoesOutAgainAsOneUpdate()
        {
            var model = SpawnModelThatSent("before");
            model.Count = 1;
            Poll(model);
            Assert.That(SentAt(model, 100.5), Is.Not.Null);

            model.Label = "lost at the drop";
            model.Count = 5;
            Poll(model);
            Assert.That(SentAt(model, 101), Is.Not.Null);

            Sync.RequestModelsAgain(disconnectedAt: 103);
            model.OnModelUpdate(Answer(model, "before", 1));

            var sent = SentAt(model, 104);
            Assert.That(sent, Is.Not.Null);
            Assert.That(Members(sent), Is.EqualTo(new[] { "count", "id", "label" }), $"All that was lost should go out as one update: {sent}");
            Assert.That((int)sent["count"], Is.EqualTo(5));
            Assert.That((string)sent["label"], Is.EqualTo("lost at the drop"));
        }

        /// <summary>
        /// Another client's update, relayed while the answers are on their way, lacks a member this
        /// object sent: that says nothing about what the server holds for it, and it does not go
        /// out again. Sent again, it overwrote what another client had set during the outage, and
        /// the answer then put that client's value on this one: two values, for good.
        /// </summary>
        [Test]
        public void AMemberAnUpdateLacksIsNotSentAgain()
        {
            var model = SpawnModel();
            model.OnModelUpdate(Bare(model.Id));
            model.Label = "mine";
            model.Count = 1;
            Poll(model);
            Assert.That(SentAt(model, 100), Is.Not.Null);

            Sync.RequestModelsAgain(disconnectedAt: 103);
            model.OnModelUpdate(Relayed(model, "label", "theirs, live"));
            var sent = SentAt(model, 104);
            Assert.That(sent, Is.Null, $"Nothing was lost, so nothing should go out again: {sent}");

            model.OnModelUpdate(Answer(model, "theirs, live", 7));
            EndOfAnswers();

            Assert.That(model.Label, Is.EqualTo("theirs, live"));
            Assert.That(model.Count, Is.EqualTo(7), "The count another client set during the outage was not applied");
            Assert.That(SentAt(model, 105), Is.Null);
        }

        /// <summary>
        /// A manager on the channel asks for every model on it again too, and the answer to that
        /// carries this model as well: two answers, both from before the lost change. Both are
        /// judged, and the lost value goes out once. After the answer that marks the end of them,
        /// an update is applied as it arrives, even one holding a value this object sent before.
        /// </summary>
        [Test]
        public void EverythingUntilTheEndOfTheAnswersIsJudged()
        {
            var model = SpawnModelThatSent("before");
            System.Action<JObject> manager = _ => { };
            Sync.AddModelUpdateListener(model.Channel, manager);
            try
            {
                Change(model, "lost at the drop", 101);
                Sync.RequestModelsAgain(disconnectedAt: 103);

                model.OnModelUpdate(Answer(model, "before"));
                Assert.That((string)SentAt(model, 104)["label"], Is.EqualTo("lost at the drop"));

                model.OnModelUpdate(Answer(model, "before"));
                Assert.That(model.Label, Is.EqualTo("lost at the drop"), "The second answer put the value from before the outage back");
                Assert.That(SentAt(model, 105), Is.Null, "The second answer sent the lost value a second time");

                EndOfAnswers();
                model.OnModelUpdate(Answer(model, "before"));
                Assert.That(model.Label, Is.EqualTo("before"), "An update after the answers should be applied as it arrives");
                Assert.That(SentAt(model, 106), Is.Null);
            }
            finally
            {
                Sync.RemoveModelUpdateListener(model.Channel, manager);
            }
        }

        /// <summary>
        /// Another client's update, relayed ahead of the answers, does not take the place of one:
        /// both answers are still judged, and the value from before the outage is not put back
        /// here after the lost one has gone out again to everyone else.
        /// </summary>
        [Test]
        public void AnotherClientsUpdateAheadOfTheAnswersDoesNotLetOneThrough()
        {
            var model = SpawnModelThatSent("before");
            System.Action<JObject> manager = _ => { };
            Sync.AddModelUpdateListener(model.Channel, manager);
            try
            {
                Change(model, "lost at the drop", 101);
                Sync.RequestModelsAgain(disconnectedAt: 103);

                model.OnModelUpdate(Relayed(model, "count", 3));
                model.OnModelUpdate(Answer(model, "before", 3));
                var sent = SentAt(model, 104);
                model.OnModelUpdate(Answer(model, "before", 3));
                EndOfAnswers();

                Assert.That(model.Label, Is.EqualTo("lost at the drop"), "An answer put the value from before the outage back");
                Assert.That(sent, Is.Not.Null, "The value that was lost was not sent again");
                Assert.That((string)sent["label"], Is.EqualTo(model.Label), "What went out to everyone else differs from what this client shows");
                Assert.That(model.Count, Is.EqualTo(3));
                Assert.That(SentAt(model, 105), Is.Null);
            }
            finally
            {
                Sync.RemoveModelUpdateListener(model.Channel, manager);
            }
        }

        /// <summary>
        /// Once a member's last change is known to have been lost, nothing else that arrives before
        /// the end of the answers is applied to it: the server had all of that before it read the
        /// value sent again, which then replaces it there and on every other client. Applied here,
        /// this client alone would show it.
        /// </summary>
        [Test]
        public void AMemberFoundLostTakesNothingMoreFromTheAnswers()
        {
            var model = SpawnModelThatSent("before");
            Change(model, "lost at the drop", 101);
            Sync.RequestModelsAgain(disconnectedAt: 103);

            model.OnModelUpdate(Answer(model, "before"));
            Assert.That((string)SentAt(model, 104)["label"], Is.EqualTo("lost at the drop"));

            model.OnModelUpdate(Relayed(model, "label", "theirs, sent before the server read ours"));
            Assert.That(model.Label, Is.EqualTo("lost at the drop"));
            Assert.That(SentAt(model, 105), Is.Null);

            EndOfAnswers();
            model.OnModelUpdate(Relayed(model, "label", "theirs, sent after"));
            Assert.That(model.Label, Is.EqualTo("theirs, sent after"), "After the answers, another client's update should be applied as it arrives");
            Assert.That(SentAt(model, 106), Is.Null);
        }

        /// <summary>
        /// A member changed right after the reconnect, once the requests have gone out, takes
        /// nothing from the round either, not even a value another client set during the outage:
        /// the server reads the change after everything that arrives before the end of the answers,
        /// and it replaces that value there and on every other client. Applied here, the other
        /// client's value stayed on this client alone until the member changed again, which a switch
        /// may never do.
        /// </summary>
        [Test]
        public void AMemberChangedAfterTheRequestsTakesNothingFromTheAnswers()
        {
            var model = SpawnModelThatSent("before");
            Sync.RequestModelsAgain(disconnectedAt: 103);
            Change(model, "changed after the reconnect", 103.5);

            model.OnModelUpdate(Answer(model, "set by another client during the outage"));
            model.OnModelUpdate(Relayed(model, "label", "theirs, sent before the server read ours"));

            Assert.That(model.Label, Is.EqualTo("changed after the reconnect"), "What the server held before it read the change was applied here alone");
            var sent = SentAt(model, 104);
            Assert.That(sent, Is.Not.Null, "The change was not sent again");
            Assert.That((string)sent["label"], Is.EqualTo("changed after the reconnect"));
            Assert.That(SentAt(model, 105), Is.Null);

            EndOfAnswers();
            model.OnModelUpdate(Relayed(model, "label", "theirs, sent after"));
            Assert.That(model.Label, Is.EqualTo("theirs, sent after"), "After the answers, another client's update should be applied as it arrives");
        }

        /// <summary>
        /// That change, and the one sent again, are lost with a link that drops again before the
        /// answers. The answer after the next reconnect still holds the other client's value, which
        /// the change was sent after, and tells it: the change is kept and goes out once more.
        /// </summary>
        [Test]
        public void AChangeAfterTheRequestsLostWhenTheLinkDropsAgainIsKeptAndSentAgain()
        {
            var model = SpawnModelThatSent("before");
            Sync.RequestModelsAgain(disconnectedAt: 103);
            Change(model, "changed after the reconnect", 103.5);
            model.OnModelUpdate(Answer(model, "set by another client during the outage"));
            Assert.That(SentAt(model, 104), Is.Not.Null, "Precondition: the change goes out again");

            Sync.RequestModelsAgain(disconnectedAt: 106);
            model.OnModelUpdate(Answer(model, "set by another client during the outage"));

            Assert.That(model.Label, Is.EqualTo("changed after the reconnect"), "The answer after the second reconnect put the other client's value back");
            var sent = SentAt(model, 107);
            Assert.That(sent, Is.Not.Null, "The change lost at the second drop was not sent again");
            Assert.That((string)sent["label"], Is.EqualTo("changed after the reconnect"));
        }

        /// <summary>
        /// The end of the answers is the answer to the request sent after all the others, however
        /// many answers came before it: one where two were expected, say. An update after it is
        /// applied as it arrives, even long after and even one holding a value this object sent.
        /// </summary>
        [Test]
        public void AnUpdateAfterTheEndOfTheAnswersIsAppliedAsItArrives()
        {
            var model = SpawnModelThatSent("before");
            System.Action<JObject> manager = _ => { };
            Sync.AddModelUpdateListener(model.Channel, manager);
            try
            {
                Sync.RequestModelsAgain(disconnectedAt: 103);
                model.OnModelUpdate(Answer(model, "before"));
                EndOfAnswers();

                Change(model, "a", 500);
                Change(model, "b", 501);
                model.OnModelUpdate(Relayed(model, "label", "a"));

                Assert.That(model.Label, Is.EqualTo("a"));
                Assert.That(SentAt(model, 600), Is.Null);
            }
            finally
            {
                Sync.RemoveModelUpdateListener(model.Channel, manager);
            }
        }

        /// <summary>
        /// The answer to an earlier round's last request - one a failed write kept for the next
        /// connection - does not end the current round.
        /// </summary>
        [Test]
        public void TheEndOfAnEarlierRoundDoesNotEndTheCurrentOne()
        {
            var model = SpawnModelThatSent("before");
            Sync.RequestModelsAgain(disconnectedAt: 101);
            var earlier = Sync.ReconnectRoundEndMarker;

            Change(model, "lost at the drop", 102);
            Sync.RequestModelsAgain(disconnectedAt: 104);
            Sync.OnServerMessage(Sync.ReconnectRoundChannel, "model::update", new JObject { { "id", earlier } });
            Assert.That(Sync.ReconnectRoundEndMarker, Is.Not.Null.And.Not.EqualTo(earlier));

            model.OnModelUpdate(Answer(model, "before"));

            Assert.That(model.Label, Is.EqualTo("lost at the drop"));
            Assert.That((string)SentAt(model, 105)["label"], Is.EqualTo("lost at the drop"));
        }

        /// <summary>
        /// The link drops again soon after the reconnect, before the answers to its requests have
        /// arrived. The next round still counts from the first outage: counted from the second, the
        /// change lost at the first drop lay before the window, and the answer, which still holds
        /// the value from before it, was applied.
        /// </summary>
        [Test]
        public void AChangeLostAtTheDropIsKeptWhenTheLinkDropsAgainBeforeTheAnswers()
        {
            var model = SpawnModelThatSent("on");
            Change(model, "off", 200);

            Sync.RequestModelsAgain(disconnectedAt: 202);
            Assert.That(200, Is.LessThan(211 - SentValues.WindowSeconds), "Precondition: the change lies before the second outage's window");
            Sync.RequestModelsAgain(disconnectedAt: 211);
            model.OnModelUpdate(Answer(model, "on"));

            Assert.That(model.Label, Is.EqualTo("off"), "The answer after the second reconnect put the value from before the first drop back");
            var sent = SentAt(model, 212);
            Assert.That(sent, Is.Not.Null, "The value lost at the first drop was not sent again");
            Assert.That((string)sent["label"], Is.EqualTo("off"));
        }

        /// <summary>
        /// The answers arrive, and the value lost at the drop goes out again, but into a link that
        /// drops again soon after. The next round counts from the second outage, before which the
        /// change was first made; what the first answer held is still the server's value, and tells
        /// that the value sent again was lost too.
        /// </summary>
        [Test]
        public void AChangeSentAgainIsKeptWhenTheLinkDropsAgainBeforeItArrives()
        {
            var model = SpawnModelThatSent("on");
            Change(model, "off", 200);

            Sync.RequestModelsAgain(disconnectedAt: 202);
            model.OnModelUpdate(Answer(model, "on"));
            Assert.That((string)SentAt(model, 210)["label"], Is.EqualTo("off"), "Precondition: the lost value goes out again");
            EndOfAnswers();

            Assert.That(200, Is.LessThan(212 - SentValues.WindowSeconds), "Precondition: the change was first made before the second outage's window");
            Sync.RequestModelsAgain(disconnectedAt: 212);
            model.OnModelUpdate(Answer(model, "on"));

            Assert.That(model.Label, Is.EqualTo("off"), "The answer after the second reconnect put the value from before the first drop back");
            var sent = SentAt(model, 213);
            Assert.That(sent, Is.Not.Null, "The value sent again and lost at the second drop was not sent again");
            Assert.That((string)sent["label"], Is.EqualTo("off"));
        }

        /// <summary>
        /// The link drops again before the answers, and comes back when no synced object is left to
        /// ask for again. The round left open by that drop ends there: the round after an outage
        /// much later counts from its own, and a value another client set during it is applied,
        /// although the object held it long before.
        /// </summary>
        [Test]
        public void ARoundLeftOpenWhenNoObjectIsLeftToAskForEndsAtTheReconnect()
        {
            var destroyed = SpawnModelThatSent("before");
            Sync.RequestModelsAgain(disconnectedAt: 103);
            var lostWithTheLink = Sync.ReconnectRoundEndMarker;
            Sync.RemoveModelUpdateListener(destroyed.Channel, destroyed.OnModelUpdate);

            Sync.RequestModelsAgain(disconnectedAt: 110);
            Assert.That(Sync.ReconnectRoundEndMarker, Is.Not.EqualTo(lostWithTheLink), "The round whose answers were lost with the link is still open");
            EndOfAnswers();

            var model = SpawnModel();
            model.OnModelUpdate(Bare(model.Id));
            Change(model, "first", 400);
            Change(model, "second", 450);
            Sync.RequestModelsAgain(disconnectedAt: 500);
            model.OnModelUpdate(Answer(model, "first"));

            Assert.That(model.Label, Is.EqualTo("first"), "Another client's change during the later outage was undone");
            Assert.That(SentAt(model, 501), Is.Null);
        }

        /// <summary>
        /// Once the answers to a reconnect are all in, the next outage has a window of its own: a
        /// value sent long before it arrived for certain, and another client set the one before it
        /// again.
        /// </summary>
        [Test]
        public void AfterTheAnswersAreInTheNextRoundCountsFromItsOwnOutage()
        {
            var model = SpawnModelThatSent("first");
            Change(model, "second", 101);
            Sync.RequestModelsAgain(disconnectedAt: 103);
            model.OnModelUpdate(Answer(model, "second"));
            EndOfAnswers();

            Sync.RequestModelsAgain(disconnectedAt: 101 + SentValues.WindowSeconds + 1);
            model.OnModelUpdate(Answer(model, "first"));

            Assert.That(model.Label, Is.EqualTo("first"), "The answer after the second outage was judged against values from before the first");
            Assert.That(SentAt(model, 200), Is.Null);
        }

        /// <summary>
        /// An object that never sent anything - one a manager built from another client's update -
        /// takes the answer as it always did.
        /// </summary>
        [Test]
        public void AnObjectThatNeverSentAnythingAppliesTheAnswer()
        {
            var model = SpawnModel();
            model.OnModelUpdate(Answer(model, "theirs"));

            Sync.RequestModelsAgain(disconnectedAt: 103);
            model.OnModelUpdate(Answer(model, "theirs, changed offline", 4));

            Assert.That(model.Label, Is.EqualTo("theirs, changed offline"));
            Assert.That(model.Count, Is.EqualTo(4));
            Assert.That(SentAt(model, 104), Is.Null);
        }

        /// <summary>
        /// Changed long before the outage: another client setting the member back to one of those
        /// values during the outage looks the same as a lost change, so they do not count.
        /// </summary>
        [Test]
        public void ValuesSentLongBeforeTheOutageDoNotCount()
        {
            var model = SpawnModelThatSent("first");
            Change(model, "second", 101);

            Sync.RequestModelsAgain(disconnectedAt: 101 + SentValues.WindowSeconds + 1);
            model.OnModelUpdate(Answer(model, "first"));

            Assert.That(model.Label, Is.EqualTo("first"));
            Assert.That(SentAt(model, 200), Is.Null);
        }

        /// <summary>
        /// Once the member has taken another client's value, what it sent before says nothing about
        /// the server: set back to one of those values during the outage, it is that client's change.
        /// </summary>
        [Test]
        public void ValuesSentBeforeTakingAnotherClientsValueDoNotCount()
        {
            var model = SpawnModelThatSent("first");
            Change(model, "second", 101);
            model.OnModelUpdate(Answer(model, "theirs"));
            Change(model, "mine", 102);

            Sync.RequestModelsAgain(disconnectedAt: 103);
            model.OnModelUpdate(Answer(model, "first"));

            Assert.That(model.Label, Is.EqualTo("first"));
            Assert.That(SentAt(model, 104), Is.Null);
        }

        /// <summary>
        /// The case the window alone missed: a member left alone for longer than the window, then
        /// changed once at the drop - an object switched off after a minute switched on. Nothing but
        /// the lost value was sent in the window, and the answer holds the value the member had held
        /// all along: that change was lost.
        /// </summary>
        [Test]
        public void AChangeAfterAQuietSpellLostWithTheConnectionIsKeptAndSentAgain()
        {
            var model = SpawnModelThatSent("held for a while");
            Change(model, "lost at the drop", 200);

            const double outage = 202;
            Assert.That(100, Is.LessThan(outage - SentValues.WindowSeconds), "Precondition: the first value was sent before the window");
            Sync.RequestModelsAgain(disconnectedAt: outage);
            model.OnModelUpdate(Answer(model, "held for a while"));

            Assert.That(model.Label, Is.EqualTo("lost at the drop"), "The answer put the value from before the quiet spell back");
            var sent = SentAt(model, 203);
            Assert.That(sent, Is.Not.Null, "The value that was lost was not sent again");
            Assert.That(Members(sent), Is.EqualTo(new[] { "id", "label" }), $"Only what was lost goes out again: {sent}");
            Assert.That((string)sent["label"], Is.EqualTo("lost at the drop"));
        }

        /// <summary>
        /// The same for a value this object never sent: the server's, applied when the object came
        /// up, and held ever since.
        /// </summary>
        [Test]
        public void AChangeToTheStateTheObjectCameUpWithLostWithTheConnectionIsKeptAndSentAgain()
        {
            var model = SpawnModel();
            model.OnModelUpdate(Answer(model, "the server's", 2));
            Change(model, "lost at the drop", 200);

            Sync.RequestModelsAgain(disconnectedAt: 202);
            model.OnModelUpdate(Answer(model, "the server's", 2));

            Assert.That(model.Label, Is.EqualTo("lost at the drop"), "The answer put the state the object came up with back");
            var sent = SentAt(model, 203);
            Assert.That(sent, Is.Not.Null, "The value that was lost was not sent again");
            Assert.That(Members(sent), Is.EqualTo(new[] { "id", "label" }), $"Only what was lost goes out again: {sent}");
        }

        /// <summary>
        /// Taking another client's value forgets what the member sent before, but not the value
        /// taken: the first change after it, lost at the drop, is recognised by it.
        /// </summary>
        [Test]
        public void TheFirstChangeAfterAnotherClientsValueLostWithTheConnectionIsKeptAndSentAgain()
        {
            var model = SpawnModelThatSent("mine");
            model.OnModelUpdate(Relayed(model, "label", "theirs"));
            Assert.That(model.Label, Is.EqualTo("theirs"), "Precondition: the other client's value is applied");
            Change(model, "lost at the drop", 101);

            Sync.RequestModelsAgain(disconnectedAt: 103);
            model.OnModelUpdate(Answer(model, "theirs"));

            Assert.That(model.Label, Is.EqualTo("lost at the drop"), "The answer put the other client's value back");
            var sent = SentAt(model, 104);
            Assert.That(sent, Is.Not.Null, "The value that was lost was not sent again");
            Assert.That((string)sent["label"], Is.EqualTo("lost at the drop"));
        }

        /// <summary>
        /// A JObject member's value is the application's own object, which it may change in place.
        /// The value taken from another client is kept as a copy, so an answer holding it still tells
        /// that the change made after it was lost, whatever the application did to the object.
        /// </summary>
        [Test]
        public void AJObjectTakenAndThenChangedInPlaceStillTellsTheChangeAfterItWasLost()
        {
            var model = Spawn<ResyncJsonModel>("resync-json");
            model.Wake();
            model.OnModelUpdate(Bare(model.Id));
            model.OnModelUpdate(new JObject { { "id", model.Id }, { "data", new JObject { { "k", 1 } } } });
            Assert.That((int)model.Data["k"], Is.EqualTo(1), "Precondition: the other client's value is applied");

            // Changed in place, which the poll does not see, then replaced, which it does.
            model.Data["k"] = 2;
            model.Data = new JObject { { "k", 3 } };
            Poll(model);
            Assert.That(SentAt(model, 200), Is.Not.Null, "Precondition: the change goes out");

            Sync.RequestModelsAgain(disconnectedAt: 202);
            model.OnModelUpdate(new JObject { { "id", model.Id }, { "data", new JObject { { "k", 1 } } } });

            Assert.That((int)model.Data["k"], Is.EqualTo(3), "The answer put the value taken from the other client back");
            var sent = SentAt(model, 203);
            Assert.That(sent, Is.Not.Null, "The value that was lost was not sent again");
            Assert.That((int)sent["data"]["k"], Is.EqualTo(3));
        }

        /// <summary>
        /// The value held when the window began counts, but nothing else does: after a quiet spell, a
        /// value this member never held is another client's, and still wins over the one lost.
        /// </summary>
        [Test]
        public void AValueThisMemberNeverHeldStillWinsAfterAQuietSpell()
        {
            var model = SpawnModelThatSent("held for a while");
            model.OnModelUpdate(Relayed(model, "count", 4));
            Change(model, "lost at the drop", 200);
            model.Count = 5;
            Poll(model);
            Assert.That(SentAt(model, 200.5), Is.Not.Null);

            Sync.RequestModelsAgain(disconnectedAt: 202);
            model.OnModelUpdate(Answer(model, "theirs", 6));

            Assert.That(model.Label, Is.EqualTo("theirs"), "The other client's label, set during the outage, was not applied");
            Assert.That(model.Count, Is.EqualTo(6), "The other client's count, set during the outage, was not applied");
            Assert.That(SentAt(model, 203), Is.Null);
        }


        /*
         *  The first answer, to the request an object makes when it registers. A member changed
         *  before it arrives, in Start, in an OnConnected handler or by a user right after Play,
         *  keeps its value and goes out; every other member takes the answer.
         */

        /// <summary>
        /// The answer to the request an object sent at its first answer, ahead of the changes it
        /// kept there (see Sync.AskForEndOfAnswers): the answers made before the server read them
        /// are all in.
        /// </summary>
        private static void EndOfAnswersFor<T>(SyncBehaviour<T> model) where T : SyncBehaviour<T>
        {
            var marker = model.RoundEndMarker;
            Assert.That(marker, Is.Not.Null, "Precondition: the object keeps changes made before its first answer");
            Sync.OnServerMessage(Sync.ReconnectRoundChannel, "model::update", new JObject { { "id", marker } });
        }

        /// <summary>
        /// The bug, as found in Unity on Windows: a placed SyncTransform hidden half a second after
        /// Play, before the server had answered, was shown again by the answer, and no other
        /// client ever saw it hidden.
        /// </summary>
        [Test]
        public void AnObjectHiddenBeforeTheFirstAnswerStaysHiddenAndIsHiddenElsewhere()
        {
            var sync = Spawn<ResyncTransform>("hidden-before-the-answer");
            sync.Wake();

            sync.gameObject.SetActive(false);
            Poll(sync);
            sync.OnModelUpdate(new JObject
            {
                { "id", sync.Id },
                { "active", true },
                { "position", new JArray(1f, 2f, 3f) },
            });

            Assert.That(sync.gameObject.activeSelf, Is.False, "The answer showed the object again");
            Assert.That(sync.transform.position, Is.EqualTo(new Vector3(1f, 2f, 3f)), "The position, not changed here, did not take the server's value");
            var sent = Sent(sync);
            Assert.That(sent, Is.Not.Null, "Hiding the object never went out");
            Assert.That(Members(sent), Is.EqualTo(new[] { "active", "id" }), $"Only what changed here goes out: {sent}");
            Assert.That((bool)sent["active"], Is.False);
        }

        /// <summary>
        /// Changed in the frame the answer arrives, before the poll has run: in an OnConnected
        /// handler, which is raised in the same Update as the answer is delivered, just before it.
        /// </summary>
        [Test]
        public void AChangeMadeJustBeforeTheFirstAnswerIsKeptAndSent()
        {
            var model = SpawnModel();

            model.Label = "mine";
            model.OnModelUpdate(Answer(model, "theirs", 5));

            Assert.That(model.Label, Is.EqualTo("mine"), "The answer put the server's value over the change");
            Assert.That(model.Count, Is.EqualTo(5), "The count, not changed here, did not take the server's value");
            var sent = Sent(model);
            Assert.That(sent, Is.Not.Null, "The change never went out");
            Assert.That(Members(sent), Is.EqualTo(new[] { "id", "label" }), $"Only what changed here goes out: {sent}");
            Assert.That((string)sent["label"], Is.EqualTo("mine"));
        }

        /// <summary>
        /// The server has nothing for the object yet. The change goes out all the same; the full
        /// state is still up to a manager's TriggerSync.
        /// </summary>
        [Test]
        public void AChangeMadeBeforeABareFirstAnswerIsSent()
        {
            var model = SpawnModel();

            model.Label = "mine";
            Poll(model);
            model.OnModelUpdate(Bare(model.Id));

            var sent = Sent(model);
            Assert.That(sent, Is.Not.Null, "The change never went out");
            Assert.That(Members(sent), Is.EqualTo(new[] { "id", "label" }), $"Only what changed here goes out: {sent}");
        }

        /// <summary>
        /// What the object had when it registered, from the scene, the prefab or Awake before
        /// base.Awake(), is no change: it takes the server's state, and nothing goes back.
        /// </summary>
        [Test]
        public void AMemberLeftAsItWasTakesTheFirstAnswerAndNothingGoesOut()
        {
            var model = Spawn<ResyncModel>("set-in-the-scene");
            model.Label = "from the scene";
            model.Wake();
            Poll(model);

            model.OnModelUpdate(Answer(model, "theirs", 5));
            Poll(model);

            Assert.That(model.Label, Is.EqualTo("theirs"));
            Assert.That(model.Count, Is.EqualTo(5));
            Assert.That(Sent(model), Is.Null, "A value the object registered with went out over the server's");
            Assert.That(model.RoundEndMarker, Is.Null, "Nothing was kept, and nothing needs asking for");
        }

        /// <summary>A member changed and set back before the answer holds what it registered with.</summary>
        [Test]
        public void AMemberChangedAndSetBackBeforeTheFirstAnswerTakesIt()
        {
            var model = SpawnModel();

            model.Label = "for a moment";
            Poll(model);
            model.Label = "";
            Poll(model);
            model.OnModelUpdate(Answer(model, "theirs"));

            Assert.That(model.Label, Is.EqualTo("theirs"));
            Assert.That(Sent(model), Is.Null);
        }

        /// <summary>
        /// A manager on the channel asked for every model on it, and its answer holds this object
        /// too, as the server had it before it read the change; so does another client's update
        /// relayed before then. Neither puts the old value back. Once the answer to the request
        /// sent ahead of the change is in, an update is applied as it arrives.
        /// </summary>
        [Test]
        public void AChangeKeptAtTheFirstAnswerTakesNothingFromTheAnswersStillOnTheirWay()
        {
            var model = SpawnModel();
            System.Action<JObject> manager = _ => { };
            Sync.AddModelUpdateListener(model.Channel, manager);
            try
            {
                model.Label = "mine";
                Poll(model);

                model.OnModelUpdate(Answer(model, "theirs", 5));
                Assert.That((string)Sent(model)?["label"], Is.EqualTo("mine"), "The change never went out");

                model.OnModelUpdate(Answer(model, "theirs", 5));
                model.OnModelUpdate(Relayed(model, "label", "theirs, sent before the server read ours"));
                Assert.That(model.Label, Is.EqualTo("mine"), "An answer still on its way put the server's older value back");
                Assert.That(model.Count, Is.EqualTo(5));
                Assert.That(Sent(model), Is.Null, "The change went out a second time");

                EndOfAnswersFor(model);
                model.OnModelUpdate(Relayed(model, "label", "theirs, sent after"));
                Assert.That(model.Label, Is.EqualTo("theirs, sent after"), "After the answers, another client's update should be applied as it arrives");
                Assert.That(Sent(model), Is.Null);
            }
            finally
            {
                Sync.RemoveModelUpdateListener(model.Channel, manager);
            }
        }

        /// <summary>
        /// An object registered during an outage has its first answer in the round after the
        /// reconnect, and its request again is answered there too. The change is kept for the
        /// whole round, and goes out once.
        /// </summary>
        [Test]
        public void AChangeMadeBeforeAFirstAnswerAfterAReconnectIsKeptForTheRound()
        {
            var model = SpawnModel();
            Sync.RequestModelsAgain(disconnectedAt: 103);

            model.Label = "mine";
            Poll(model);
            model.OnModelUpdate(Answer(model, "theirs", 5));
            Assert.That(model.RoundEndMarker, Is.EqualTo(Sync.ReconnectRoundEndMarker), "The object opened a round of its own inside the round after the reconnect");
            var sent = SentAt(model, 104);
            model.OnModelUpdate(Answer(model, "theirs", 5));
            EndOfAnswers();

            Assert.That(model.Label, Is.EqualTo("mine"), "An answer put the server's value over the change");
            Assert.That(model.Count, Is.EqualTo(5));
            Assert.That(sent, Is.Not.Null, "The change never went out");
            Assert.That((string)sent["label"], Is.EqualTo("mine"));
            Assert.That(SentAt(model, 105), Is.Null, "The change went out a second time");
        }

        /// <summary>
        /// An object a manager builds from another client's update takes that update as its state:
        /// a value its own Awake set is the template's, and goes out over nothing.
        /// </summary>
        [Test]
        public void AnObjectBuiltFromAnotherClientsUpdateTakesItWhateverItsAwakeSet()
        {
            var id = System.Guid.NewGuid().ToString();
            var model = Spawn<ResyncModel>("built-from-an-update");
            model.Id = id;
            SyncBehaviour<ResyncModel>.RemoteModelBeingBuilt = id;
            try
            {
                model.Wake();
            }
            finally
            {
                SyncBehaviour<ResyncModel>.RemoteModelBeingBuilt = null;
            }

            // What a model's own Awake might do after base.Awake().
            model.Label = "the template's";
            model.OnModelUpdate(new JObject { { "id", id }, { "label", "theirs" } });

            Assert.That(model.Label, Is.EqualTo("theirs"));
            Assert.That(Sent(model), Is.Null);
        }


        /*
         *  A body whose PhysicsAuthority is ticked in the scene has it on every client until the
         *  first answer. Simulated meanwhile, it fell, and that counted as a change made here.
         */

        /// <summary>A Unity message of GenericSyncTransform's, which edit mode never sends.</summary>
        private static void Deliver(ResyncTransform sync, string message)
            => typeof(GenericSyncTransform<ResyncTransform>)
                .GetMethod(message, BindingFlags.Instance | BindingFlags.NonPublic)
                .Invoke(sync, null);

        /// <summary>One fixed step: SyncTransform's FixedUpdate, then gravity.</summary>
        private static void FixedStep(ResyncTransform sync)
        {
            Deliver(sync, "FixedUpdate");
            Fall(sync);
        }

        /// <summary>One fixed step, with FixedUpdate run at <paramref name="now"/> on SyncTicker's clock.</summary>
        private static void FixedStepAt(ResyncTransform sync, double now)
        {
            sync.HoldOrSimulate(now);
            Fall(sync);
        }

        /// <summary>Gravity, as the physics engine would apply it to a body that is not kinematic.</summary>
        private static void Fall(ResyncTransform sync)
        {
            if (sync.GetComponent<Rigidbody>().isKinematic)
                return;

            var position = sync.transform.position;
            sync.transform.position = new Vector3(position.x, position.y - 0.01f, position.z);
        }

        /// <summary>
        /// A ball with a dynamic Rigidbody and PhysicsAuthority ticked, at (0, 1, 0), awake and
        /// started. Placed in the scene, it has the id the scene gave it; created here, it makes
        /// one in Awake.
        /// </summary>
        private ResyncTransform SpawnBall(bool placed)
        {
            var sync = Spawn<ResyncTransform>("ball");
            sync.gameObject.AddComponent<Rigidbody>();
            sync.transform.position = new Vector3(0f, 1f, 0f);
            if (placed)
                sync.Id = System.Guid.NewGuid().ToString();
            sync.PhysicsAuthority = true;
            sync.Wake();
            Deliver(sync, "Start");
            return sync;
        }

        /// <summary>
        /// Another client had the authority, and the ball lies where it threw it. A client that
        /// joins takes that position, and gives up the authority, without sending the one its own
        /// simulation reached before the answer.
        /// </summary>
        [Test]
        public void APlacedBodyWithPhysicsAuthorityTickedTakesTheSharedPositionAtTheFirstAnswer()
        {
            var sync = SpawnBall(placed: true);

            FixedStep(sync);
            Poll(sync);
            FixedStep(sync);
            Poll(sync);
            sync.OnModelUpdate(new JObject
            {
                { "id", sync.Id },
                { "active", true },
                { "position", new JArray(3f, 0f, 3f) },
                { "physicsid", "another client's" },
            });
            FixedStep(sync);
            Poll(sync);

            Assert.That(sync.transform.position, Is.EqualTo(new Vector3(3f, 0f, 3f)), "The ball did not take the shared position");
            Assert.That(Sent(sync), Is.Null, "The position the ball fell to before the answer went out over the shared one");
            Assert.That(sync.PhysicsAuthority, Is.False);
            Assert.That(sync.GetComponent<Rigidbody>().isKinematic, Is.True);
        }

        /// <summary>The first client keeps the authority, and simulates once the answer is in.</summary>
        [Test]
        public void APlacedBodyWithPhysicsAuthorityTickedIsSimulatedOnceTheFirstAnswerIsIn()
        {
            var sync = SpawnBall(placed: true);

            FixedStep(sync);
            Assert.That(sync.GetComponent<Rigidbody>().isKinematic, Is.True, "Simulated before the server's state was known");

            sync.OnModelUpdate(Bare(sync.Id));
            FixedStep(sync);
            Poll(sync);

            Assert.That(sync.GetComponent<Rigidbody>().isKinematic, Is.False);
            var sent = Sent(sync);
            Assert.That(sent, Is.Not.Null, "The fall never went out");
            Assert.That(Members(sent), Is.EqualTo(new[] { "id", "position" }), $"{sent}");
        }

        /// <summary>
        /// A ball created here, thrown at once: the server holds nothing for an id made in Awake,
        /// so the body does not wait for the answer, and the throw is not lost.
        /// </summary>
        [Test]
        public void ABodyCreatedHereIsSimulatedBeforeTheFirstAnswer()
        {
            var sync = SpawnBall(placed: false);

            FixedStep(sync);

            Assert.That(sync.GetComponent<Rigidbody>().isKinematic, Is.False);
        }


        /*
         *  Without a server, a placed body waited for its first answer for good. Once this client
         *  has been without one for the connect timeout, it is simulated without the server's state.
         *  Each test counts from Time.unscaledTimeAsDouble after its first ball woke: that ball's
         *  Awake made the connection, and the time without a server counts from then.
         */

        private static readonly double ConnectTimeout = WebServerConnection.CONNECT_TIMEOUT_MS / 1000.0;

        /// <summary>The console's warnings that bodies are simulated without a server, while it is not disposed.</summary>
        private sealed class NoServerWarnings : System.IDisposable
        {
            public readonly List<string> Messages = new List<string>();

            public NoServerWarnings() => Application.logMessageReceived += OnLog;

            public void Dispose() => Application.logMessageReceived -= OnLog;

            private void OnLog(string message, string stackTrace, LogType type)
            {
                if (type == LogType.Warning && message.StartsWith("Colibri: no connection to a server for "))
                    Messages.Add(message);
            }
        }

        /// <summary>
        /// The status of the connection the balls took up, set as its connection loop would set it,
        /// and back to Disconnected, where edit mode leaves it, once disposed: the connection is a
        /// singleton, not the test's own.
        /// </summary>
        private sealed class ConnectionStatusSet : System.IDisposable
        {
            public void To(ConnectionStatus status)
                => Assert.That(WebServerConnection.Instance.TrySetStatus(status, CancellationToken.None), Is.True);

            public void Dispose() => WebServerConnection.Instance.TrySetStatus(ConnectionStatus.Disconnected, CancellationToken.None);
        }

        /// <summary>While the client connects, the body waits for the server's state.</summary>
        [Test]
        public void APlacedBodyIsHeldWhileTheClientConnects()
        {
            using var warnings = new NoServerWarnings();
            var sync = SpawnBall(placed: true);
            var start = Time.unscaledTimeAsDouble;

            foreach (var after in new[] { 0.0, 1.0, ConnectTimeout - 0.5 })
            {
                FixedStepAt(sync, start + after);
                Poll(sync);
                Assert.That(sync.GetComponent<Rigidbody>().isKinematic, Is.True, $"Simulated {after} s after the client started connecting");
            }

            Assert.That(sync.transform.position, Is.EqualTo(new Vector3(0f, 1f, 0f)));
            Assert.That(Sent(sync), Is.Null);
            Assert.That(warnings.Messages, Is.Empty);
        }

        /// <summary>No server within the connect timeout: the body is simulated without the server's state.</summary>
        [Test]
        public void APlacedBodyIsSimulatedOnceNoServerIsReachedWithinTheConnectTimeout()
        {
            var sync = SpawnBall(placed: true);
            var start = Time.unscaledTimeAsDouble;

            FixedStepAt(sync, start);
            FixedStepAt(sync, start + ConnectTimeout + 0.5);
            Assert.That(sync.GetComponent<Rigidbody>().isKinematic, Is.False, "Still held after the connect timeout");

            FixedStepAt(sync, start + ConnectTimeout + 1);
            Assert.That(sync.GetComponent<Rigidbody>().isKinematic, Is.False);
            Assert.That(sync.transform.position.y, Is.LessThan(1f), "The ball did not fall");
        }

        /// <summary>Said once per session, not once for every body.</summary>
        [Test]
        public void BodiesSimulatedWithoutAServerAreReportedOnce()
        {
            using var warnings = new NoServerWarnings();
            var first = SpawnBall(placed: true);
            var second = SpawnBall(placed: true);
            var start = Time.unscaledTimeAsDouble;

            foreach (var after in new[] { 0.0, ConnectTimeout + 0.5, ConnectTimeout + 1 })
            {
                FixedStepAt(first, start + after);
                FixedStepAt(second, start + after);
            }
            var third = SpawnBall(placed: true);
            FixedStepAt(third, start + ConnectTimeout + 2);

            Assert.That(new[] { first, second, third }.Select(b => b.GetComponent<Rigidbody>().isKinematic), Is.All.False);
            Assert.That(warnings.Messages, Has.Count.EqualTo(1));
            Assert.That(warnings.Messages[0], Does.Contain("Start colibri-server, or check the server address"));
        }

        /// <summary>
        /// A server reached in time is waited for, however long its answer takes, and the body
        /// takes the shared position from it as before.
        /// </summary>
        [Test]
        public void APlacedBodyWaitsForTheAnswerOfAServerReachedInTime()
        {
            using var warnings = new NoServerWarnings();
            var sync = SpawnBall(placed: true);
            var start = Time.unscaledTimeAsDouble;

            FixedStepAt(sync, start);
            Poll(sync);
            Sync.OnConnected();
            FixedStepAt(sync, start + 1);
            Poll(sync);
            FixedStepAt(sync, start + ConnectTimeout + 0.5);
            Poll(sync);
            Assert.That(sync.GetComponent<Rigidbody>().isKinematic, Is.True, "Simulated before the answer of a server that was reached");

            sync.OnModelUpdate(new JObject
            {
                { "id", sync.Id },
                { "active", true },
                { "position", new JArray(3f, 0f, 3f) },
                { "physicsid", "another client's" },
            });
            FixedStepAt(sync, start + ConnectTimeout + 1);
            Poll(sync);

            Assert.That(sync.transform.position, Is.EqualTo(new Vector3(3f, 0f, 3f)));
            Assert.That(Sent(sync), Is.Null);
            Assert.That(sync.PhysicsAuthority, Is.False);
            Assert.That(sync.GetComponent<Rigidbody>().isKinematic, Is.True);
            Assert.That(warnings.Messages, Is.Empty);
        }

        /// <summary>
        /// The connection comes up on a worker thread, and OnConnected follows in the next Update,
        /// after that frame's FixedUpdates. A connection up by then is a server reached in time.
        /// </summary>
        [Test]
        public void APlacedBodyWaitsForTheAnswerOfAConnectionUpBeforeOnConnected()
        {
            using var warnings = new NoServerWarnings();
            var sync = SpawnBall(placed: true);
            var start = Time.unscaledTimeAsDouble;
            using var status = new ConnectionStatusSet();

            FixedStepAt(sync, start);
            Poll(sync);
            status.To(ConnectionStatus.Connected);
            FixedStepAt(sync, start + ConnectTimeout + 0.01);
            Poll(sync);
            Assert.That(sync.GetComponent<Rigidbody>().isKinematic, Is.True, "Simulated while the connection was up");

            Sync.OnConnected();
            sync.OnModelUpdate(new JObject
            {
                { "id", sync.Id },
                { "active", true },
                { "position", new JArray(3f, 0f, 3f) },
                { "physicsid", "another client's" },
            });
            FixedStepAt(sync, start + ConnectTimeout + 0.03);
            Poll(sync);

            Assert.That(sync.transform.position, Is.EqualTo(new Vector3(3f, 0f, 3f)));
            Assert.That(Sent(sync), Is.Null);
            Assert.That(warnings.Messages, Is.Empty);
        }

        /// <summary>
        /// A connect attempt gives up after the connect timeout itself, and may have started after
        /// the frame the time is counted from. The body waits for it, the first or a later one, and
        /// stops waiting when it fails.
        /// </summary>
        [TestCase(ConnectionStatus.Connecting)]
        [TestCase(ConnectionStatus.Reconnecting)]
        public void APlacedBodyWaitsForAConnectAttemptUnderWay(ConnectionStatus attempt)
        {
            using var warnings = new NoServerWarnings();
            var sync = SpawnBall(placed: true);
            var start = Time.unscaledTimeAsDouble;
            using var status = new ConnectionStatusSet();

            FixedStepAt(sync, start);
            status.To(attempt);
            FixedStepAt(sync, start + ConnectTimeout + 1);
            Assert.That(sync.GetComponent<Rigidbody>().isKinematic, Is.True, "Simulated during a connect attempt");
            Assert.That(warnings.Messages, Is.Empty);

            status.To(ConnectionStatus.Disconnected);
            FixedStepAt(sync, start + ConnectTimeout + 1.5);

            Assert.That(sync.GetComponent<Rigidbody>().isKinematic, Is.False, "Still held after the attempt failed");
            Assert.That(warnings.Messages, Has.Count.EqualTo(1));
        }

        /// <summary>
        /// A body simulated without the server's state goes on being simulated when the connection
        /// comes up. At its first answer, the position it fell to is a change made before the
        /// answer, and goes out over the shared one: the accepted cost of starting without a server.
        /// </summary>
        [Test]
        public void ABodySimulatedWithoutAServerSendsWhereItFellAtItsFirstAnswer()
        {
            var sync = SpawnBall(placed: true);
            var start = Time.unscaledTimeAsDouble;

            FixedStepAt(sync, start);
            FixedStepAt(sync, start + ConnectTimeout + 0.5);
            Poll(sync);
            Sync.OnConnected();
            FixedStepAt(sync, start + ConnectTimeout + 1);
            Poll(sync);
            Assert.That(sync.GetComponent<Rigidbody>().isKinematic, Is.False, "Held again when the connection came up");
            var fellTo = sync.transform.position;

            sync.OnModelUpdate(new JObject
            {
                { "id", sync.Id },
                { "active", true },
                { "position", new JArray(3f, 0f, 3f) },
                { "physicsid", "another client's" },
            });
            FixedStepAt(sync, start + ConnectTimeout + 1.5);
            Poll(sync);

            var sent = Sent(sync);
            Assert.That(sent, Is.Not.Null, "The position the ball fell to never went out");
            Assert.That(Members(sent), Is.EqualTo(new[] { "id", "position" }), $"{sent}");
            Assert.That(sent["position"].ToVector3(), Is.EqualTo(fellTo));
            Assert.That(sync.PhysicsAuthority, Is.False, "The client that holds the authority keeps it");
            Assert.That(sync.GetComponent<Rigidbody>().isKinematic, Is.True);
        }
    }
}
