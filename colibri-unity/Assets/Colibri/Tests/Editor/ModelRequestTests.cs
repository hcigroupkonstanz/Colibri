using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using HCIKonstanz.Colibri.Core;
using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Networking.Protocol;
using HCIKonstanz.Colibri.Synchronization;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEngine;
using Object = UnityEngine.Object;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// The model::request a listener sends, as the server reads it. A request for one object is
    /// either fresh - the object is in this client's scene now, or being created - or, after a
    /// reconnect, a request again, with <c>again: true</c>, for an object this client held before
    /// the outage. The server treats the two differently when another client has deleted the
    /// object: a fresh request brings the id back into use, a request again is answered with the
    /// delete. Sent fresh after a reconnect, it used to bring back an object deleted while this
    /// client was offline.
    ///
    /// Also the deletes sent again when an outage is noticed: those made around when this client
    /// last heard from the server may have gone into the dead link.
    /// </summary>
    public class ModelRequestTests
    {
        private static int _channelCounter;

        private readonly List<IDisposable> _disposables = new List<IDisposable>();
        private readonly List<Action> _cleanup = new List<Action>();

        /// <summary>An earlier test's outage, round of answers or deletes would count as this test's.</summary>
        [SetUp]
        public void StartASession()
        {
            Sync.ResetListeners();
            LocallyDeletedModels.Reset();
        }

        [TearDown]
        public void Cleanup()
        {
            LocallyDeletedModels.Reset();

            foreach (var undo in _cleanup)
                undo();
            _cleanup.Clear();

            foreach (var disposable in _disposables)
                disposable.Dispose();
            _disposables.Clear();

            // Registering a listener creates the connection singleton - in edit mode an inert
            // component on a GameObject in the open scene. It is not this test's to keep.
            foreach (var connection in UnityCompat.FindAll<WebServerConnection>(FindObjectsInactive.Include))
                Object.DestroyImmediate(connection.gameObject);
        }

        private static string NewChannel() => $"model-request-test-{++_channelCounter}";

        private void Listen(string channel, Action<JObject> listener, string id = null)
        {
            if (id == null)
                Sync.AddModelUpdateListener(channel, listener);
            else
                Sync.AddModelUpdateListener(channel, listener, id);

            _cleanup.Add(() => Sync.RemoveModelUpdateListener(channel, listener));
        }

        [Test]
        public void ARequestWhenAListenerRegistersIsFresh()
        {
            var channel = NewChannel();
            Listen(channel, _ => { }, "door");
            Listen(channel, _ => { });

            Assert.That(Requests(channel), Is.EqualTo(new[] { "{\"id\":\"door\"}", "null" }));
        }

        [Test]
        public void ARequestAfterAReconnectSaysItIsARequestAgain()
        {
            var channel = NewChannel();
            Listen(channel, _ => { }, "door");
            Listen(channel, _ => { });

            Sync.RequestModelsAgain();

            Assert.That(Requests(channel), Is.EqualTo(new[]
            {
                "{\"id\":\"door\"}",
                "null",
                "{\"id\":\"door\",\"again\":true}",
                "null",
            }), "Only the request for one object says again; the request for every model on the channel is the same as before");
        }

        /// <summary>
        /// After the requests made again for a SyncBehaviour's object, on every channel, one more
        /// goes out, for an id no model has: the server answers a client's requests in the order
        /// they came, so its answer marks the end of theirs. See Sync.ReconnectRound.
        /// </summary>
        [Test]
        public void TheRequestsMadeAgainForObjectsAreFollowedByOneWhoseAnswerEndsThem()
        {
            var doors = NewChannel();
            var windows = NewChannel();
            Sync.ReconnectRound told = null;
            Action<JObject> door = _ => { };
            Action<JObject> window = _ => { };
            Sync.AddModelUpdateListener(doors, door, "door", round => told = round);
            _cleanup.Add(() => Sync.RemoveModelUpdateListener(doors, door));
            Sync.AddModelUpdateListener(windows, window, "window", round => { });
            _cleanup.Add(() => Sync.RemoveModelUpdateListener(windows, window));
            Listen(windows, _ => { });

            Sync.RequestModelsAgain();

            Assert.That(told, Is.Not.Null, "The object was not told about the round its answer is part of");
            var marker = $"{{\"id\":\"{told.EndMarkerId}\",\"again\":true}}";
            var requests = Requests(new[] { doors, windows, Sync.ReconnectRoundChannel });

            Assert.That(requests.Take(3), Is.EqualTo(new[]
            {
                (doors, "{\"id\":\"door\"}"),
                (windows, "{\"id\":\"window\"}"),
                (windows, "null"),
            }), "Precondition: the requests made when the listeners registered");
            Assert.That(requests.Skip(3).Take(3), Is.EquivalentTo(new[]
            {
                (doors, "{\"id\":\"door\",\"again\":true}"),
                (windows, "{\"id\":\"window\",\"again\":true}"),
                (windows, "null"),
            }), "The requests made again");
            Assert.That(requests.Skip(6), Is.EqualTo(new[] { (Sync.ReconnectRoundChannel, marker) }),
                "The request that marks the end of the answers should come last, after those on every channel");
        }


        /*
         *  The deletes sent again when the outage is noticed.
         */

        /// <summary>
        /// The server heard from, as the receive loop notes it, and seen by SyncTicker in the frame at
        /// <paramref name="time"/>, on its clock.
        /// </summary>
        private static void HeardFromTheServerAt(double time)
        {
            WebServerConnection.Instance.StampLiveness();
            Sync.LastHeardAt(time);
        }

        /// <summary>
        /// When this client last heard from the server is the frame that saw it, on Unity's clock,
        /// however far the system clock, which times the heartbeats, has moved since: the two need
        /// not keep pace. Here the system clock hardly moves while Unity's runs on for a minute.
        /// </summary>
        [Test]
        public void TheServerWasLastHeardFromInTheFrameThatSawIt()
        {
            Listen(NewChannel(), _ => { });
            HeardFromTheServerAt(200);

            Assert.That(Sync.LastHeardAt(260), Is.EqualTo(200), "Nothing was heard from the server since the frame at 200");

            HeardFromTheServerAt(261);
            Assert.That(Sync.LastHeardAt(262), Is.EqualTo(261));
        }

        /// <summary>
        /// Heard from during a frame that took seconds, the server was last heard from when the
        /// system clock says, but no earlier than the frame before and no later than this one: the
        /// system clock may have been set forward or back since.
        /// </summary>
        [Test]
        public void TheServerWasLastHeardFromBetweenTheFrameBeforeAndThisOne()
        {
            Listen(NewChannel(), _ => { });
            HeardFromTheServerAt(200);

            WebServerConnection.Instance.StampLiveness(millisAgo: 2_000);
            Assert.That(Sync.LastHeardAt(203), Is.EqualTo(201).Within(0.5));

            WebServerConnection.Instance.StampLiveness(millisAgo: 600_000);
            Assert.That(Sync.LastHeardAt(204), Is.EqualTo(203), "The system clock was set forward ten minutes");

            WebServerConnection.Instance.StampLiveness(millisAgo: -600_000);
            Assert.That(Sync.LastHeardAt(205), Is.EqualTo(205), "The system clock was set back ten minutes");
        }

        /// <summary>
        /// A delete made just before a frame that took seconds, such as a scene loaded
        /// synchronously, in which the link died: the server was heard from early in that frame, and
        /// the delete goes out again. Taken to be heard from when the frame ran, it lay more than a
        /// second before, and was not sent again.
        /// </summary>
        [Test]
        public void ADeleteMadeJustBeforeALongFrameGoesOutAgain()
        {
            var channel = NewChannel();
            Listen(channel, _ => { });
            HeardFromTheServerAt(200);
            LocallyDeletedModels.Remember(channel, "destroyed before the long frame", 200.01);

            // Heard from 30 ms into a frame that ran 3 s later, and the link died soon after.
            WebServerConnection.Instance.StampLiveness(millisAgo: 2_970);
            Sync.OnDisconnected(now: 203);

            Assert.That(Deletes(channel), Is.EqualTo(new[] { "destroyed before the long frame" }));
        }

        /// <summary>
        /// A delete made after this client last heard from the server may have gone into the dead
        /// link, and goes out again when the outage is noticed, counted on Unity's clock.
        /// </summary>
        [Test]
        public void ADeleteMadeAfterTheServerWasLastHeardFromGoesOutAgain()
        {
            var channel = NewChannel();
            Listen(channel, _ => { });
            LocallyDeletedModels.Remember(channel, "destroyed long before", 150);
            HeardFromTheServerAt(200);
            LocallyDeletedModels.Remember(channel, "destroyed at the drop", 200.5);

            Sync.OnDisconnected(now: 203);

            Assert.That(Deletes(channel), Is.EqualTo(new[] { "destroyed at the drop" }));
        }

        /// <summary>
        /// The link drops again right after the reconnect, before the server has read the deletes
        /// sent again ahead of the requests: they may have gone into that link too, and go out once
        /// more, counted from the earlier outage. With no synced object left to ask for again, the
        /// request that marks the end of the answers still goes out, for them.
        /// </summary>
        [Test]
        public void ADeleteSentAgainGoesOutOnceMoreWhenTheLinkDropsAgainBeforeTheAnswers()
        {
            var channel = NewChannel();
            Listen(channel, _ => { });
            HeardFromTheServerAt(200);
            LocallyDeletedModels.Remember(channel, "destroyed at the drop", 200.5);
            Sync.OnDisconnected(now: 203);
            Sync.RequestModelsAgain(disconnectedAt: 203);
            Assert.That(Sync.ReconnectRoundEndMarker, Is.Not.Null, "Nothing marks the end of the answers, after which the server has read the deletes");

            HeardFromTheServerAt(205);
            Sync.OnDisconnected(now: 208);

            Assert.That(Deletes(channel), Is.EqualTo(new[] { "destroyed at the drop", "destroyed at the drop" }));
        }

        /// <summary>
        /// The same after an outage of more than a minute, longer than a delete is remembered: the
        /// server may never have had it, and it goes out once more however old, as one made during
        /// the outage goes out however old. Left out, it was never sent again, and the next
        /// reconnect brought the object back for everyone.
        /// </summary>
        [Test]
        public void ADeleteSentAgainGoesOutOnceMoreAfterALongOutageWhenTheLinkDropsAgain()
        {
            var channel = NewChannel();
            Listen(channel, _ => { });
            HeardFromTheServerAt(200);
            LocallyDeletedModels.Remember(channel, "destroyed at the drop", 200.5);
            Sync.OnDisconnected(now: 203);
            Assert.That(283 - 200.5, Is.GreaterThan(LocallyDeletedModels.WindowSeconds), "Precondition: the delete is no longer remembered at the second drop");

            HeardFromTheServerAt(280);
            Sync.RequestModelsAgain();
            HeardFromTheServerAt(280.5);
            Sync.OnDisconnected(now: 283);

            Assert.That(Deletes(channel), Is.EqualTo(new[] { "destroyed at the drop", "destroyed at the drop" }));
        }

        /// <summary>
        /// A delete made during the outage, or while the answers come in, goes out once more too
        /// when the link drops again before they are all in: the server may not have read it
        /// either, however old it is.
        /// </summary>
        [Test]
        public void ADeleteMadeSinceTheOutageGoesOutOnceMoreWhenTheLinkDropsAgainBeforeTheAnswers()
        {
            var channel = NewChannel();
            Listen(channel, _ => { });
            HeardFromTheServerAt(200);
            Sync.OnDisconnected(now: 203);
            Delete(channel, "destroyed during the outage", 210);

            HeardFromTheServerAt(280);
            Sync.RequestModelsAgain();
            Delete(channel, "destroyed while the answers come in", 280.2);
            Sync.OnDisconnected(now: 283);

            Assert.That(Deletes(channel), Is.EqualTo(new[]
            {
                "destroyed during the outage",
                "destroyed while the answers come in",
                "destroyed during the outage",
                "destroyed while the answers come in",
            }));
        }

        /// <summary>
        /// Not one whose object this client has created again since, under the same id, as a
        /// scene loaded again does: asked for afresh, the id is in use again on the server, and the
        /// delete sent once more would remove the object there and on every other client.
        /// </summary>
        [Test]
        public void ADeleteWhoseObjectWasCreatedAgainDoesNotGoOutOnceMore()
        {
            var channel = NewChannel();
            Listen(channel, _ => { });
            HeardFromTheServerAt(200);
            Sync.OnDisconnected(now: 203);
            Delete(channel, "placed in the scene", 210);
            Delete(channel, "destroyed for good", 210);
            Created(channel, "placed in the scene");

            HeardFromTheServerAt(215);
            Sync.RequestModelsAgain();
            Sync.OnDisconnected(now: 218);

            Assert.That(Deletes(channel), Is.EqualTo(new[] { "placed in the scene", "destroyed for good", "destroyed for good" }));
        }

        /// <summary>
        /// Once the answers are in, the server has read the deletes sent again ahead of the
        /// requests, and the next outage counts from when this client last heard from the server.
        /// </summary>
        [Test]
        public void ADeleteSentAgainDoesNotGoOutOnceMoreAfterTheAnswers()
        {
            var channel = NewChannel();
            Listen(channel, _ => { });
            HeardFromTheServerAt(200);
            LocallyDeletedModels.Remember(channel, "destroyed at the drop", 200.5);
            Sync.OnDisconnected(now: 203);
            Sync.RequestModelsAgain(disconnectedAt: 203);
            EndOfAnswers();

            HeardFromTheServerAt(205);
            Sync.OnDisconnected(now: 208);

            Assert.That(Deletes(channel), Is.EqualTo(new[] { "destroyed at the drop" }));
        }


        /*
         *  Helpers
         */

        /// <summary>An object destroyed at <paramref name="time"/>, on SyncTicker's clock, as SyncBehaviour's OnDestroy deletes it.</summary>
        private static void Delete(string channel, string id, double time)
        {
            LocallyDeletedModels.Remember(channel, id, time);
            Sync.SendModelDelete(channel, id);
        }

        /// <summary>An object placed in the scene or created here, as SyncBehaviour's Awake registers it.</summary>
        private void Created(string channel, string id)
        {
            LocallyDeletedModels.Forget(channel, id);
            Listen(channel, _ => { }, id);
        }

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

        /// <summary>
        /// The payloads of the model::requests sent on <paramref name="channel"/> so far, in order:
        /// connects the queue to a loopback session, as a reconnect does, and reads everything it
        /// is sent, up to an end marker queued last.
        /// </summary>
        private List<string> Requests(string channel)
            => Requests(new[] { channel }).Select(request => request.Payload).ToList();

        /// <summary>
        /// The model::requests sent on any of <paramref name="channels"/> so far, in order, with
        /// their channels. See the overload above.
        /// </summary>
        private List<(string Channel, string Payload)> Requests(string[] channels) => Sent(channels, "model::request");

        /// <summary>The ids of the model::deletes sent on <paramref name="channel"/> so far, in order. See <see cref="Requests(string)"/>.</summary>
        private List<string> Deletes(string channel)
            => Sent(new[] { channel }, "model::delete").Select(delete => (string)JObject.Parse(delete.Payload)["id"]).ToList();

        /// <summary>
        /// The messages with <paramref name="command"/> sent on any of <paramref name="channels"/> so
        /// far, in order, with their channels. See <see cref="Requests(string)"/>.
        /// </summary>
        private List<(string Channel, string Payload)> Sent(string[] channels, string command)
        {
            var connection = WebServerConnection.Instance;
            connection.SendCommand("model-request-test-end", "end", null);

            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            Socket server;
            try
            {
                var client = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
                _disposables.Add(client);
                client.Connect((IPEndPoint)listener.LocalEndpoint);

                server = listener.AcceptSocket();
                _disposables.Add(server);
                server.ReceiveTimeout = 5000;

                var session = new CancellationTokenSource();
                _disposables.Add(session);
                _cleanup.Add(connection.CloseOutbox);
                connection.OpenOutbox(WebServerConnection.Session.Plain(client), session.Token);
            }
            finally
            {
                listener.Stop();
            }

            var reader = new FrameReader();
            var frames = new List<DecodedFrame>();
            var buffer = new byte[4096];
            while (!frames.Any(frame => frame.Channel == "model-request-test-end"))
            {
                var received = server.Receive(buffer);
                Assert.That(received, Is.GreaterThan(0), "The session was closed before the queued messages had all arrived");
                frames.AddRange(reader.Append(new ReadOnlySpan<byte>(buffer, 0, received)));
            }

            return frames
                .Where(frame => channels.Contains(frame.Channel) && frame.Command == command)
                .Select(frame => (frame.Channel, frame.Payload == null || frame.Payload.Length == 0 ? "null" : Encoding.UTF8.GetString(frame.Payload)))
                .ToList();
        }
    }
}
