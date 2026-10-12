using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using HCIKonstanz.Colibri.Core;
using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Synchronization;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace HCIKonstanz.Colibri.E2E
{
    /// <summary>
    /// The connection dropping mid-session and coming back, against the real server - the brief
    /// Wi-Fi dropout that every headset in a multi-user session will see.
    ///
    /// The Unity client talks to the server through a <see cref="TcpProxy"/> that the test can
    /// cut, while the raw peer stays connected directly, as the rest of a session's clients would.
    /// In a run over TLS (<see cref="E2EServer.OverTls"/>) the proxy ends the client's TLS and
    /// speaks TLS on to the server, so it can still see what the client sends.
    /// Like <see cref="ProtocolMismatchDetectionTests"/>, these point the connection singleton
    /// somewhere other than the real server, so they own its lifetime and put it back afterwards.
    /// </summary>
    public class ReconnectTests
    {
        private TcpProxy _proxy;
        private TcpPeer _peer;
        private readonly TestCleanup _cleanup = new TestCleanup();

        /// <summary>The synced objects already in the scene when the test started.</summary>
        private HashSet<GameObject> _syncedBefore = new HashSet<GameObject>();

        private static WebServerConnection Connection => WebServerConnection.Instance;

        [UnitySetUp]
        public IEnumerator ConnectThroughAProxy()
        {
            E2EServer.RequireReachable();
            yield return DestroyConnection();

            _proxy = TcpProxy.Start(E2EServer.Host, E2EServer.TcpPort, terminateTls: E2EServer.OverTls);
            E2EServer.ConfigureInProcess(_proxy.Port);

            // OnEnable is what reads the config, so the port only takes effect on a fresh
            // instance - which touching Instance after the teardown above creates.
            Assert.That(Connection, Is.Not.Null);
            yield return E2EServer.WaitUntil(() => Connection.Status == ConnectionStatus.Connected,
                "The Unity client never connected through the proxy", 20f);

            _peer = new TcpPeer();
            yield return _peer.Connect("reconnect-peer");

            // The peer's handshake and a test's first message travel on different connections.
            yield return E2EServer.Settle(0.3f);

            _syncedBefore = TestCleanup.SyncedObjects();
        }

        [UnityTearDown]
        public IEnumerator RestoreTheConnection()
        {
            // While this test's connection is still there: destroying a synced object sends
            // model::delete, and one sent after the connection is destroyed would build a new one
            // and deliver the delete into a later test. The same goes for the objects a manager
            // built during the test.
            _cleanup.Run();
            foreach (var synced in TestCleanup.SyncedObjects())
            {
                if (!_syncedBefore.Contains(synced))
                    Object.DestroyImmediate(synced);
            }

            _peer?.Dispose();
            _peer = null;
            _proxy?.Dispose();
            _proxy = null;

            yield return DestroyConnection();
            E2EServer.Configure();
        }


        /*
         *  Messages sent while the connection is down
         */

        /// <summary>
        /// Sends issued during an outage used to each park on the Connected gate, and on reconnect
        /// the parked continuations resumed together on the thread pool and raced for the socket:
        /// outage messages went out in any order, interleaved with the ones sent after reconnecting.
        /// On a last-write-wins server that is a stale position overwriting a newer one. They now
        /// wait in one queue and go out in order, ahead of anything sent later.
        /// </summary>
        [UnityTest]
        public IEnumerator MessagesSentDuringAnOutageArriveInOrderAheadOfNewerOnes()
        {
            var channel = E2EServer.Channel("outage-order");
            var next = 1;

            for (var i = 0; i < 5; i++)
                Sync.Send(channel, next++);
            yield return E2EServer.WaitUntil(() => Received(channel).Length == 5,
                "The messages sent before the outage never arrived");

            yield return CutTheConnection();

            for (var i = 0; i < 30; i++)
                Sync.Send(channel, next++);

            yield return E2EServer.WaitUntil(() => Connection.Status == ConnectionStatus.Connected,
                "The client never reconnected after the outage", 20f);

            // The moment it is back, while the outage's messages may well still be going out.
            for (var i = 0; i < 30; i++)
                Sync.Send(channel, next++);

            var expected = Enumerable.Range(1, next - 1).ToArray();
            yield return E2EServer.WaitUntil(() => Received(channel).Length >= expected.Length,
                $"Only {Received(channel).Length} of the {expected.Length} messages arrived");
            yield return E2EServer.Settle(0.3f);

            Assert.That(Received(channel), Is.EqualTo(expected),
                "Messages arrived out of order, or twice, across the outage");
        }

        /// <summary>
        /// The queue that holds an outage's messages is bounded, so a long outage costs the oldest
        /// of them rather than unbounded memory - and says so, once. What is kept still arrives in
        /// order.
        /// </summary>
        [UnityTest]
        public IEnumerator ALongOutageKeepsTheNewestMessagesAndSaysSoOnce()
        {
            const int sent = 300;
            const int kept = 256;
            var channel = E2EServer.Channel("outage-bound");

            yield return CutTheConnection();

            var warnings = 0;
            Application.LogCallback countWarnings = (message, stackTrace, type) =>
            {
                if (type == LogType.Warning && Regex.IsMatch(message, $"^Colibri: more than {kept} messages are waiting for the connection to come back"))
                    System.Threading.Interlocked.Increment(ref warnings);
            };

            Application.logMessageReceivedThreaded += countWarnings;
            _cleanup.Add(() => Application.logMessageReceivedThreaded -= countWarnings);

            for (var i = 1; i <= sent; i++)
                Sync.Send(channel, i);

            yield return E2EServer.WaitUntil(() => Connection.Status == ConnectionStatus.Connected,
                "The client never reconnected after the outage", 20f);

            var expected = Enumerable.Range(sent - kept + 1, kept).ToArray();
            yield return E2EServer.WaitUntil(() => Received(channel).Length >= expected.Length,
                $"Only {Received(channel).Length} of the {expected.Length} queued messages arrived");
            yield return E2EServer.Settle(0.3f);

            Assert.That(Received(channel), Is.EqualTo(expected),
                "The queue should keep exactly the newest messages, in order");
            Assert.That(warnings, Is.EqualTo(1), "Dropping the oldest messages should be said exactly once per outage");
        }


        /// <summary>
        /// The bound on an outage's queue must not cost model state, which nothing would repair:
        /// an object changed once early in the outage, while broadcasts kept coming, used to be
        /// dropped first - and the re-request after reconnecting then reverted it locally to the
        /// server's older copy. A dropped request leaves an object waiting for its first state for
        /// good; a dropped delete leaves it alive on every other client. Instead, an object's
        /// updates during an outage are folded into one, and only the broadcasts are capped.
        /// </summary>
        [UnityTest]
        public IEnumerator ALongOutageKeepsEveryObjectsLatestStateAndItsRequestsAndDeletes()
        {
            const int broadcastsSent = 300;
            const int broadcastsKept = 256;
            var channel = E2EServer.Channel("outage-models");
            var noiseChannel = E2EServer.Channel("outage-noise");
            var early = System.Guid.NewGuid().ToString();
            var moving = System.Guid.NewGuid().ToString();
            var requested = System.Guid.NewGuid().ToString();
            var deleted = System.Guid.NewGuid().ToString();
            System.Action<JObject> listener = _ => { };

            yield return CutTheConnection();
            // Changed once, at the very start of the outage...
            Sync.SendModelUpdate(channel, new JObject { { "id", early }, { "label", "early" } });

            // ...then more broadcasts than the queue holds...
            for (var i = 1; i <= broadcastsSent; i++)
                Sync.Send(noiseChannel, i);

            // ...an object that keeps changing, one member and then another...
            Sync.SendModelUpdate(channel, new JObject { { "id", moving }, { "label", "first" } });
            for (var i = 1; i <= 100; i++)
                Sync.SendModelUpdate(channel, new JObject { { "id", moving }, { "count", i } });

            // ...a new object asking for its state, and one going away.
            Sync.AddModelUpdateListener(channel, listener, requested);
            _cleanup.Add(() => Sync.RemoveModelUpdateListener(channel, listener));
            Sync.SendModelDelete(channel, deleted);

            yield return E2EServer.WaitUntil(() => Connection.Status == ConnectionStatus.Connected,
                "The client never reconnected after the outage", 20f);

            // The delete was queued last, so once it is through, so is everything before it.
            yield return E2EServer.WaitUntil(() => SecondSession().Any(f => f.Channel == channel && f.Command == "model::delete"),
                "The messages queued during the outage never went out");

            var sent = SecondSession().Where(f => f.Channel == channel).ToList();
            var updates = sent.Where(f => f.Command == "model::update").Select(TcpPeer.Json).ToList();

            var earlyUpdates = updates.Where(u => (string)u["id"] == early).ToList();
            Assert.That(earlyUpdates.Count, Is.EqualTo(1), "The update from the start of the outage was dropped to make room for broadcasts");
            Assert.That((string)earlyUpdates[0]["label"], Is.EqualTo("early"));

            var movingUpdates = updates.Where(u => (string)u["id"] == moving).ToList();
            Assert.That(movingUpdates.Count, Is.EqualTo(1), "An object's updates during an outage should travel as one");
            Assert.That((string)movingUpdates[0]["label"], Is.EqualTo("first"), "The member changed first was lost when the updates were combined");
            Assert.That((int)movingUpdates[0]["count"], Is.EqualTo(100), "The combined update does not carry the newest value");

            // Every reconnect asks for the models again, this one included, so a model::request
            // for it arrives whether or not the queued one was kept. But that re-request is only
            // sent once the reconnect is reported, behind everything queued during the outage -
            // behind the delete queued last. A request ahead of the delete is the queued one.
            var delete = sent.FindIndex(f => f.Command == "model::delete" && (string)TcpPeer.Json(f)["id"] == deleted);
            var queuedRequest = sent.FindIndex(f => f.Command == "model::request" && (string)TcpPeer.Json(f)["id"] == requested);
            Assert.That(delete, Is.GreaterThanOrEqualTo(0), "The delete made during the outage was dropped");
            Assert.That(queuedRequest, Is.GreaterThanOrEqualTo(0).And.LessThan(delete),
                "The request a new object made during the outage was dropped: the only one sent was the re-request after reconnecting");

            // The broadcasts are what the bound is for: the newest of them, in order.
            var noise = SecondSession().Where(f => f.Channel == noiseChannel).Select(f => int.Parse(TcpPeer.Text(f))).ToArray();
            Assert.That(noise, Is.EqualTo(Enumerable.Range(broadcastsSent - broadcastsKept + 1, broadcastsKept).ToArray()));
        }


        /*
         *  State that changed while the client was offline
         */

        /// <summary>
        /// <c>model::request</c> used to be sent once, when a listener registered, so a client
        /// coming back from an outage kept whatever it had - for every model another client had
        /// changed in the meantime - until that model happened to change again. Every reconnect now
        /// repeats the requests, after the messages queued during the outage, so the server answers
        /// with this client's own offline changes already applied.
        /// </summary>
        [UnityTest]
        public IEnumerator ModelsThatChangedOfflineAreRequestedAgainOnReconnect()
        {
            var modelChannel = E2EServer.Channel("resync-model");
            var outageChannel = E2EServer.Channel("resync-outage");
            var id = System.Guid.NewGuid().ToString();
            var received = new List<JObject>();
            System.Action<JObject> listener = model => received.Add(model);

            Sync.AddModelUpdateListener(modelChannel, listener, id);
            _cleanup.Add(() => Sync.RemoveModelUpdateListener(modelChannel, listener));
            var witness = _cleanup.Add(new TcpPeer());

            yield return witness.Connect("resync-witness");

            // The answer to the request made at registration - a bare { id }, since the server
            // has never seen this model.
            yield return E2EServer.WaitUntil(() => received.Any(m => (string)m["id"] == id),
                "The request made when the listener registered was never answered");

            // The client stays offline until the server has certainly taken the change below.
            _proxy.HoldNewConnections = true;
            yield return CutTheConnection();

            Sync.Send(outageChannel, 1);
            _peer.Send(modelChannel, "model::update", new JObject { { "id", id }, { "label", "changed offline" } });
            yield return witness.Expect(modelChannel, "model::update");

            _proxy.HoldNewConnections = false;
            yield return E2EServer.WaitUntil(() => received.Any(m => (string)m["label"] == "changed offline"),
                "A model that changed while the client was offline never reached it after reconnecting", 20f);

            var secondSession = _proxy.FromClient.Where(sent => sent.Session == 2).Select(sent => sent.Frame).ToList();
            var request = secondSession.FindIndex(f => f.Channel == modelChannel && f.Command == "model::request");
            var queuedDuringOutage = secondSession.FindIndex(f => f.Channel == outageChannel);

            Assert.That(request, Is.GreaterThanOrEqualTo(0), "The client never asked for the model again after reconnecting");
            Assert.That((string)TcpPeer.Json(secondSession[request])["id"], Is.EqualTo(id));
            Assert.That((bool?)TcpPeer.Json(secondSession[request])["again"], Is.True,
                "The request after reconnecting did not say it was a request again, so the server would treat the object as fresh");
            Assert.That(queuedDuringOutage, Is.GreaterThanOrEqualTo(0).And.LessThan(request),
                "The request went out ahead of the messages queued during the outage, so the server answered without them");
        }

        /// <summary>
        /// The other half of asking again: what this client changed in the moment its Wi-Fi dropped.
        /// That change is written into a link that is already dead, and lost; the client only notices
        /// when the server's heartbeats stop. The server's answer after the reconnect then holds the
        /// value from before the change, and was applied: the object went back on the very client
        /// that had changed it, and every other client kept the old value too - for good, unless the
        /// member changed again. The answer holds a value this client sent before its last one, so
        /// the last one was lost: it is kept, and sent again.
        /// </summary>
        [UnityTest]
        public IEnumerator AChangeLostWithTheConnectionIsSentAgainRatherThanUndone()
        {
            const string channel = "e2esyncmodel";
            var checker = _cleanup.Add(new TcpPeer());
            var answers = new List<JObject>();
            E2ESyncModel model = null;
            System.Action<JObject> recordAnswers = update =>
            {
                if (model != null && (string)update["id"] == model.Id)
                    answers.Add(update);
            };

            // Asks for the whole channel, as a SyncBehaviourManager does - again after the reconnect
            // too, so the model gets two answers then, both from before the change.
            Sync.AddModelUpdateListener(channel, recordAnswers);
            _cleanup.Add(() => Sync.RemoveModelUpdateListener(channel, recordAnswers));

            model = Spawn<E2ESyncModel>("changed-at-the-drop");
            yield return E2EServer.Settle(1.5f);

            model.Label = "before the outage";
            model.Count = 1;
            yield return _peer.Expect(channel, "model::update",
                frame => Assert.That((string)TcpPeer.Json(frame)["id"], Is.EqualTo(model.Id)));

            // The link dies in the frame the model changes.
            _proxy.Unplug();
            model.Label = "changed at the drop";
            model.Count = 7;

            yield return E2EServer.WaitUntil(() => Swallowed(channel, model.Id).Any(),
                "The change was never written into the dead connection");
            Assert.That((string)Swallowed(channel, model.Id)[0]["label"], Is.EqualTo("changed at the drop"));

            yield return E2EServer.WaitUntil(() => Connection.Status != ConnectionStatus.Connected,
                "The client never noticed that its connection had died", 10f);
            answers.Clear();

            yield return E2EServer.WaitUntil(() => answers.Count >= 2,
                "The requests made again after the reconnect were never answered", 20f);
            Assert.That(answers.Select(a => (string)a["label"]), Is.All.EqualTo("before the outage"),
                "Precondition: the server should still hold the label from before the outage");
            Assert.That(answers.Select(a => (int?)a["_count"]), Is.All.EqualTo(1),
                "Precondition: the server should still hold the count from before the outage");

            // Long enough for the lost change to have gone out again, and for it to go out twice
            // if it is going to.
            yield return E2EServer.Settle(1f);

            Assert.That(model.Label, Is.EqualTo("changed at the drop"),
                "The answer to the request made again after the reconnect put the label from before the outage back");
            Assert.That(model.Count, Is.EqualTo(7));

            var sentAgain = SecondSession()
                .Where(f => f.Channel == channel && f.Command == "model::update" && (string)TcpPeer.Json(f)["id"] == model.Id)
                .Select(f => (JObject)TcpPeer.Json(f))
                .ToArray();
            Assert.That(sentAgain.Length, Is.EqualTo(1),
                $"The lost change should go out again once: {string.Join(", ", sentAgain.Select(u => u.ToString(Newtonsoft.Json.Formatting.None)))}");
            Assert.That((string)sentAgain[0]["label"], Is.EqualTo("changed at the drop"));
            Assert.That((int)sentAgain[0]["_count"], Is.EqualTo(7), "Everything lost should go out again in one update");

            // The peer, connected all along, and the server's copy.
            yield return _peer.Expect(channel, "model::update",
                frame => Assert.That((string)TcpPeer.Json(frame)["label"], Is.EqualTo("changed at the drop")));
            yield return checker.Connect("lost-change-checker");
            yield return E2EServer.Settle(0.3f);
            checker.Send(channel, "model::request", new JObject { { "id", model.Id } });
            yield return checker.Expect(channel, "model::update", frame =>
            {
                var payload = (JObject)TcpPeer.Json(frame);
                Assert.That((string)payload["label"], Is.EqualTo("changed at the drop"), $"The server holds {payload}");
                Assert.That((int?)payload["_count"], Is.EqualTo(7), $"The server holds {payload}");
            });
        }

        /// <summary>
        /// A value the server holds that this client never sent is another client's, set while this
        /// one was away, and newer than anything this one sent before the outage - a change lost at
        /// the drop included. It is applied, and nothing goes back.
        /// </summary>
        [UnityTest]
        public IEnumerator AValueAnotherClientSetDuringTheOutageWinsOverOneLostAtTheDrop()
        {
            const string channel = "e2esyncmodel";
            var witness = _cleanup.Add(new TcpPeer());
            var checker = _cleanup.Add(new TcpPeer());
            var answers = new List<JObject>();
            E2ESyncModel model = null;
            System.Action<JObject> recordAnswers = update =>
            {
                if (model != null && (string)update["id"] == model.Id)
                    answers.Add(update);
            };

            Sync.AddModelUpdateListener(channel, recordAnswers);
            _cleanup.Add(() => Sync.RemoveModelUpdateListener(channel, recordAnswers));

            model = Spawn<E2ESyncModel>("changed-on-both-sides");
            yield return E2EServer.Settle(1.5f);

            model.Label = "mine";
            yield return _peer.Expect(channel, "model::update",
                frame => Assert.That((string)TcpPeer.Json(frame)["id"], Is.EqualTo(model.Id)));

            yield return witness.Connect("both-sides-witness");
            _proxy.HoldNewConnections = true;
            _proxy.Unplug();
            model.Label = "mine, lost at the drop";

            yield return E2EServer.WaitUntil(() => Swallowed(channel, model.Id).Any(),
                "The change was never written into the dead connection");
            yield return E2EServer.WaitUntil(() => Connection.Status != ConnectionStatus.Connected,
                "The client never noticed that its connection had died", 10f);

            _peer.Send(channel, "model::update", new JObject { { "id", model.Id }, { "label", "theirs" } });
            yield return witness.Expect(channel, "model::update");
            answers.Clear();
            _proxy.HoldNewConnections = false;

            yield return E2EServer.WaitUntil(() => answers.Count >= 2,
                "The requests made again after the reconnect were never answered", 20f);
            yield return E2EServer.Settle(1f);

            Assert.That(model.Label, Is.EqualTo("theirs"), "The other client's change made during the outage was not applied");
            var sentAgain = SecondSession()
                .Where(f => f.Channel == channel && f.Command == "model::update" && (string)TcpPeer.Json(f)["id"] == model.Id)
                .Select(f => TcpPeer.Text(f))
                .ToArray();
            Assert.That(sentAgain, Is.Empty, "The client sent its own value over the other client's newer one");

            yield return checker.Connect("both-sides-checker");
            yield return E2EServer.Settle(0.3f);
            checker.Send(channel, "model::request", new JObject { { "id", model.Id } });
            yield return checker.Expect(channel, "model::update",
                frame => Assert.That((string)TcpPeer.Json(frame)["label"], Is.EqualTo("theirs")));
        }

        /// <summary>
        /// Values sent long before the outage do not count: another client setting the member back
        /// to one of them while this one was away would look exactly like a lost change, and be
        /// undone. The answer is applied, as it always was.
        /// </summary>
        [UnityTest]
        public IEnumerator AnAnswerAboutChangesFromLongBeforeTheOutageIsAppliedAsItWas()
        {
            const string channel = "e2esyncmodel";
            var witness = _cleanup.Add(new TcpPeer());
            var checker = _cleanup.Add(new TcpPeer());
            var answers = new List<JObject>();
            var window = SentValues.WindowSeconds;
            E2ESyncModel model = null;
            System.Action<JObject> recordAnswers = update =>
            {
                if (model != null && (string)update["id"] == model.Id)
                    answers.Add(update);
            };

            // "Long before" is the window, shortened here from its ten seconds.
            SentValues.WindowSeconds = 1;
            _cleanup.Add(() => SentValues.WindowSeconds = window);
            Sync.AddModelUpdateListener(channel, recordAnswers);
            _cleanup.Add(() => Sync.RemoveModelUpdateListener(channel, recordAnswers));

            model = Spawn<E2ESyncModel>("changed-long-before");
            yield return E2EServer.Settle(1.5f);

            model.Label = "first";
            yield return _peer.Expect(channel, "model::update",
                frame => Assert.That((string)TcpPeer.Json(frame)["label"], Is.EqualTo("first")));
            model.Label = "second";
            model.Count = 3;
            yield return _peer.Expect(channel, "model::update",
                frame => Assert.That((string)TcpPeer.Json(frame)["label"], Is.EqualTo("second")));

            // Longer ago than the window when the connection goes.
            yield return E2EServer.Settle(1.5f);

            yield return witness.Connect("long-before-witness");
            _proxy.HoldNewConnections = true;
            yield return CutTheConnection();

            _peer.Send(channel, "model::update", new JObject { { "id", model.Id }, { "label", "first" } });
            yield return witness.Expect(channel, "model::update");
            answers.Clear();
            _proxy.HoldNewConnections = false;

            yield return E2EServer.WaitUntil(() => answers.Count >= 2,
                "The requests made again after the reconnect were never answered", 20f);
            yield return E2EServer.Settle(1f);

            Assert.That(model.Label, Is.EqualTo("first"), "The other client's change made during the outage was not applied");
            Assert.That(model.Count, Is.EqualTo(3));
            var sentAgain = SecondSession()
                .Where(f => f.Channel == channel && f.Command == "model::update" && (string)TcpPeer.Json(f)["id"] == model.Id)
                .Select(f => TcpPeer.Text(f))
                .ToArray();
            Assert.That(sentAgain, Is.Empty, "A value sent long before the outage was taken for a lost one, and sent over the other client's");

            yield return checker.Connect("long-before-checker");
            yield return E2EServer.Settle(0.3f);
            checker.Send(channel, "model::request", new JObject { { "id", model.Id } });
            yield return checker.Expect(channel, "model::update", frame =>
            {
                var payload = (JObject)TcpPeer.Json(frame);
                Assert.That((string)payload["label"], Is.EqualTo("first"), $"The server holds {payload}");
                Assert.That((int?)payload["_count"], Is.EqualTo(3), $"The server holds {payload}");
            });
        }

        /// <summary>
        /// An object shown for longer than the window and hidden in the frame the link dies: the
        /// switch-off is all it sent in the window, and the answer holds the value it had been
        /// showing all along. That is the value it held when the window began, so the switch-off
        /// was lost: the object stays hidden here, and is hidden on the other client too.
        /// </summary>
        [UnityTest]
        public IEnumerator AnObjectHiddenAtTheDropAfterAQuietSpellStaysHiddenAndIsHiddenElsewhere()
        {
            const string channel = "synctransform";
            var checker = _cleanup.Add(new TcpPeer());
            var answers = new List<JObject>();
            var window = SentValues.WindowSeconds;
            SyncTransform sync = null;
            System.Action<JObject> recordAnswers = update =>
            {
                if (sync != null && (string)update["id"] == sync.Id)
                    answers.Add(update);
            };

            // Shortened from its ten seconds, but longer than the 2 s the client takes to notice a
            // silent drop, so the switch-off falls into it.
            SentValues.WindowSeconds = 4;
            _cleanup.Add(() => SentValues.WindowSeconds = window);
            Sync.AddModelUpdateListener(channel, recordAnswers);
            _cleanup.Add(() => Sync.RemoveModelUpdateListener(channel, recordAnswers));

            sync = Spawn<SyncTransform>("hidden-at-the-drop");
            yield return E2EServer.Settle(1.5f);

            // Hidden and shown again, so the server and the other client have it shown.
            sync.gameObject.SetActive(false);
            yield return _peer.Expect(channel, "model::update",
                frame => Assert.That((bool?)TcpPeer.Json(frame)["active"], Is.False));
            sync.gameObject.SetActive(true);
            yield return _peer.Expect(channel, "model::update",
                frame => Assert.That((bool?)TcpPeer.Json(frame)["active"], Is.True));

            // Left shown for longer than the window reaches back before the drop: it is counted
            // from when the drop is noticed, 2 s after it.
            yield return E2EServer.Settle(3.5f);

            _proxy.Unplug();
            sync.gameObject.SetActive(false);

            yield return E2EServer.WaitUntil(() => Swallowed(channel, sync.Id).Any(),
                "The switch-off was never written into the dead connection");
            Assert.That((bool?)Swallowed(channel, sync.Id)[0]["active"], Is.False);

            yield return E2EServer.WaitUntil(() => Connection.Status != ConnectionStatus.Connected,
                "The client never noticed that its connection had died", 10f);
            answers.Clear();

            yield return E2EServer.WaitUntil(() => answers.Count >= 2,
                "The requests made again after the reconnect were never answered", 20f);
            Assert.That(answers.Select(a => (bool?)a["active"]), Is.All.True,
                "Precondition: the server should still have the object shown");

            yield return E2EServer.Settle(1f);

            Assert.That(sync.gameObject.activeSelf, Is.False,
                "The answer to the request made again after the reconnect showed the object again");
            var sentAgain = SecondSession()
                .Where(f => f.Channel == channel && f.Command == "model::update" && (string)TcpPeer.Json(f)["id"] == sync.Id)
                .Select(f => (JObject)TcpPeer.Json(f))
                .ToArray();
            Assert.That(sentAgain.Select(u => u.ToString(Newtonsoft.Json.Formatting.None)),
                Is.EqualTo(new[] { new JObject { { "id", sync.Id }, { "active", false } }.ToString(Newtonsoft.Json.Formatting.None) }),
                "The switch-off lost at the drop should go out again, once");

            yield return _peer.Expect(channel, "model::update",
                frame => Assert.That((bool?)TcpPeer.Json(frame)["active"], Is.False, "The other client still shows the object"));
            yield return checker.Connect("hidden-at-the-drop-checker");
            yield return E2EServer.Settle(0.3f);
            checker.Send(channel, "model::request", new JObject { { "id", sync.Id } });
            yield return checker.Expect(channel, "model::update", frame =>
            {
                var payload = (JObject)TcpPeer.Json(frame);
                Assert.That((bool?)payload["active"], Is.False, $"The server holds {payload}");
            });
        }

        /// <summary>
        /// An object moved every frame from the moment the link dies, and let go before the outage
        /// is noticed: every position written into the dead link is lost, far more of them than a
        /// member keeps in a row, and the server keeps the one from before the drop. The answer
        /// after the reconnect holds that one. It is told from another client's all the same, as
        /// one of the values sent around when the server was last heard from: the object stays
        /// where it was let go, and moves there on the other client too.
        /// </summary>
        [UnityTest]
        public IEnumerator AnObjectMovedAcrossTheDropStaysWhereItWasLetGoAndMovesThereElsewhere()
        {
            const string channel = "synctransform";
            var checker = _cleanup.Add(new TcpPeer());
            var answers = new List<JObject>();
            SyncTransform sync = null;
            System.Action<JObject> recordAnswers = update =>
            {
                if (sync != null && (string)update["id"] == sync.Id)
                    answers.Add(update);
            };

            Sync.AddModelUpdateListener(channel, recordAnswers);
            _cleanup.Add(() => Sync.RemoveModelUpdateListener(channel, recordAnswers));

            sync = Spawn<SyncTransform>("moved-across-the-drop");
            yield return E2EServer.Settle(1.5f);

            sync.transform.position = new Vector3(0, 1, 0);
            yield return _peer.Expect(channel, "model::update",
                frame => Assert.That(TcpPeer.Json(frame)["position"]?.ToVector3(), Is.EqualTo(new Vector3(0, 1, 0))));

            // Moved every frame for a second from the moment the link dies, at the send-rate limit.
            _proxy.Unplug();
            var until = Time.realtimeSinceStartup + 1f;
            for (var x = 1; Time.realtimeSinceStartup < until; x++)
            {
                sync.transform.position = new Vector3(x, 1, 0);
                yield return null;
            }
            var letGoAt = sync.transform.position;

            yield return E2EServer.WaitUntil(() => Connection.Status != ConnectionStatus.Connected,
                "The client never noticed that its connection had died", 10f);
            Assert.That(Swallowed(channel, sync.Id).Length, Is.GreaterThan(SentValues.Capacity + 1),
                "Precondition: more moves should have gone into the dead link than a member keeps in a row");
            answers.Clear();

            yield return E2EServer.WaitUntil(() => answers.Count >= 2,
                "The requests made again after the reconnect were never answered", 20f);
            Assert.That(answers.Select(a => a["position"]?.ToVector3()), Is.All.EqualTo(new Vector3(0, 1, 0)),
                "Precondition: the server should still have the object where it was before the drop");

            yield return E2EServer.Settle(1f);

            Assert.That(sync.transform.position, Is.EqualTo(letGoAt),
                "The answer to the request made again after the reconnect put the object back where it was before the drop");
            var sentAgain = SecondSession()
                .Where(f => f.Channel == channel && f.Command == "model::update" && (string)TcpPeer.Json(f)["id"] == sync.Id)
                .Select(f => (JObject)TcpPeer.Json(f))
                .ToArray();
            Assert.That(sentAgain.Length, Is.EqualTo(1),
                $"The position let go at should go out again once: {string.Join(", ", sentAgain.Select(u => u.ToString(Newtonsoft.Json.Formatting.None)))}");
            Assert.That(sentAgain[0]["position"]?.ToVector3(), Is.EqualTo(letGoAt));

            yield return _peer.Expect(channel, "model::update",
                frame => Assert.That(TcpPeer.Json(frame)["position"]?.ToVector3(), Is.EqualTo(letGoAt), "The other client still has the object where it was before the drop"));
            yield return checker.Connect("moved-across-the-drop-checker");
            yield return E2EServer.Settle(0.3f);
            checker.Send(channel, "model::request", new JObject { { "id", sync.Id } });
            yield return checker.Expect(channel, "model::update", frame =>
            {
                var payload = (JObject)TcpPeer.Json(frame);
                Assert.That(payload["position"]?.ToVector3(), Is.EqualTo(letGoAt), $"The server holds {payload}");
            });
        }

        /// <summary>
        /// Another client keeps updating the object while this one comes back, as one moving it
        /// would. The server relays those updates from the moment it accepts the connection, so they
        /// arrive before, between and after the answers to the requests made again, and look just
        /// like them. None of them is taken for an answer: what the other client set during the
        /// outage is applied, and this client sends nothing back over it.
        /// </summary>
        [UnityTest]
        public IEnumerator AnotherClientsUpdatesDuringTheReconnectAreNotTakenForAnswers()
        {
            const string channel = "e2esyncmodel";
            var witness = _cleanup.Add(new TcpPeer());
            var checker = _cleanup.Add(new TcpPeer());
            var answers = new List<JObject>();
            E2ESyncModel model = null;

            // The answers are the updates that carry the count: the other client's, below, never do.
            System.Action<JObject> recordAnswers = update =>
            {
                if (model != null && (string)update["id"] == model.Id && update.ContainsKey("_count"))
                    answers.Add(update);
            };

            Sync.AddModelUpdateListener(channel, recordAnswers);
            _cleanup.Add(() => Sync.RemoveModelUpdateListener(channel, recordAnswers));

            model = Spawn<E2ESyncModel>("updated-during-the-reconnect");
            yield return E2EServer.Settle(1.5f);

            model.Label = "mine";
            model.Count = 1;
            yield return _peer.Expect(channel, "model::update",
                frame => Assert.That((string)TcpPeer.Json(frame)["id"], Is.EqualTo(model.Id)));

            yield return witness.Connect("during-the-reconnect-witness");
            _proxy.HoldNewConnections = true;
            yield return CutTheConnection();

            _peer.Send(channel, "model::update", new JObject { { "id", model.Id }, { "_count", 7 } });
            yield return witness.Expect(channel, "model::update");
            answers.Clear();
            _proxy.HoldNewConnections = false;

            yield return KeepUpdatingTheLabel(model.Id, () => answers.Count >= 2);
            yield return E2EServer.Settle(1f);

            Assert.That(model.Count, Is.EqualTo(7), "The count the other client set during the outage was not applied");
            Assert.That(model.Label, Does.StartWith("theirs"), "The other client's updates were not applied");
            var sentAgain = SecondSession()
                .Where(f => f.Channel == channel && f.Command == "model::update" && (string)TcpPeer.Json(f)["id"] == model.Id)
                .Select(f => TcpPeer.Text(f))
                .ToArray();
            Assert.That(sentAgain, Is.Empty, "The client sent its own values over the other client's");

            yield return checker.Connect("during-the-reconnect-checker");
            yield return E2EServer.Settle(0.3f);
            checker.Send(channel, "model::request", new JObject { { "id", model.Id } });
            yield return checker.Expect(channel, "model::update", frame =>
            {
                var payload = (JObject)TcpPeer.Json(frame);
                Assert.That((int?)payload["_count"], Is.EqualTo(7), $"The server holds {payload}");
                Assert.That((string)payload["label"], Is.EqualTo(model.Label), $"The server holds {payload}");
            });
        }

        /// <summary>
        /// The change lost at the drop still goes out again while another client keeps updating
        /// another member of the object through the reconnect, and both end up everywhere.
        /// </summary>
        [UnityTest]
        public IEnumerator AChangeLostWithTheConnectionIsSentAgainWhileAnotherClientKeepsUpdatingTheObject()
        {
            const string channel = "e2esyncmodel";
            var checker = _cleanup.Add(new TcpPeer());
            var answers = new List<JObject>();
            E2ESyncModel model = null;
            System.Action<JObject> recordAnswers = update =>
            {
                if (model != null && (string)update["id"] == model.Id && update.ContainsKey("_count"))
                    answers.Add(update);
            };

            Sync.AddModelUpdateListener(channel, recordAnswers);
            _cleanup.Add(() => Sync.RemoveModelUpdateListener(channel, recordAnswers));

            model = Spawn<E2ESyncModel>("lost-while-updated");
            yield return E2EServer.Settle(1.5f);

            model.Label = "mine";
            model.Count = 1;
            yield return _peer.Expect(channel, "model::update",
                frame => Assert.That((string)TcpPeer.Json(frame)["id"], Is.EqualTo(model.Id)));

            _proxy.HoldNewConnections = true;
            _proxy.Unplug();
            model.Count = 7;

            yield return E2EServer.WaitUntil(() => Swallowed(channel, model.Id).Any(),
                "The change was never written into the dead connection");
            yield return E2EServer.WaitUntil(() => Connection.Status != ConnectionStatus.Connected,
                "The client never noticed that its connection had died", 10f);
            answers.Clear();
            _proxy.HoldNewConnections = false;

            yield return KeepUpdatingTheLabel(model.Id, () => answers.Count >= 2);
            yield return E2EServer.Settle(1f);

            Assert.That(model.Count, Is.EqualTo(7), "The answer put the count from before the outage back");
            Assert.That(model.Label, Does.StartWith("theirs"), "The other client's updates were not applied");
            var sentAgain = SecondSession()
                .Where(f => f.Channel == channel && f.Command == "model::update" && (string)TcpPeer.Json(f)["id"] == model.Id)
                .Select(f => (JObject)TcpPeer.Json(f))
                .ToArray();
            Assert.That(sentAgain.Select(u => u.ToString(Newtonsoft.Json.Formatting.None)),
                Is.EqualTo(new[] { new JObject { { "id", model.Id }, { "_count", 7 } }.ToString(Newtonsoft.Json.Formatting.None) }),
                "Only the count lost at the drop should go out again, once");

            yield return checker.Connect("lost-while-updated-checker");
            yield return E2EServer.Settle(0.3f);
            checker.Send(channel, "model::request", new JObject { { "id", model.Id } });
            yield return checker.Expect(channel, "model::update", frame =>
            {
                var payload = (JObject)TcpPeer.Json(frame);
                Assert.That((int?)payload["_count"], Is.EqualTo(7), $"The server holds {payload}");
                Assert.That((string)payload["label"], Is.EqualTo(model.Label), $"The server holds {payload}");
            });
        }

        /// <summary>
        /// The same through SyncBehaviourManager, which builds objects from what the server sends:
        /// the model asked for again after a reconnect is one this client already has, and it has
        /// to update that object rather than build a second one.
        /// </summary>
        [UnityTest]
        public IEnumerator AModelResyncedAfterAnOutageUpdatesItsObjectRatherThanSpawningAnother()
        {
            const string channel = "e2esyncmodel";
            var id = System.Guid.NewGuid().ToString();
            var witness = _cleanup.Add(new TcpPeer());

            var template = Spawn<E2ESyncModel>("template");
            var manager = Spawn<E2ESyncModelManager>("manager");
            manager.Template = template;

            // Start is where the manager subscribes; then the template's own state round trip.
            yield return null;
            yield return E2EServer.Settle(1.5f);

            _peer.Send(channel, "model::update", new JObject { { "id", id }, { "label", "before the outage" } });
            yield return E2EServer.WaitUntil(() => Instances(id).Length == 1,
                $"The manager never instantiated the model '{id}' it was told about");

            yield return witness.Connect("resync-witness");
            _proxy.HoldNewConnections = true;
            yield return CutTheConnection();

            _peer.Send(channel, "model::update", new JObject { { "id", id }, { "label", "changed offline" } });
            yield return witness.Expect(channel, "model::update");
            _proxy.HoldNewConnections = false;

            yield return E2EServer.WaitUntil(() => Instances(id).Any(m => m.Label == "changed offline"),
                "The model that changed while the client was offline was not updated after reconnecting", 20f);

            // Long enough for a second instance to show up if the manager is going to make one.
            yield return E2EServer.Settle(1.5f);

            Assert.That(Instances(id).Length, Is.EqualTo(1),
                "Asking for the model again after the reconnect built a second object for it");
        }

        /// <summary>
        /// An object placed during an outage asks for its state then, and again once the client is
        /// back, and both answers arrive in the round after the reconnect. Changed in the frame the
        /// client reconnects, before either answer, it keeps the change through the round, and the
        /// other clients and the server get it; the count, not changed here, takes the server's
        /// value.
        /// </summary>
        [UnityTest]
        public IEnumerator AnObjectChangedAtTheReconnectBeforeItsFirstAnswerKeepsTheChange()
        {
            const string channel = "e2esyncmodel";
            var checker = _cleanup.Add(new TcpPeer());
            var id = System.Guid.NewGuid().ToString();
            E2ESyncModel model = null;
            var changed = false;
            System.Action change = () =>
            {
                model.Label = "mine";
                changed = true;
            };

            _peer.Send(channel, "model::update", new JObject { { "id", id }, { "label", "theirs" }, { "_count", 3 } });
            _peer.Send(channel, "model::request", new JObject { { "id", id } });
            yield return _peer.Expect(channel, "model::update",
                frame => Assert.That((int?)TcpPeer.Json(frame)["_count"], Is.EqualTo(3), "Precondition: the server holds the object"));

            _proxy.HoldNewConnections = true;
            yield return CutTheConnection();

            var gameObject = _cleanup.Add(new GameObject("placed-during-the-outage"));
            gameObject.SetActive(false);
            model = gameObject.AddComponent<E2ESyncModel>();
            model.Id = id;
            gameObject.SetActive(true);

            Connection.OnConnected += change;
            _cleanup.Add(() => Connection.OnConnected -= change);
            _proxy.HoldNewConnections = false;
            yield return E2EServer.WaitUntil(() => changed, "The client never reconnected after the outage", 20f);

            yield return _peer.Expect(channel, "model::update", frame =>
            {
                var payload = (JObject)TcpPeer.Json(frame);
                Assert.That((string)payload["id"], Is.EqualTo(id));
                Assert.That((string)payload["label"], Is.EqualTo("mine"), $"Got {payload}");
            });

            // Long enough for both answers, and for the end of them.
            yield return E2EServer.Settle(1f);
            Assert.That(model.Label, Is.EqualTo("mine"), "An answer put the server's value over the change");
            Assert.That(model.Count, Is.EqualTo(3), "The count, not changed here, did not take the server's value");

            yield return checker.Connect("changed-at-the-reconnect-checker");
            yield return E2EServer.Settle(0.3f);
            checker.Send(channel, "model::request", new JObject { { "id", id } });
            yield return checker.Expect(channel, "model::update", frame =>
            {
                var payload = (JObject)TcpPeer.Json(frame);
                Assert.That((string)payload["label"], Is.EqualTo("mine"), $"The server holds {payload}");
                Assert.That((int?)payload["_count"], Is.EqualTo(3), $"The server holds {payload}");
            });
        }

        /// <summary>
        /// The server clears an app's models when its last client leaves, so a client that was
        /// alone when its connection dropped comes back to a server that holds nothing of its
        /// objects, and the request each object makes again is answered with a bare { id }.
        /// Nothing used to put the state back: a client that joined afterwards never saw the
        /// object, though it was right there on the client that had created it.
        /// </summary>
        [UnityTest]
        public IEnumerator AModelTheServerForgotWhileThisClientWasAloneIsSentAgainInFull()
        {
            const string channel = "e2esyncmodel";
            var lateJoiner = _cleanup.Add(new TcpPeer());
            var answers = new List<JObject>();
            E2ESyncModel model = null;
            System.Action<JObject> recordAnswers = update =>
            {
                if (model != null && (string)update["id"] == model.Id)
                    answers.Add(update);
            };

            Sync.AddModelUpdateListener(channel, recordAnswers);
            _cleanup.Add(() => Sync.RemoveModelUpdateListener(channel, recordAnswers));

            model = Spawn<E2ESyncModel>("alone-through-an-outage");
            yield return E2EServer.Settle(1.5f);

            // The server hears of the label alone; the other members never changed.
            model.Label = "before the outage";
            yield return _peer.Expect(channel, "model::update",
                frame => Assert.That((string)TcpPeer.Json(frame)["id"], Is.EqualTo(model.Id)));

            // This client alone on the app, so that the server clears its models once it drops.
            _peer.Dispose();
            _peer = null;
            _proxy.HoldNewConnections = true;
            yield return CutTheConnection();
            answers.Clear();
            yield return E2EServer.Settle(0.5f);
            _proxy.HoldNewConnections = false;

            yield return E2EServer.WaitUntil(() => answers.Count > 0,
                "The model's request after reconnecting was never answered", 20f);
            Assert.That(answers[0].Properties().Select(p => p.Name).ToArray(), Is.EqualTo(new[] { "id" }),
                $"Precondition: the server should have forgotten the model, but answered {answers[0]}");

            yield return E2EServer.WaitUntil(
                () => SecondSession().Any(f => f.Channel == channel && f.Command == "model::update"),
                "The model never sent its state again after the server had lost it");

            yield return lateJoiner.Connect("late-joiner");
            yield return E2EServer.Settle(0.3f);

            lateJoiner.Send(channel, "model::request", new JObject { { "id", model.Id } });
            yield return lateJoiner.Expect(channel, "model::update", frame =>
            {
                var payload = (JObject)TcpPeer.Json(frame);
                Assert.That((string)payload["id"], Is.EqualTo(model.Id));
                Assert.That((string)payload["label"], Is.EqualTo("before the outage"), $"Got {payload}");
                Assert.That(payload.ContainsKey("_count") && payload.ContainsKey("where"), Is.True,
                    $"The server should hold every member again, not only the ones that once changed: {payload}");
            });
        }

        /// <summary>
        /// The other side of the test above. A model another client deleted while this one was
        /// offline is gone from the server too, and the delete the server relayed never reached
        /// this client. Answered with a bare { id }, the request made again after the reconnect
        /// had this client send the object's whole state: the server stored it afresh, and every
        /// other client's manager built the deleted object again. The server answers it with
        /// model::delete, so this client's copy goes as well, and nothing of it is sent.
        /// </summary>
        [UnityTest]
        public IEnumerator AModelDeletedWhileThisClientWasOfflineStaysDeleted()
        {
            const string channel = "e2esyncmodel";
            var witness = _cleanup.Add(new TcpPeer());
            var checker = _cleanup.Add(new TcpPeer());

            var model = Spawn<E2ESyncModel>("deleted-while-offline");
            var id = model.Id;
            yield return E2EServer.Settle(1.5f);

            model.Label = "before the outage";
            yield return _peer.Expect(channel, "model::update",
                frame => Assert.That((string)TcpPeer.Json(frame)["id"], Is.EqualTo(id)));

            // The peer stays connected, so the server keeps the app and its models.
            yield return witness.Connect("delete-witness");
            _proxy.HoldNewConnections = true;
            yield return CutTheConnection();

            _peer.Send(channel, "model::delete", new JObject { { "id", id } });
            yield return witness.Expect(channel, "model::delete");
            _proxy.HoldNewConnections = false;

            yield return E2EServer.WaitUntil(
                () => SecondSession().Any(f => f.Channel == channel && f.Command == "model::request"),
                "The model was never requested again after the reconnect", 20f);

            // Long enough for a state sent in reply to the answer to have left.
            yield return E2EServer.Settle(1.5f);

            var sentAgain = SecondSession()
                .Where(f => f.Channel == channel && f.Command == "model::update" && (string)TcpPeer.Json(f)["id"] == id)
                .Select(f => TcpPeer.Json(f).ToString(Newtonsoft.Json.Formatting.None))
                .ToArray();
            Assert.That(sentAgain, Is.Empty, "The client sent the state of a model deleted while it was offline");

            yield return checker.Connect("delete-checker");
            yield return E2EServer.Settle(0.3f);
            checker.Send(channel, "model::request", new JObject { { "id", id } });
            yield return checker.Expect(channel, null, frame =>
            {
                var payload = (JObject)TcpPeer.Json(frame);
                Assert.That(frame.Command == "model::delete" || payload.Count == 1, Is.True,
                    $"The model deleted while this client was offline is back on the server: {frame.Command} {payload.ToString(Newtonsoft.Json.Formatting.None)}");
            });

            Assert.That(Instances(id), Is.Empty, "This client still shows the model that was deleted while it was offline");
        }

        /// <summary>
        /// An object destroyed in the frame the link dies writes its delete into the dead
        /// connection, and it is lost. After the reconnect nothing asked for the object again, as
        /// this client no longer has it, so the server and every other client kept it. The delete
        /// goes out again when the outage is noticed, ahead of the requests made again.
        /// </summary>
        [UnityTest]
        public IEnumerator AnObjectDestroyedAtTheDropIsDeletedElsewhereAfterTheReconnect()
        {
            const string channel = "e2esyncmodel";
            var checker = _cleanup.Add(new TcpPeer());

            var model = Spawn<E2ESyncModel>("destroyed-at-the-drop");
            var id = model.Id;
            yield return E2EServer.Settle(1.5f);

            model.Label = "before the outage";
            yield return _peer.Expect(channel, "model::update",
                frame => Assert.That((string)TcpPeer.Json(frame)["id"], Is.EqualTo(id)));

            // The link dies in the frame the object is destroyed.
            _proxy.Unplug();
            Object.Destroy(model.gameObject);

            yield return E2EServer.WaitUntil(
                () => _proxy.Swallowed.Any(s => s.Frame.Channel == channel && s.Frame.Command == "model::delete"),
                "The delete was never written into the dead connection");
            yield return E2EServer.WaitUntil(() => Connection.Status != ConnectionStatus.Connected,
                "The client never noticed that its connection had died", 10f);

            yield return _peer.Expect(channel, "model::delete",
                frame => Assert.That((string)TcpPeer.Json(frame)["id"], Is.EqualTo(id)), 20f);

            var sent = SecondSession().Where(f => f.Channel == channel).ToList();
            var delete = sent.FindIndex(f => f.Command == "model::delete" && (string)TcpPeer.Json(f)["id"] == id);
            var request = sent.FindIndex(f => f.Command == "model::request");
            Assert.That(delete, Is.GreaterThanOrEqualTo(0), "The delete lost at the drop was not sent again");
            Assert.That(request < 0 || delete < request, Is.True, "The delete should go ahead of the requests made again");

            yield return checker.Connect("destroyed-at-the-drop-checker");
            yield return E2EServer.Settle(0.3f);
            checker.Send(channel, "model::request", new JObject { { "id", id }, { "again", true } });
            yield return checker.Expect(channel, null, frame =>
                Assert.That(frame.Command, Is.EqualTo("model::delete"),
                    $"The server still holds the object destroyed at the drop: {frame.Command} {TcpPeer.Text(frame)}"));
        }

        /// <summary>
        /// An object a manager builds from another client's update asks the server for nothing when
        /// it registers. That update carries the model's state already, and a request for one id
        /// says that this client has the object in its scene now, or is creating it: a server that
        /// remembers deletes lifts the tombstone of a model deleted since it relayed the update, and
        /// an update sent before the delete then creates the model afresh on every client. After a
        /// reconnect the object is asked for again like every other one, which is how a delete made
        /// while this client was offline reaches it.
        /// </summary>
        [UnityTest]
        public IEnumerator AModelBuiltFromAnotherClientsUpdateIsAskedForOnlyAfterAReconnect()
        {
            const string channel = "e2esyncmodel";
            var id = System.Guid.NewGuid().ToString();
            var template = Spawn<E2ESyncModel>("template");
            var manager = Spawn<E2ESyncModelManager>("manager");
            manager.Template = template;
            yield return null;
            yield return E2EServer.Settle(1.5f);

            var createdHere = Spawn<E2ESyncModel>("created-here");
            _peer.Send(channel, "model::update", new JObject { { "id", id }, { "label", "from the peer" } });
            yield return E2EServer.WaitUntil(() => Instances(id).Length == 1,
                $"The manager never instantiated the model '{id}' it was told about");

            // Long enough for a request made when the object registered to have gone out.
            yield return E2EServer.Settle(1f);

            Assert.That(RequestedIds(1, channel), Does.Contain(createdHere.Id),
                "Precondition: an object created on this client asks for its id when it registers");
            Assert.That(RequestedIds(1, channel), Does.Not.Contain(id),
                "The object built from the peer's update asked the server for its model, as an object created here does");

            yield return CutTheConnection();
            yield return E2EServer.WaitUntil(() => RequestedIds(2, channel).Contains(id),
                "The object built from the peer's update was not asked for again after the reconnect", 20f);
        }

        /// <summary>
        /// RemoteLogging across an outage: every line reaches the server exactly once, in order.
        /// It used to retry a line whose send had failed, while the connection had also queued that
        /// same send for retry, so some lines arrived twice. Lines logged during the outage wait in
        /// RemoteLogging's own buffer and go out once the connection is back.
        /// </summary>
        [UnityTest]
        public IEnumerator RemoteLoggingDeliversEveryLineOnceAcrossAnOutage()
        {
            var prefix = $"reconnect-log-{System.Guid.NewGuid():N}";
            var loggingObject = _cleanup.Add(new GameObject("remote-logging"));
            loggingObject.AddComponent<RemoteLogging>();
            var next = 1;

            for (var i = 0; i < 5; i++)
                Debug.Log($"{prefix} {next++}");
            yield return E2EServer.WaitUntil(() => LoggedLines(prefix).Length == 5,
                "The lines logged before the outage never reached the server");

            yield return CutTheConnection();

            for (var i = 0; i < 5; i++)
                Debug.Log($"{prefix} {next++}");

            yield return E2EServer.WaitUntil(() => Connection.Status == ConnectionStatus.Connected,
                "The client never reconnected after the outage", 20f);

            for (var i = 0; i < 5; i++)
                Debug.Log($"{prefix} {next++}");

            var expected = Enumerable.Range(1, next - 1).Select(i => $"{prefix} {i}").ToArray();
            yield return E2EServer.WaitUntil(() => LoggedLines(prefix).Length >= expected.Length,
                $"Only {LoggedLines(prefix).Length} of the {expected.Length} lines reached the server");

            // Past RemoteLogging's one-second send interval, so a duplicate would have shown up.
            yield return E2EServer.Settle(1.5f);

            Assert.That(LoggedLines(prefix), Is.EqualTo(expected), "Log lines arrived out of order, or more than once");
        }


        /// <summary>
        /// A burst of log lines while connected, more than RemoteLogging keeps between two sends.
        /// The oldest are dropped, as they always were - that bounds what a runaway log loop costs
        /// the server - but no longer silently: one line says how many are missing.
        /// </summary>
        [UnityTest]
        public IEnumerator RemoteLoggingSaysHowManyLinesABurstLost()
        {
            var prefix = $"burst-log-{System.Guid.NewGuid():N}";
            var loggingObject = _cleanup.Add(new GameObject("remote-logging"));
            loggingObject.AddComponent<RemoteLogging>();

            for (var i = 1; i <= 1200; i++)
                Debug.Log($"{prefix} {i}");

            yield return E2EServer.WaitUntil(() => LoggedLines(prefix).Length >= 1000,
                $"Only {LoggedLines(prefix).Length} of the 1000 lines kept reached the server");

            // Past RemoteLogging's one-second send interval, so anything else would have shown up.
            yield return E2EServer.Settle(1.5f);

            Assert.That(LoggedLines(prefix), Is.EqualTo(Enumerable.Range(201, 1000).Select(i => $"{prefix} {i}").ToArray()),
                "The newest 1000 lines of the burst should have arrived, in order");

            var summaries = LoggedLines("Colibri: ").Where(line => line.Contains("log lines are missing here")).ToArray();
            Assert.That(summaries.Length, Is.EqualTo(1), "The lines the burst lost should be summed up in exactly one line");
            Assert.That(summaries[0], Does.StartWith("Colibri: 200 log lines are missing here"));
        }


        /*
         *  Connection events
         */

        /// <summary>
        /// The connection drops and is back before the next frame: a long frame - a scene load on a
        /// headset - during a Wi-Fi blip. OnConnected and OnDisconnected used to be two flags that
        /// Update raised in a fixed order, connected first, so this raised OnConnected and then
        /// OnDisconnected, and left user code believing it was offline while it was connected.
        /// </summary>
        [UnityTest]
        public IEnumerator ADropAndReconnectWithinOneFrameEndsWithOnConnected()
        {
            var events = new List<string>();
            System.Action onConnected = () => events.Add("connected");
            System.Action onDisconnected = () => events.Add("disconnected");

            var connection = Connection;
            connection.OnConnected += onConnected;
            connection.OnDisconnected += onDisconnected;
            try
            {
                var sessions = connection.ConnectedSessions;
                _proxy.Cut();

                // No Update runs while this holds the main thread. The connection's own loop does
                // not need one: it notices the drop and connects again regardless.
                var deadline = System.DateTime.UtcNow.AddSeconds(10);
                while (connection.ConnectedSessions == sessions && System.DateTime.UtcNow < deadline)
                    System.Threading.Thread.Sleep(10);

                Assert.That(connection.ConnectedSessions, Is.EqualTo(sessions + 1),
                    "The client never reconnected while the main thread was held");
                Assert.That(events, Is.Empty, "A connection event was raised off the main thread");

                yield return null;

                Assert.That(events, Is.EqualTo(new[] { "disconnected", "connected" }),
                    "The drop and the reconnect were not reported in the order they happened");
                Assert.That(connection.Status, Is.EqualTo(ConnectionStatus.Connected));
            }
            finally
            {
                connection.OnConnected -= onConnected;
                connection.OnDisconnected -= onDisconnected;
            }
        }


        /*
         *  Helpers
         */

        /// <summary>What the client sent on the connection after the first reconnect, in order.</summary>
        private List<Networking.Protocol.DecodedFrame> SecondSession()
            => _proxy.FromClient.Where(sent => sent.Session == 2).Select(sent => sent.Frame).ToList();

        /// <summary>The updates of one model the client wrote into the connection after <see cref="TcpProxy.Unplug"/>.</summary>
        private JObject[] Swallowed(string channel, string id)
            => _proxy.Swallowed
                .Where(sent => sent.Frame.Channel == channel && sent.Frame.Command == "model::update")
                .Select(sent => TcpPeer.Json(sent.Frame) as JObject)
                .Where(update => update != null && (string)update["id"] == id)
                .ToArray();

        /// <summary>A GameObject with <typeparamref name="T"/> on it, destroyed when the test ends.</summary>
        private T Spawn<T>(string name) where T : Component
            => _cleanup.Add(new GameObject(name)).AddComponent<T>();

        private static E2ESyncModel[] Instances(string id)
            => UnityCompat.FindAll<E2ESyncModel>(FindObjectsInactive.Include)
                .Where(m => m.Id == id)
                .ToArray();

        /// <summary>
        /// The ids the client asked for one at a time on <paramref name="channel"/>, on its
        /// <paramref name="session"/>th connection. A request for the whole channel has no payload.
        /// </summary>
        private string[] RequestedIds(int session, string channel)
            => _proxy.FromClient
                .Where(sent => sent.Session == session && sent.Frame.Channel == channel && sent.Frame.Command == "model::request")
                .Where(sent => TcpPeer.Text(sent.Frame).Length > 0)
                .Select(sent => (string)(TcpPeer.Json(sent.Frame) as JObject)?["id"])
                .Where(id => id != null)
                .ToArray();

        /// <summary>The client's log lines with the given prefix, as the server received them, in order.</summary>
        private string[] LoggedLines(string prefix)
            => _proxy.FromClient
                .Where(sent => sent.Frame.Channel == "log")
                .Select(sent => TcpPeer.Text(sent.Frame))
                .Where(line => line.StartsWith(prefix))
                .ToArray();

        /// <summary>Cuts the link and waits until the client has noticed, so what follows is sent during the outage.</summary>
        private IEnumerator CutTheConnection()
        {
            var sessions = _proxy.Sessions;
            _proxy.Cut();

            yield return E2EServer.WaitUntil(() => Connection.Status != ConnectionStatus.Connected,
                "The client never noticed that its connection was cut");

            // Still the session that was cut: the reconnect is at least 500 ms of backoff away.
            Assert.That(_proxy.Sessions, Is.EqualTo(sessions));
        }

        /// <summary>
        /// The raw peer sends a new label for the model every frame, as a client moving it would,
        /// until <paramref name="until"/> holds and for a few frames beyond.
        /// </summary>
        private IEnumerator KeepUpdatingTheLabel(string id, System.Func<bool> until)
        {
            const string channel = "e2esyncmodel";
            var deadline = Time.realtimeSinceStartup + 20f;
            var n = 0;

            for (var after = 0; after < 5;)
            {
                Assert.That(Time.realtimeSinceStartup, Is.LessThan(deadline),
                    "The requests made again after the reconnect were never answered");
                if (until())
                    after++;

                _peer.Send(channel, "model::update", new JObject { { "id", id }, { "label", $"theirs {n++}" } });
                yield return null;
            }
        }

        private int[] Received(string channel)
            => _peer.Received
                .Where(f => f.Channel == channel)
                .Select(f => int.Parse(TcpPeer.Text(f)))
                .ToArray();

        private static IEnumerator DestroyConnection()
        {
            var existing = Object.FindAnyObjectByType<WebServerConnection>();
            if (existing != null)
            {
                // OnDisable cancels the loop and closes the socket; the frame after is what lets
                // the cancelled loop unwind before anything rebuilds it.
                Object.DestroyImmediate(existing.gameObject);
                yield return null;
            }
        }
    }
}
