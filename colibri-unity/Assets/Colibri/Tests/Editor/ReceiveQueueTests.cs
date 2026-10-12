using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using HCIKonstanz.Colibri.Networking;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;
using Object = UnityEngine.Object;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// The queue of received messages waiting for <c>Update</c>, without a server: the tests queue
    /// messages the way the receive loop does and deliver them the way a frame does.
    ///
    /// The receive loop keeps reading while Update does not run - a Quest paused with the headset
    /// off, an Editor in the background without Run In Background - so that the server does not
    /// time the client out. Everything it read used to be queued without limit, some 4 KB a message,
    /// and delivered all at once when Update ran again. Past 1000 waiting messages an object's
    /// updates are now folded into one, and past 10 000 the oldest messages are dropped, broadcasts
    /// first, as in the outbox.
    /// </summary>
    public class ReceiveQueueTests
    {
        private const string Objects = "receive-queue-objects";
        private const string Events = "receive-queue-events";
        private const string Fill = "receive-queue-fill";

        private GameObject _gameObject;
        private WebServerConnection _connection;
        private readonly List<string> _delivered = new List<string>();

        // Edit mode: OnEnable never runs, so there is no connection loop; the tests are the receive
        // loop and the frames.
        [SetUp]
        public void CreateConnection()
        {
            _gameObject = new GameObject("receive-queue-under-test");
            _connection = _gameObject.AddComponent<WebServerConnection>();
            _connection.OnMessageReceived += (channel, command, payload) =>
                _delivered.Add($"{channel} {command} {(payload == null ? "null" : payload.ToString(Formatting.None))}");
        }

        [TearDown]
        public void DestroyConnection()
        {
            _delivered.Clear();
            if (_gameObject != null)
                Object.DestroyImmediate(_gameObject);
        }


        /*
         *  Ordinary traffic
         */

        /// <summary>
        /// What a frame normally hands over is delivered as it arrived: every update of every
        /// object, in order, with nothing folded and nothing said.
        /// </summary>
        [Test]
        public void BelowTheThresholdEveryMessageIsDeliveredAsItArrived()
        {
            var expected = new List<string>();
            for (var i = 0; i < 333; i++)
            {
                Receive(Objects, "model::update", new JObject { { "id", "X" }, { "count", i } }, expected);
                Receive(Events, "broadcast::int", i, expected);
                Receive(Objects, "model::update", new JObject { { "id", "X" }, { "label", $"l{i}" } }, expected);
            }

            _connection.DeliverReceivedMessages();

            Assert.That(_delivered, Is.EqualTo(expected));
            LogAssert.NoUnexpectedReceived();
        }


        /*
         *  Past the threshold: folding
         */

        /// <summary>
        /// Once 1000 messages are waiting, each object's updates travel as one, carrying every
        /// member's newest value, so the object ends up as it would have after all of them.
        /// </summary>
        [Test]
        public void PastTheThresholdAnObjectsUpdatesAreFoldedIntoItsNewestState()
        {
            var fill = FillToTheThreshold();
            for (var i = 1; i <= 5000; i++)
            {
                Receive(Objects, "model::update", new JObject { { "id", "X" }, { "count", i } });
                Receive(Objects, "model::update", new JObject { { "id", "Y" }, { i % 2 == 0 ? "label" : "count", i } });
            }
            Receive(Objects, "model::update", new JObject { { "id", "X" }, { "label", "last" } });

            LogAssert.Expect(LogType.Warning, new Regex(
                "^Colibri: 11001 received messages waited for Update, which did not run for a while .* 9999 model updates were folded "
                + "into the newest state of their object; nothing was dropped\\. Said once per connection\\.$"));

            _connection.DeliverReceivedMessages();

            Assert.That(_delivered, Is.EqualTo(fill.Concat(new[]
            {
                $"{Objects} model::update {{\"id\":\"Y\",\"count\":4999,\"label\":5000}}",
                $"{Objects} model::update {{\"id\":\"X\",\"count\":5000,\"label\":\"last\"}}",
            })));
            LogAssert.NoUnexpectedReceived();
        }

        /// <summary>
        /// A folded update moves to the back of the queue, so it must never be carried past
        /// anything else about the same object: a delete it would then bring back, or the bare
        /// <c>{ id }</c> that answers a request, which a SyncBehaviour acts on and which is never
        /// folded itself. Either ends the fold, and the next update starts a new one behind it.
        /// </summary>
        [Test]
        public void AnUpdateIsNotFoldedPastADeleteOrABareAnswerForTheSameObject()
        {
            var fill = FillToTheThreshold();
            Receive(Objects, "model::update", new JObject { { "id", "X" }, { "label", "a" } });
            Receive(Objects, "model::delete", new JObject { { "id", "X" } });
            Receive(Objects, "model::update", new JObject { { "id", "X" }, { "label", "b" } });
            Receive(Objects, "model::update", new JObject { { "id", "X" }, { "count", 1 } });
            Receive(Objects, "model::update", new JObject { { "id", "Y" }, { "label", "a" } });
            Receive(Objects, "model::update", new JObject { { "id", "Y" } });
            Receive(Objects, "model::update", new JObject { { "id", "Y" } });
            Receive(Objects, "model::update", new JObject { { "id", "Y" }, { "count", 2 } });
            Receive(Objects, "model::update", new JObject { { "id", "Y" }, { "count", 3 } });

            LogAssert.Expect(LogType.Warning, new Regex("^Colibri: 1009 received messages waited for Update, .* 2 model updates were folded "));

            _connection.DeliverReceivedMessages();

            Assert.That(_delivered.Skip(fill.Count), Is.EqualTo(new[]
            {
                $"{Objects} model::update {{\"id\":\"X\",\"label\":\"a\"}}",
                $"{Objects} model::delete {{\"id\":\"X\"}}",
                $"{Objects} model::update {{\"id\":\"X\",\"label\":\"b\",\"count\":1}}",
                $"{Objects} model::update {{\"id\":\"Y\",\"label\":\"a\"}}",
                $"{Objects} model::update {{\"id\":\"Y\"}}",
                $"{Objects} model::update {{\"id\":\"Y\"}}",
                $"{Objects} model::update {{\"id\":\"Y\",\"count\":3}}",
            }));
        }

        /// <summary>
        /// The reported case: Update does not run while the server sends 20 000 updates of 50 moving
        /// objects. They used to be queued, all 20 000, and delivered in one frame.
        /// </summary>
        [Test]
        public void WhileUpdateDoesNotRunAMovingObjectsUpdatesDoNotPileUp()
        {
            for (var i = 0; i < 20000; i++)
            {
                Receive("synctransform", "model::update", new JObject
                {
                    { "id", $"object-{i % 50}" },
                    { "position", new JArray((double)i, 1.5, -0.25) },
                    { "rotation", new JArray(0.0, 0.7071, 0.0, 0.7071) },
                });
            }

            LogAssert.Expect(LogType.Warning, new Regex("^Colibri: 20000 received messages waited for Update, .* 18950 model updates were folded "));

            _connection.DeliverReceivedMessages();

            Assert.That(_delivered.Count, Is.EqualTo(1050), "1000 as they arrived, then one update for each of the 50 objects");
            for (var id = 0; id < 50; id++)
            {
                var newest = 19950 + id;
                Assert.That(_delivered.Last(d => d.Contains($"\"object-{id}\"")), Does.Contain($"\"position\":[{newest}.0,"),
                    $"object-{id} did not end up at its newest position");
            }
        }


        /*
         *  The cap on the whole queue
         */

        [Test]
        public void PastTheCapTheOldestBroadcastsAreDroppedFirst()
        {
            var deletes = new List<string>();
            for (var i = 0; i < 100; i++)
                Receive(Objects, "model::delete", new JObject { { "id", $"d{i}" } }, deletes);
            for (var i = 1; i <= 10000; i++)
                Receive(Events, "broadcast::int", i);

            LogAssert.Expect(LogType.Warning, new Regex(
                "^Colibri: 10100 received messages waited for Update, .* 0 model updates were folded into the newest state of their object "
                + "and the 100 oldest messages were dropped, broadcasts first\\. Said once per connection\\.$"));

            _connection.DeliverReceivedMessages();

            Assert.That(_delivered, Is.EqualTo(deletes.Concat(Enumerable.Range(101, 9900).Select(i => $"{Events} broadcast::int {i}"))),
                "The queue should hold 10 000 messages: every model message, and the newest broadcasts");
            LogAssert.NoUnexpectedReceived();
        }

        [Test]
        public void PastTheCapWithNoBroadcastsLeftTheOldestModelMessagesAreDropped()
        {
            for (var i = 0; i < 10050; i++)
                Receive(Objects, "model::delete", new JObject { { "id", $"d{i}" } });

            LogAssert.Expect(LogType.Warning, new Regex("^Colibri: 10050 received messages waited for Update, .* the 50 oldest messages were dropped"));

            _connection.DeliverReceivedMessages();

            Assert.That(_delivered, Is.EqualTo(Enumerable.Range(50, 10000).Select(i => $"{Objects} model::delete {{\"id\":\"d{i}\"}}")));
        }

        /// <summary>
        /// Said once, for the first backlog: a client that cannot keep up would otherwise say it in
        /// every frame.
        /// </summary>
        [Test]
        public void ABacklogIsReportedOncePerConnection()
        {
            for (var round = 0; round < 2; round++)
            {
                FillToTheThreshold();
                Receive(Objects, "model::update", new JObject { { "id", "X" }, { "count", 1 } });
                Receive(Objects, "model::update", new JObject { { "id", "X" }, { "count", 2 } });

                if (round == 0)
                    LogAssert.Expect(LogType.Warning, new Regex("^Colibri: 1002 received messages waited for Update"));

                _connection.DeliverReceivedMessages();
                Assert.That(_delivered.Last(), Is.EqualTo($"{Objects} model::update {{\"id\":\"X\",\"count\":2}}"));
            }

            LogAssert.NoUnexpectedReceived();
        }


        /*
         *  A connection loop that has been ended
         */

        /// <summary>
        /// A disable and enable in one frame can leave the ended loop's receive loop still handing
        /// over a batch it read before the disable, while the next loop's session is already
        /// queueing. What it hands over from then on is not queued: an older state of an object
        /// would otherwise be delivered after its newer one. What it queued before is delivered.
        /// </summary>
        [Test]
        public void AnEndedLoopQueuesNothingBehindTheNextLoopsMessages()
        {
            using (var ended = new CancellationTokenSource())
            {
                _connection.EnqueueReceived(Objects, "model::update", new JObject { { "id", "X" }, { "count", 1 } }, ended.Token);
                ended.Cancel();

                Receive(Objects, "model::update", new JObject { { "id", "X" }, { "count", 3 } });
                _connection.EnqueueReceived(Objects, "model::update", new JObject { { "id", "X" }, { "count", 2 } }, ended.Token);

                _connection.DeliverReceivedMessages();
            }

            Assert.That(_delivered, Is.EqualTo(new[]
            {
                $"{Objects} model::update {{\"id\":\"X\",\"count\":1}}",
                $"{Objects} model::update {{\"id\":\"X\",\"count\":3}}",
            }));
            LogAssert.NoUnexpectedReceived();
        }


        /*
         *  Helpers
         */

        /// <summary>Queues a message as the receive loop does, and what delivering it shows, if asked.</summary>
        private void Receive(string channel, string command, JToken payload, List<string> expected = null)
        {
            expected?.Add($"{channel} {command} {payload.ToString(Formatting.None)}");
            _connection.EnqueueReceived(channel, command, payload);
        }

        /// <summary>1000 broadcasts: from the next message on, the queue folds.</summary>
        private List<string> FillToTheThreshold()
        {
            var fill = new List<string>();
            for (var i = 0; i < 1000; i++)
                Receive(Fill, "broadcast::int", i, fill);
            return fill;
        }
    }
}
