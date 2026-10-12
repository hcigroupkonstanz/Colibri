using System;
using System.Collections;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using HCIKonstanz.Colibri.Core;
using HCIKonstanz.Colibri.Synchronization;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace HCIKonstanz.Colibri.E2E
{
    /// <summary>A model with one [Sync] member of each shape application code is likely to reach for.</summary>
    public class E2ESyncModel : SyncBehaviour<E2ESyncModel>
    {
        [Sync]
        public string Label = "";

        /// <summary>Private and serialized, the way an Inspector-driven field is normally written.</summary>
        [Sync, SerializeField]
        private int _count;

        [Sync]
        public Vector3 Where { get; set; }

        public int Count
        {
            get => _count;
            set => _count = value;
        }
    }

    public class E2ESyncModelManager : SyncBehaviourManager<E2ESyncModel>
    {
    }

    /// <summary>A model with a [Sync] setter that throws for one value, as a setter in application code can.</summary>
    public class E2EFragileModel : SyncBehaviour<E2EFragileModel>
    {
        public const string Refused = "refused";

        private string _label = "";

        [Sync]
        public string Label
        {
            get => _label;
            set
            {
                if (value == Refused)
                    throw new InvalidOperationException($"E2EFragileModel does not take the label '{Refused}'");
                _label = value;
            }
        }
    }

    public class E2EFragileModelManager : SyncBehaviourManager<E2EFragileModel>
    {
    }

    /// <summary>
    /// <c>SyncBehaviour</c> over a real server: what actually goes on the wire when a [Sync] member
    /// changes, and what happens at the other end when a model arrives that this client has never
    /// seen.
    /// </summary>
    public class SyncModelTests : ColibriE2EFixture
    {
        /// <summary><c>SyncBehaviour</c> derives its channel from the type name, lowercased.</summary>
        private const string Channel = "e2esyncmodel";

        /// <summary>
        /// A model sends nothing until the server has answered its <c>model::request</c>, and then
        /// sends what changed since it registered, together. So every test here lets that round
        /// trip finish before it touches a field, and each change goes out on its own.
        /// </summary>
        private static IEnumerator LetInitialStateArrive() => E2EServer.Settle(1.5f);

        [UnityTest]
        public IEnumerator APublicFieldReachesTheOtherClient()
        {
            var model = SpawnConfigured<E2ESyncModel>("model", _ => { });
            yield return LetInitialStateArrive();

            model.Label = "hello";

            yield return Peer.Expect(Channel, "model::update", frame =>
            {
                var payload = TcpPeer.Json(frame);
                Assert.That(payload["id"].Value<string>(), Is.EqualTo(model.Id));
                Assert.That(payload["label"].Value<string>(), Is.EqualTo("hello"));
            });
        }

        [UnityTest]
        public IEnumerator APrivateSerializedFieldReachesTheOtherClient()
        {
            var model = SpawnConfigured<E2ESyncModel>("model", _ => { });
            yield return LetInitialStateArrive();

            model.Count = 7;

            yield return Peer.Expect(Channel, "model::update",
                frame => Assert.That(TcpPeer.Json(frame)["_count"].Value<int>(), Is.EqualTo(7)));
        }

        [UnityTest]
        public IEnumerator APropertyReachesTheOtherClient()
        {
            var model = SpawnConfigured<E2ESyncModel>("model", _ => { });
            yield return LetInitialStateArrive();

            model.Where = new Vector3(1f, 2f, 3f);

            yield return Peer.Expect(Channel, "model::update",
                frame => Assert.That(TcpPeer.Json(frame)["where"].ToString(Newtonsoft.Json.Formatting.None),
                    Is.EqualTo("[1.0,2.0,3.0]")));
        }

        /// <summary>
        /// One message per frame carrying only what changed, not one message per changed member and
        /// not the whole model. This is the difference between a sync loop that scales and one that
        /// floods the server with every field of every object.
        /// </summary>
        [UnityTest]
        public IEnumerator OnlyTheChangedMembersAreSent()
        {
            var model = SpawnConfigured<E2ESyncModel>("model", _ => { });
            yield return LetInitialStateArrive();

            model.Label = "only this";

            yield return Peer.Expect(Channel, "model::update", frame =>
            {
                var payload = (JObject)TcpPeer.Json(frame);
                var members = payload.Properties().Select(p => p.Name).OrderBy(n => n).ToArray();

                Assert.That(members, Is.EqualTo(new[] { "id", "label" }),
                    $"Expected only the changed member alongside the id, got {string.Join(", ", members)}");
            });
        }

        [UnityTest]
        public IEnumerator SeveralMembersChangedInOneFrameTravelAsOneMessage()
        {
            var model = SpawnConfigured<E2ESyncModel>("model", _ => { });
            yield return LetInitialStateArrive();

            model.Label = "both";
            model.Count = 3;

            yield return Peer.Expect(Channel, "model::update", frame =>
            {
                var payload = (JObject)TcpPeer.Json(frame);
                Assert.That(payload["label"].Value<string>(), Is.EqualTo("both"));
                Assert.That(payload["_count"].Value<int>(), Is.EqualTo(3));
            });

            yield return Peer.ExpectNothing(Channel);
        }

        /// <summary>
        /// A value from another client must not cost this client its next change of the same
        /// member. Echo suppression used to be a "swallow the next change" flag per member, set
        /// whenever an update changed the value. When the poll then saw no change - two updates
        /// that ended where they started before it ran - the flag stayed set and ate the next
        /// genuine local change: never sent, nothing logged.
        /// </summary>
        /// <remarks>
        /// Turning the component off stops the poll, which stands in for the two updates being
        /// handled in the same frame - a timing a test cannot arrange on purpose.
        /// </remarks>
        [UnityTest]
        public IEnumerator AValueFromAnotherClientDoesNotSwallowTheNextLocalChange()
        {
            var model = SpawnConfigured<E2ESyncModel>("model", _ => { });
            yield return LetInitialStateArrive();

            model.enabled = false;

            Peer.Send(Channel, "model::update", new JObject { { "id", model.Id }, { "label", "theirs" } });
            yield return E2EServer.WaitUntil(() => model.Label == "theirs", "The update from the peer never arrived");

            Peer.Send(Channel, "model::update", new JObject { { "id", model.Id }, { "label", "" } });
            yield return E2EServer.WaitUntil(() => model.Label == "", "The second update from the peer never arrived");

            model.enabled = true;

            // Neither value is this client's own, so neither may be echoed back.
            yield return Peer.ExpectNothing(Channel);

            model.Label = "mine";

            yield return Peer.Expect(Channel, "model::update",
                frame => Assert.That(TcpPeer.Json(frame)["label"].Value<string>(), Is.EqualTo("mine")));
        }

        /// <summary>
        /// A model this client has never seen arrives from someone else, and the manager builds it
        /// from the template - exactly once. Instantiating it twice is the classic failure here,
        /// and it is invisible until two clients start fighting over the same id.
        /// </summary>
        [UnityTest]
        public IEnumerator AModelFromAnotherClientIsInstantiatedExactlyOnce()
        {
            var template = SpawnConfigured<E2ESyncModel>("template", _ => { });
            var manager = Spawn<E2ESyncModelManager>("manager");
            manager.Template = template;

            // Start is where the manager subscribes; nothing before it runs would be seen.
            yield return null;
            yield return LetInitialStateArrive();

            var id = Guid.NewGuid().ToString();
            Peer.Send(Channel, "model::update", new JObject { { "id", id }, { "label", "from the peer" } });

            yield return E2EServer.WaitUntil(() => Instances(id).Any(),
                $"The manager never instantiated the model '{id}' it was told about");

            // Long enough for a second instantiation to show up if the manager is going to make one.
            yield return E2EServer.Settle(1.5f);

            var instances = Instances(id);
            Assert.That(instances.Length, Is.EqualTo(1),
                $"The manager created {instances.Length} objects for one model");
            Assert.That(instances[0].Label, Is.EqualTo("from the peer"));

            foreach (var instance in instances)
                UnityEngine.Object.Destroy(instance.gameObject);
        }

        /// <summary>
        /// A manager without a template is how objects placed in the scene are synced, so it is not
        /// a mistake in itself. It used to warn at every Play regardless - the SyncTransform sample
        /// included - and now says so only when a model arrives that it would have to build, once,
        /// naming the model.
        /// </summary>
        [UnityTest]
        public IEnumerator AManagerWithoutATemplateWarnsOnceWhenItCannotBuildAModel()
        {
            var warnings = new System.Collections.Generic.List<string>();
            void OnLog(string message, string stackTrace, LogType type)
            {
                if (type == LogType.Warning && message.IndexOf("template", StringComparison.OrdinalIgnoreCase) >= 0)
                    warnings.Add(message);
            }

            Application.logMessageReceived += OnLog;
            Cleanup.Add(() => Application.logMessageReceived -= OnLog);

            var placed = SpawnConfigured<E2ESyncModel>("placed", _ => { });
            Spawn<E2ESyncModelManager>("manager-without-template");

            yield return null;
            yield return LetInitialStateArrive();

            // Updates for an object the scene has are no reason to warn.
            Peer.Send(Channel, "model::update", new JObject { { "id", placed.Id }, { "label", "known" } });
            yield return E2EServer.WaitUntil(() => placed.Label == "known", "The placed model never received its update");
            Assert.That(warnings, Is.Empty, "A manager without a template warned before it had anything to build");

            // Two updates of one unknown model and one of another: a single warning, for the first.
            var first = Guid.NewGuid().ToString();
            Peer.Send(Channel, "model::update", new JObject { { "id", first }, { "label", "a" } });
            Peer.Send(Channel, "model::update", new JObject { { "id", first }, { "label", "b" } });
            Peer.Send(Channel, "model::update", new JObject { { "id", Guid.NewGuid().ToString() }, { "label", "c" } });

            yield return E2EServer.WaitUntil(() => warnings.Count > 0,
                "The manager never said that it could not build a model it has no template for");
            yield return E2EServer.Settle(1f);

            Assert.That(warnings, Has.Count.EqualTo(1), string.Join("\n", warnings));
            Assert.That(warnings[0], Does.Contain(first));
            Assert.That(warnings[0], Does.Not.Contain("  "), "The message has a gap where a value is missing");
            Assert.That(Instances(first), Is.Empty);
        }

        /// <summary>
        /// Templates are often kept switched off in the scene, so that they are not objects of their
        /// own. A clone starts out as its template is, and a clone that is off never ran Awake: it
        /// never registered for its own updates or with the ticker, and stayed exactly as the first
        /// update had left it - invisible, deaf and mute.
        /// </summary>
        [UnityTest]
        public IEnumerator AModelBuiltFromAnInactiveTemplateIsVisibleAndKeepsSyncing()
        {
            var templateObject = Spawn("inactive-template");
            templateObject.SetActive(false);
            var template = templateObject.AddComponent<E2ESyncModel>();
            var manager = Spawn<E2ESyncModelManager>("manager");
            manager.Template = template;

            yield return null;
            yield return LetInitialStateArrive();

            var id = Guid.NewGuid().ToString();
            Peer.Send(Channel, "model::update", new JObject { { "id", id }, { "label", "from the peer" } });

            yield return E2EServer.WaitUntil(() => Instances(id).Any(),
                $"The manager never instantiated the model '{id}' it was told about");

            var clone = Instances(id).Single();
            Assert.That(clone.gameObject.activeSelf, Is.True, "The clone of an inactive template stayed inactive");
            Assert.That(clone.Label, Is.EqualTo("from the peer"));
            Assert.That(templateObject.activeSelf, Is.False, "The template itself was switched on");

            // Later updates reach it...
            Peer.Send(Channel, "model::update", new JObject { { "id", id }, { "label", "changed" } });
            yield return E2EServer.WaitUntil(() => clone.Label == "changed", "The clone never received a later update");

            // ...without being echoed, and its own changes go out.
            yield return Peer.ExpectNothing(Channel);

            clone.Label = "local";
            yield return Peer.Expect(Channel, "model::update", frame =>
            {
                var payload = TcpPeer.Json(frame);
                Assert.That(payload["id"].Value<string>(), Is.EqualTo(id));
                Assert.That(payload["label"].Value<string>(), Is.EqualTo("local"));
            });
        }

        /// <summary>
        /// Applying the first state of a model from another client can throw - here a [Sync]
        /// setter refuses the value. The manager had switched its template off, given it the
        /// remote id and noted that it was building an object, and put none of that back: the
        /// template kept the other client's id, and no object created on this client afterwards
        /// ever sent its state, since the manager still believed each one was its own clone.
        /// </summary>
        [UnityTest]
        public IEnumerator AStateThatThrowsWhileItIsAppliedDoesNotStopTheManager()
        {
            const string channel = "e2efragilemodel";

            var templateObject = Spawn("fragile-template");
            templateObject.SetActive(false);
            var template = templateObject.AddComponent<E2EFragileModel>();
            var templateId = template.Id;
            var manager = Spawn<E2EFragileModelManager>("fragile-manager");
            manager.Template = template;

            yield return null;
            yield return LetInitialStateArrive();

            LogAssert.Expect(LogType.Error, new Regex($"^Colibri: a listener for model::update on channel '{channel}' threw an exception"));

            // The second update reaches the server before the clone can ask for its state, so
            // only building the clone meets the refused value.
            var id = Guid.NewGuid().ToString();
            Peer.Send(channel, "model::update", new JObject { { "id", id }, { "label", E2EFragileModel.Refused } });
            Peer.Send(channel, "model::update", new JObject { { "id", id }, { "label", "accepted" } });

            yield return E2EServer.WaitUntil(() => FragileInstances(id).Any(m => m.Label == "accepted"),
                $"The manager never built the model '{id}', or it never took the later update");

            var clones = FragileInstances(id);
            Assert.That(clones.Length, Is.EqualTo(1), $"{clones.Length} objects carry the id '{id}'");
            Assert.That(template.Id, Is.EqualTo(templateId), "The template kept the id of the model it was cloned for");
            Assert.That(template.enabled, Is.True, "The template was left switched off");
            Assert.That(clones[0].enabled, Is.True, "The clone was left switched off");

            // An object created here afterwards still sends its state.
            var local = SpawnConfigured<E2EFragileModel>("fragile-local", m => m.Label = "local");
            yield return Peer.Expect(channel, "model::update", frame =>
            {
                var payload = TcpPeer.Json(frame);
                Assert.That(payload["id"].Value<string>(), Is.EqualTo(local.Id));
                Assert.That(payload["label"].Value<string>(), Is.EqualTo("local"));
            });
        }

        /// <summary>
        /// A model this client has never seen is relayed to it, and a third client deletes it
        /// before this client's manager has built it. The object built from that update used to
        /// ask the server for its model, as an object created here does, which tells the server
        /// that the id is in use again: it lifted the tombstone of the delete. The next update the
        /// creating client had sent before it heard of the delete then created the model afresh,
        /// on the server and on every client.
        /// </summary>
        /// <remarks>
        /// Needs a server that treats a request for one id as bringing that id back into use;
        /// against one that does not, there is no tombstone to lift and this passes either way.
        /// </remarks>
        [UnityTest]
        public IEnumerator AModelDeletedBeforeTheManagerBuiltItStaysDeleted()
        {
            var template = SpawnConfigured<E2ESyncModel>("template", _ => { });
            var manager = Spawn<E2ESyncModelManager>("manager");
            manager.Template = template;
            yield return null;
            yield return LetInitialStateArrive();

            var deleter = Cleanup.Add(new TcpPeer());
            var id = Guid.NewGuid().ToString();
            yield return deleter.Connect("deleter");
            yield return E2EServer.Settle(0.3f);

            // No frame runs during the sleeps, so this client handles the relayed update only
            // after the server has taken the delete.
            Peer.Send(Channel, "model::update", new JObject { { "id", id }, { "label", "created" } });
            Thread.Sleep(300);
            deleter.Send(Channel, "model::delete", new JObject { { "id", id } });
            Thread.Sleep(300);
            yield return E2EServer.Settle(1f);

            // The creating client moves the object before the delete reaches it.
            Peer.Send(Channel, "model::update", new JObject { { "id", id }, { "where", new JArray(1f, 0f, 0f) } });
            yield return E2EServer.Settle(1f);

            Assert.That(Instances(id), Is.Empty, "The model deleted by the third client is back on this client");
            yield return AssertTheServerHoldsNothingOf(id);
        }

        /// <summary>
        /// While this client deletes an object, another client is still moving it. The update that
        /// client sent before the server had the delete is relayed here too, and arrives after the
        /// object is gone. The manager no longer knew the id and built the object again from it,
        /// with the template's values for every member the update did not carry, and nothing was
        /// going to delete it again.
        /// </summary>
        [UnityTest]
        public IEnumerator AnObjectDeletedHereIsNotBuiltAgainFromAnUpdateSentBeforeTheDelete()
        {
            var template = SpawnConfigured<E2ESyncModel>("template", _ => { });
            var manager = Spawn<E2ESyncModelManager>("manager");
            manager.Template = template;
            yield return null;
            yield return LetInitialStateArrive();

            var id = Guid.NewGuid().ToString();
            Peer.Send(Channel, "model::update", new JObject { { "id", id }, { "label", "created" }, { "where", new JArray(0f, 0f, 0f) } });
            yield return E2EServer.WaitUntil(() => Instances(id).Length == 1,
                $"The manager never instantiated the model '{id}' it was told about");
            yield return E2EServer.Settle(0.5f);
            var seen = Peer.Received.Count;

            // The peer moves the object, and the server relays that here before this client
            // deletes it. No frame runs during the sleep, so the update is handled only after
            // the delete.
            Peer.Send(Channel, "model::update", new JObject { { "id", id }, { "where", new JArray(1f, 0f, 0f) } });
            Thread.Sleep(300);
            UnityEngine.Object.DestroyImmediate(Instances(id).Single().gameObject);

            yield return E2EServer.Settle(1.5f);

            Assert.That(Instances(id), Is.Empty, "The object deleted here was built again from an update sent before the delete");

            var toThePeer = Peer.Received.Skip(seen)
                .Where(f => f.Channel == Channel && (string)TcpPeer.Json(f)["id"] == id)
                .ToArray();
            Assert.That(toThePeer.Select(f => f.Command).ToArray(), Is.EqualTo(new[] { "model::delete" }),
                "The peer should hear of the delete and nothing else: " + string.Join(", ", toThePeer.Select(f => $"{f.Command} {TcpPeer.Text(f)}")));

            yield return AssertTheServerHoldsNothingOf(id);
        }

        /// <summary>
        /// An object placed in the scene that a script switches off before the manager's Start
        /// runs, as one that is hidden until a session begins is. The manager only looked for
        /// objects that were switched on: it never had this one send its state, so the other
        /// clients never heard of it, and once it was shown they built it at the template's values.
        /// </summary>
        [UnityTest]
        public IEnumerator AnObjectSwitchedOffBeforeTheManagerStartedStillSendsItsState()
        {
            var placed = SpawnConfigured<E2ESyncModel>("placed-and-hidden", m => m.Label = "placed");
            placed.gameObject.SetActive(false);
            Spawn<E2ESyncModelManager>("manager-for-placed-objects");

            yield return E2EServer.WaitUntil(
                () => Peer.Received.Any(f => f.Channel == Channel && f.Command == "model::update"
                    && (string)TcpPeer.Json(f)["id"] == placed.Id && (string)TcpPeer.Json(f)["label"] == "placed"),
                "The object switched off before the manager started never sent its state", 5f);
        }

        /// <summary>
        /// The same object when the server holds its model already: its fixed id is in the store,
        /// say, since another client placed it first. Not known to the manager, the model in the
        /// answer to the manager's own request was built a second time, next to the object.
        /// </summary>
        [UnityTest]
        public IEnumerator AnObjectSwitchedOffBeforeTheManagerStartedIsNotBuiltASecondTime()
        {
            var id = Guid.NewGuid().ToString();
            Peer.Send(Channel, "model::update", new JObject { { "id", id }, { "label", "on the server" } });
            yield return E2EServer.Settle(0.5f);

            var templateObject = Spawn("inactive-template");
            templateObject.SetActive(false);
            var template = templateObject.AddComponent<E2ESyncModel>();

            var placed = SpawnConfigured<E2ESyncModel>("placed-and-hidden", m => m.Id = id);
            yield return E2EServer.WaitUntil(() => placed.Label == "on the server", "The placed object never received the model the server holds");
            placed.gameObject.SetActive(false);

            var manager = Spawn<E2ESyncModelManager>("manager");
            manager.Template = template;

            // Start, and the answer to the manager's request for every model on the channel.
            yield return null;
            yield return E2EServer.Settle(1.5f);

            var instances = Instances(id);
            Assert.That(instances, Is.EqualTo(new[] { placed }),
                $"{instances.Length} objects carry the id of the one object placed in the scene");
        }

        /// <summary>
        /// Only the deletes this client sent itself keep a manager from building a model. One
        /// another client deleted and then created again under the same id is built again here.
        /// </summary>
        [UnityTest]
        public IEnumerator AModelDeletedByAnotherClientIsBuiltAgainWhenItIsCreatedAgain()
        {
            var template = SpawnConfigured<E2ESyncModel>("template", _ => { });
            var manager = Spawn<E2ESyncModelManager>("manager");
            manager.Template = template;
            yield return null;
            yield return LetInitialStateArrive();

            var id = Guid.NewGuid().ToString();
            Peer.Send(Channel, "model::update", new JObject { { "id", id }, { "label", "first" } });
            yield return E2EServer.WaitUntil(() => Instances(id).Length == 1,
                $"The manager never instantiated the model '{id}' it was told about");

            Peer.Send(Channel, "model::delete", new JObject { { "id", id } });
            yield return E2EServer.WaitUntil(() => Instances(id).Length == 0, "The model the peer deleted was never destroyed");

            // Created again as a client creates an object: a request for its id, which brings
            // the id back into use, and then its state.
            Peer.Send(Channel, "model::request", new JObject { { "id", id } });
            Peer.Send(Channel, "model::update", new JObject { { "id", id }, { "label", "second" } });
            yield return E2EServer.WaitUntil(() => Instances(id).Any(m => m.Label == "second"),
                "The model created again under the id of one the peer had deleted was never built");

            yield return E2EServer.Settle(0.5f);
            Assert.That(Instances(id).Length, Is.EqualTo(1));
        }


        /*
         *  The send-rate limit (SyncSettings.MaxSendRate). Set low here, so that what it holds
         *  back is plain to see at any frame rate; the default is 30 per second.
         */

        [UnityTest]
        public IEnumerator ABurstOfChangesSendsTheFirstAtOnceAndThenOnlyTheLatestValues()
        {
            var model = SpawnConfigured<E2ESyncModel>("burst", _ => { });
            yield return LetInitialStateArrive();

            SyncSettings.MaxSendRate = 1;
            Cleanup.Add(SyncSettings.ResetMaxSendRate);

            model.Label = "first";

            // Well inside the interval: a change after a quiet spell is not held back.
            yield return Peer.Expect(Channel, "model::update",
                frame => Assert.That(TcpPeer.Json(frame)["label"].Value<string>(), Is.EqualTo("first")),
                timeoutSeconds: 0.5f);

            model.Label = "between";
            yield return null;
            model.Count = 3;
            yield return null;
            model.Label = "last";

            // Nothing changes after this, and the held values still have to arrive - as one
            // update, without the value in between.
            yield return Peer.Expect(Channel, "model::update", frame =>
            {
                var payload = TcpPeer.Json(frame);
                Assert.That(payload["label"].Value<string>(), Is.EqualTo("last"));
                Assert.That(payload["_count"].Value<int>(), Is.EqualTo(3));
            });

            yield return Peer.ExpectNothing(Channel, 1.5f);
        }

        [UnityTest]
        public IEnumerator ALimitOfZeroSendsEveryFramesChange()
        {
            var model = SpawnConfigured<E2ESyncModel>("unlimited", _ => { });
            yield return LetInitialStateArrive();

            SyncSettings.MaxSendRate = 0;
            Cleanup.Add(SyncSettings.ResetMaxSendRate);

            model.Label = "a";
            yield return null;
            model.Label = "b";
            yield return null;
            model.Label = "c";

            foreach (var expected in new[] { "a", "b", "c" })
            {
                yield return Peer.Expect(Channel, "model::update",
                    frame => Assert.That(TcpPeer.Json(frame)["label"].Value<string>(), Is.EqualTo(expected)));
            }
        }

        /// <summary>
        /// Quitting must not cost the last changes: the server keeps the object for the clients
        /// that stay, and it would keep it where it was a moment before. Unity sends
        /// OnApplicationQuit to every active object before tearing any down; here it is sent to
        /// the ticker alone, since quitting for real would end the test run.
        /// </summary>
        [UnityTest]
        public IEnumerator WhatTheLimitHoldsIsSentWhenTheAppQuits()
            => AssertTheLastChangesGoOutOn(ticker => ticker.SendMessage("OnApplicationQuit", SendMessageOptions.DontRequireReceiver));

        /// <summary>
        /// On Android, and so on Quest, Unity may never call OnApplicationQuit: taking the headset
        /// off or leaving the app pauses it, and the system may end it without another frame.
        /// </summary>
        [UnityTest]
        public IEnumerator WhatTheLimitHoldsIsSentWhenTheAppIsPaused()
            => AssertTheLastChangesGoOutOn(ticker => ticker.SendMessage("OnApplicationPause", true, SendMessageOptions.DontRequireReceiver));

        /// <summary>Losing focus is the exit Unity's documentation says to rely on for Android.</summary>
        [UnityTest]
        public IEnumerator WhatTheLimitHoldsIsSentWhenTheAppLosesFocus()
            => AssertTheLastChangesGoOutOn(ticker => ticker.SendMessage("OnApplicationFocus", false, SendMessageOptions.DontRequireReceiver));

        /// <summary>
        /// Holds one change back, makes another that no poll has seen yet - as a script running
        /// after the ticker in the app's last frame does - and expects both at once, as one update,
        /// when <paramref name="stop"/> tells the ticker that the app is going away.
        /// </summary>
        private IEnumerator AssertTheLastChangesGoOutOn(Action<Component> stop)
        {
            var model = SpawnConfigured<E2ESyncModel>("last-changes", _ => { });
            yield return LetInitialStateArrive();

            SyncSettings.MaxSendRate = 1;
            Cleanup.Add(SyncSettings.ResetMaxSendRate);

            model.Label = "sent";
            yield return Peer.Expect(Channel, "model::update");

            model.Label = "held";
            yield return null;
            yield return null;

            model.Count = 5;
            stop(Resources.FindObjectsOfTypeAll<SyncTicker>().Single());

            yield return Peer.Expect(Channel, "model::update", frame =>
            {
                var payload = TcpPeer.Json(frame);
                Assert.That(payload["label"]?.Value<string>(), Is.EqualTo("held"), $"The held change did not go out at once: {payload}");
                Assert.That(payload["_count"]?.Value<int>(), Is.EqualTo(5), $"The change made in the last frame did not go out with it: {payload}");
            }, timeoutSeconds: 0.5f);
        }

        /// <summary>
        /// The delete goes out at once, and what the limit was holding goes nowhere: sent after the
        /// delete, it would bring the object back on the server and on every other client.
        /// </summary>
        [UnityTest]
        public IEnumerator DestroyingAnObjectDeletesItAtOnceAndDropsWhatWasHeld()
        {
            var model = SpawnConfigured<E2ESyncModel>("destroyed-while-held", _ => { });
            yield return LetInitialStateArrive();

            SyncSettings.MaxSendRate = 1;
            Cleanup.Add(SyncSettings.ResetMaxSendRate);

            model.Label = "sent";
            yield return Peer.Expect(Channel, "model::update");

            model.Label = "held";
            yield return null;
            yield return null;

            var id = model.Id;
            UnityEngine.Object.Destroy(model.gameObject);

            yield return Peer.Expect(Channel, "model::delete",
                frame => Assert.That(TcpPeer.Json(frame)["id"].Value<string>(), Is.EqualTo(id)),
                timeoutSeconds: 0.5f);

            yield return Peer.ExpectNothing(Channel, 1.5f);
        }

        /// <summary>
        /// Deleted by another client while the limit holds an update for it, the object is gone
        /// here a moment later - but until then it used to be driven by the ticker. An update sent
        /// in that moment, held or new, reaches the server after the delete and creates the model
        /// afresh there, and every other client's manager builds a ghost of it that nobody will
        /// ever delete again.
        /// </summary>
        /// <remarks>
        /// Both only happen in that moment by chance, so a second delete listener stages them as
        /// the delete is delivered: it lifts the limit - as the interval running out in that frame
        /// does - and changes the object, as a script moving it in that frame does.
        /// </remarks>
        [UnityTest]
        public IEnumerator ADeleteFromAnotherClientIsNotUndoneByWhatTheLimitHolds()
        {
            var model = SpawnConfigured<E2ESyncModel>("deleted-elsewhere-while-held", _ => { });
            yield return LetInitialStateArrive();

            var id = model.Id;
            Action<JObject> inTheSameFrame = deleted =>
            {
                if (deleted["id"]?.Value<string>() != id)
                    return;

                SyncSettings.MaxSendRate = 0;
                model.Count = 42;
            };

            Sync.AddModelDeleteListener(Channel, inTheSameFrame);
            Cleanup.Add(() => Sync.RemoveModelDeleteListener(Channel, inTheSameFrame));
            SyncSettings.MaxSendRate = 1;
            Cleanup.Add(SyncSettings.ResetMaxSendRate);

            model.Label = "sent";
            yield return Peer.Expect(Channel, "model::update", timeoutSeconds: 0.5f);

            model.Label = "held";
            yield return null;
            yield return null;

            Peer.Send(Channel, "model::delete", new JObject { { "id", id } });
            yield return E2EServer.WaitUntil(() => model == null, "The model deleted by the peer was never destroyed");
            yield return E2EServer.Settle(0.5f);

            // What the server holds for that id now: nothing but the id, which is its answer
            // for a model it does not know - unless the held update has brought it back.
            Peer.Send(Channel, "model::request", new JObject { { "id", id } });
            yield return Peer.Expect(Channel, "model::update", frame =>
            {
                var payload = (JObject)TcpPeer.Json(frame);
                Assert.That(payload["id"].Value<string>(), Is.EqualTo(id));
                Assert.That(payload.Properties().Select(p => p.Name).ToArray(), Is.EqualTo(new[] { "id" }),
                    $"The model the peer deleted is back on the server: {payload.ToString(Newtonsoft.Json.Formatting.None)}");
            });
        }

        /// <summary>
        /// Fails if the server would hand the model to a client joining now, which asks for every
        /// model on the channel.
        /// </summary>
        private IEnumerator AssertTheServerHoldsNothingOf(string id)
        {
            var lateJoiner = Cleanup.Add(new TcpPeer());
            yield return lateJoiner.Connect("late-joiner");
            yield return E2EServer.Settle(0.3f);

            lateJoiner.Send(Channel, "model::request", (JToken)null);
            yield return E2EServer.Settle(1f);

            var held = lateJoiner.Received
                .Where(f => f.Channel == Channel && f.Command == "model::update" && (string)TcpPeer.Json(f)["id"] == id)
                .Select(TcpPeer.Text)
                .ToArray();
            Assert.That(held, Is.Empty, "The server holds the deleted model again, and hands it to every client that joins");
        }

        private static E2ESyncModel[] Instances(string id)
            => UnityCompat.FindAll<E2ESyncModel>(FindObjectsInactive.Include)
                .Where(m => m.Id == id)
                .ToArray();

        private static E2EFragileModel[] FragileInstances(string id)
            => UnityCompat.FindAll<E2EFragileModel>(FindObjectsInactive.Include)
                .Where(m => m.Id == id)
                .ToArray();
    }
}
