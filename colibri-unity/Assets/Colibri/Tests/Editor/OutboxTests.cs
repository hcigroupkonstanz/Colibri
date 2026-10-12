using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Networking.Protocol;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;
using Object = UnityEngine.Object;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// The order in which queued messages leave the outbox, without a server: the tests open and
    /// close the outbox around sessions they fake, and read what a session is sent from a loopback
    /// socket.
    ///
    /// During an outage the model::updates for one object are folded into one, which moves the
    /// combined update to the back of the queue. That is only safe while nothing queued after the
    /// earlier update is about the same object. Moved past a newer update, a delete or a request
    /// for that object, its older values arrive last, and on a last-write-wins server they win.
    /// </summary>
    public class OutboxTests
    {
        private const string Channel = "outbox-test";
        private const string OtherChannel = "outbox-test-other";
        private const string EndChannel = "outbox-test-end";

        private GameObject _gameObject;
        private WebServerConnection _connection;
        private readonly List<IDisposable> _disposables = new List<IDisposable>();

        // Edit mode: OnEnable never runs, so there is no connection loop and the outbox stays
        // closed - every send waits in it, as during an outage - until a test opens it.
        [SetUp]
        public void CreateConnection()
        {
            _gameObject = new GameObject("outbox-under-test");
            _connection = _gameObject.AddComponent<WebServerConnection>();
        }

        [TearDown]
        public void DestroyConnection()
        {
            _connection.CloseOutbox();

            foreach (var disposable in _disposables)
                disposable.Dispose();
            _disposables.Clear();

            if (_gameObject != null)
                Object.DestroyImmediate(_gameObject);
        }


        /*
         *  An update must not be folded past anything else about the same object
         */

        /// <summary>
        /// The reconnect after an outage starts sending its queue, but the link is slow, and the
        /// user changes the label again before the queued update has gone out. The connection drops
        /// once more, and in the next outage another member of the same object changes. That change
        /// used to be folded into the update left over from the first outage, which moved that one
        /// - and its old label - behind the newer label.
        /// </summary>
        [Test]
        public void AnUpdateLeftOverFromAnEarlierOutageIsNotFoldedPastANewerOne()
        {
            // Outage 1.
            _connection.SendCommand(Channel, "model::update", new JObject { { "id", "X" }, { "label", "a" } });

            // Session 1 connects, but the socket is still busy with another write when the label
            // changes again, and the session is gone before anything was sent.
            var session = new CancellationTokenSource();
            _disposables.Add(session);
            var goneSocket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
            _disposables.Add(goneSocket);

            // Never connected, so it gets a stream that refuses every write.
            var goneSession = new WebServerConnection.Session(goneSocket, new System.IO.MemoryStream(Array.Empty<byte>(), false));

            _connection.SendLock.Wait();
            try
            {
                _connection.OpenOutbox(goneSession, session.Token);
                _connection.SendCommand(Channel, "model::update", new JObject { { "id", "X" }, { "label", "b" } });

                _connection.CloseOutbox();
                session.Cancel();
            }
            finally
            {
                _connection.SendLock.Release();
            }

            // Outage 2.
            _connection.SendCommand(Channel, "model::update", new JObject { { "id", "X" }, { "count", 5 } });

            var state = ServerStateOf("X", SendEverythingQueued());

            Assert.That((string)state["label"], Is.EqualTo("b"), "An update from an earlier outage was moved past a newer one, and its older label won");
            Assert.That((int)state["count"], Is.EqualTo(5));
        }

        /// <summary>
        /// Within one outage: the second update for the object used to be folded into the first,
        /// which moved the first past whatever came between them - a newer update someone awaits,
        /// a request the server then answered without the first update applied, or a delete that
        /// the old values then outlived.
        /// </summary>
        [TestCase("model::update", "{\"id\":\"X\",\"label\":\"b\"}", true)]
        [TestCase("model::request", "{\"id\":\"X\"}", false)]
        [TestCase("model::request", "null", false)]
        [TestCase("model::delete", "{\"id\":\"X\"}", false)]
        public void AnUpdateIsNotFoldedPastAnotherMessageAboutTheSameObject(string command, string payload, bool awaited)
        {
            _connection.SendCommand(Channel, "model::update", new JObject { { "id", "X" }, { "label", "a" }, { "colour", "red" } });

            Task<bool> awaitedSend = null;
            if (awaited)
                awaitedSend = _connection.SendCommandAsync(Channel, command, JToken.Parse(payload));
            else
                _connection.SendCommand(Channel, command, JToken.Parse(payload));

            _connection.SendCommand(Channel, "model::update", new JObject { { "id", "X" }, { "count", 5 } });

            var sent = SendEverythingQueued();

            Assert.That(sent.Select(Describe), Is.EqualTo(new[]
            {
                "model::update {\"id\":\"X\",\"label\":\"a\",\"colour\":\"red\"}",
                $"{command} {JToken.Parse(payload).ToString(Newtonsoft.Json.Formatting.None)}",
                "model::update {\"id\":\"X\",\"count\":5}",
            }), $"The updates were folded into one that went out after the {command}");

            if (awaitedSend != null)
                Assert.That(awaitedSend.Wait(5000) && awaitedSend.Result, Is.True, "The awaited update was not reported as sent");
        }

        /// <summary>
        /// The counterpart: what is about other objects, or another channel, does not stop the fold,
        /// so an outage still costs one update per object.
        /// </summary>
        [Test]
        public void UpdatesAreStillFoldedPastMessagesAboutOtherObjects()
        {
            _connection.SendCommand(Channel, "model::update", new JObject { { "id", "X" }, { "label", "a" } });

            _connection.SendCommand(Channel, "model::update", new JObject { { "id", "Y" }, { "label", "y" } });
            _connection.SendCommand(Channel, "model::request", new JObject { { "id", "Y" } });
            _connection.SendCommand(Channel, "model::delete", new JObject { { "id", "Z" } });
            _connection.SendCommand(OtherChannel, "model::request", null);
            _connection.SendCommand(OtherChannel, "model::delete", new JObject { { "id", "X" } });
            _connection.SendCommand(Channel, "broadcast::int", 1);

            _connection.SendCommand(Channel, "model::update", new JObject { { "id", "X" }, { "count", 5 } });

            var updatesOfX = SendEverythingQueued()
                .Where(frame => frame.Channel == Channel && frame.Command == "model::update")
                .Select(Json)
                .Where(update => (string)update["id"] == "X")
                .ToList();

            Assert.That(updatesOfX.Count, Is.EqualTo(1), "The updates of X were not folded into one");
            Assert.That((string)updatesOfX[0]["label"], Is.EqualTo("a"));
            Assert.That((int)updatesOfX[0]["count"], Is.EqualTo(5));
        }


        /*
         *  The cap on the whole outbox
         */

        /// <summary>
        /// Only broadcasts and the like count towards the outage bound. Model requests, deletes and
        /// updates that cannot be folded used to queue without any limit at all - an outage in which
        /// objects keep coming and going is enough. Past 10 000 messages in all the oldest go now:
        /// first what may be dropped, then the oldest model messages, and an awaited one that goes
        /// is reported as not sent.
        /// </summary>
        [Test]
        public void PastTheCapTheOldestMessagesGoBroadcastsFirst()
        {
            var awaited = _connection.SendCommandAsync(Channel, "model::request", new JObject { { "id", "awaited" } });

            for (var i = 1; i <= 100; i++)
                _connection.SendCommand(Channel, "broadcast::int", i);

            // 10 051 in all: the 51 oldest broadcasts go.
            LogAssert.Expect(LogType.Warning, new Regex("^Colibri: more than 10000 messages are waiting to be sent, so the oldest are being dropped"));
            for (var i = 1; i <= 9950; i++)
                _connection.SendCommand(Channel, "model::request", new JObject { { "id", $"r{i}" } });

            // 59 more: the 49 broadcasts left, then the awaited request and the nine oldest of the rest.
            for (var i = 9951; i <= 10009; i++)
                _connection.SendCommand(Channel, "model::request", new JObject { { "id", $"r{i}" } });

            var sent = Receive(OpenSession(), 10000);

            Assert.That(sent.Select(Describe), Is.EqualTo(Enumerable.Range(10, 10000).Select(i => $"model::request {{\"id\":\"r{i}\"}}")),
                "The outbox should hold the newest 10 000 messages, having dropped the broadcasts before any model message");
            Assert.That(awaited.IsCompleted && !awaited.Result, Is.True, "A dropped message someone awaits was not reported as not sent");

            // Said once, not once per message dropped.
            LogAssert.NoUnexpectedReceived();
        }

        /// <summary>
        /// The cap holds while connected too, for a connection whose writes fall behind what is sent.
        /// The message being written at that moment is never the one dropped: it may well arrive.
        /// </summary>
        [Test]
        public void TheCapHoldsWhileConnectedWithoutDroppingTheMessageBeingWritten()
        {
            var session = OpenSession();

            // A write that does not complete: the first message is on its way, the rest pile up.
            _connection.SendLock.Wait();
            try
            {
                _connection.SendCommand(Channel, "broadcast::int", 0);

                LogAssert.Expect(LogType.Warning, new Regex("^Colibri: more than 10000 messages are waiting to be sent"));
                for (var i = 1; i <= 10050; i++)
                    _connection.SendCommand(Channel, "broadcast::int", i);
            }
            finally
            {
                _connection.SendLock.Release();
            }

            var sent = Receive(session, 10000).Select(frame => int.Parse(Encoding.UTF8.GetString(frame.Payload))).ToArray();

            Assert.That(sent, Is.EqualTo(new[] { 0 }.Concat(Enumerable.Range(52, 9999))),
                "The newest 10 000 should be kept, and the one being written when the cap was reached with them");
            LogAssert.NoUnexpectedReceived();
        }


        /*
         *  A connection loop that has been ended
         *
         *  A disable and enable in one frame starts the next connection loop while the ended one is
         *  still unwinding on a worker thread. Its cleanup used to close the outbox under the next
         *  loop's session and set Disconnected, whenever it got round to it: a session already
         *  Connected was then either dropped or left saying Connected with every send waiting.
         */

        /// <summary>
        /// The ended loop's cleanup, late, after the next loop's session is up: the session stays
        /// Connected, and what is sent still goes out on it.
        /// </summary>
        [Test]
        public void AnEndedLoopLeavesTheNextSessionConnectedAndItsOutboxOpen()
        {
            var server = OpenSession();
            Assert.That(_connection.TrySetStatus(ConnectionStatus.Connected, CancellationToken.None), Is.True);

            var ended = EndedLoop();
            _connection.CloseOutbox(ended);
            Assert.That(_connection.TrySetStatus(ConnectionStatus.Disconnected, ended), Is.False);

            Assert.That(_connection.Status, Is.EqualTo(ConnectionStatus.Connected));
            _connection.SendCommand(Channel, "broadcast::int", 1);
            Assert.That(Receive(server, 1).Select(Describe), Is.EqualTo(new[] { "broadcast::int 1" }));
        }

        /// <summary>
        /// A session of the ended loop that gets as far as its first frame does not take the outbox
        /// over: what is sent waits for the next loop's session rather than going to a socket that
        /// is being closed.
        /// </summary>
        [Test]
        public void AnEndedLoopDoesNotOpenTheOutbox()
        {
            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            Socket endedServer;
            Socket endedClient;
            try
            {
                endedClient = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
                _disposables.Add(endedClient);
                endedClient.Connect((IPEndPoint)listener.LocalEndpoint);
                endedServer = listener.AcceptSocket();
                _disposables.Add(endedServer);
            }
            finally
            {
                listener.Stop();
            }

            _connection.OpenOutbox(WebServerConnection.Session.Plain(endedClient), EndedLoop());
            _connection.SendCommand(Channel, "broadcast::int", 1);

            Assert.That(endedServer.Poll(300 * 1000, SelectMode.SelectRead), Is.False, "A message went out on the ended loop's session");
            Assert.That(SendEverythingQueued().Select(Describe), Is.EqualTo(new[] { "broadcast::int 1" }));
        }


        /*
         *  Helpers
         */

        /// <summary>The token of a connection loop that OnDisable has ended.</summary>
        private CancellationToken EndedLoop()
        {
            var loop = new CancellationTokenSource();
            _disposables.Add(loop);
            loop.Cancel();
            return loop.Token;
        }

        /// <summary>
        /// Connects a fresh session, as a reconnect does, and returns everything it is sent: what
        /// was queued, in the order it went out. An end marker queued last says when that is.
        /// </summary>
        private List<DecodedFrame> SendEverythingQueued()
        {
            _connection.SendCommand(EndChannel, "end", null);

            var server = OpenSession();

            var reader = new FrameReader();
            var frames = new List<DecodedFrame>();
            var buffer = new byte[4096];
            while (!frames.Any(frame => frame.Channel == EndChannel))
            {
                int received;
                try
                {
                    received = server.Receive(buffer);
                }
                catch (SocketException e)
                {
                    Assert.Fail($"The queued messages did not all arrive ({e.SocketErrorCode}); {frames.Count} did");
                    throw;
                }

                Assert.That(received, Is.GreaterThan(0), "The session was closed before the queued messages had all arrived");
                frames.AddRange(reader.Append(new ReadOnlySpan<byte>(buffer, 0, received)));
            }

            return frames.Where(frame => frame.Channel != EndChannel).ToList();
        }

        /// <summary>
        /// Connects a fresh session over loopback, as a reconnect does, and hands back the server's
        /// end of it: the outbox starts draining into it straight away.
        /// </summary>
        private Socket OpenSession()
        {
            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            Socket client;
            Socket server;
            try
            {
                client = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
                _disposables.Add(client);
                client.Connect((IPEndPoint)listener.LocalEndpoint);

                server = listener.AcceptSocket();
                _disposables.Add(server);
                server.ReceiveTimeout = 5000;
            }
            finally
            {
                listener.Stop();
            }

            var session = new CancellationTokenSource();
            _disposables.Add(session);
            _connection.OpenOutbox(WebServerConnection.Session.Plain(client), session.Token);
            return server;
        }

        /// <summary>
        /// Reads exactly <paramref name="count"/> frames from a session, in the order they were
        /// sent, and fails if any more follow. For a test that cannot queue an end marker without
        /// changing what it is testing.
        /// </summary>
        private static List<DecodedFrame> Receive(Socket server, int count)
        {
            var reader = new FrameReader();
            var frames = new List<DecodedFrame>();
            var buffer = new byte[64 * 1024];
            while (frames.Count < count)
            {
                int received;
                try
                {
                    received = server.Receive(buffer);
                }
                catch (SocketException e)
                {
                    Assert.Fail($"Only {frames.Count} of {count} messages arrived ({e.SocketErrorCode})");
                    throw;
                }

                Assert.That(received, Is.GreaterThan(0), $"The session was closed after {frames.Count} of {count} messages");
                frames.AddRange(reader.Append(new ReadOnlySpan<byte>(buffer, 0, received)));
            }

            Assert.That(frames.Count == count && !server.Poll(300 * 1000, SelectMode.SelectRead), Is.True,
                $"More than the {count} messages expected were sent");
            return frames;
        }

        /// <summary>The object as a server that merges each update into what it has would end up with it.</summary>
        private static JObject ServerStateOf(string id, IEnumerable<DecodedFrame> frames)
        {
            var state = new JObject();
            foreach (var frame in frames.Where(f => f.Channel == Channel))
            {
                if (frame.Command != "model::update" && frame.Command != "model::delete")
                    continue;

                var payload = Json(frame);
                if ((string)payload["id"] != id)
                    continue;

                if (frame.Command == "model::delete")
                {
                    state = new JObject();
                    continue;
                }

                foreach (var property in payload.Properties())
                    state[property.Name] = property.Value;
            }

            return state;
        }

        private static JObject Json(DecodedFrame frame)
            => IsEmpty(frame) ? new JObject() : JObject.Parse(Encoding.UTF8.GetString(frame.Payload));

        private static string Describe(DecodedFrame frame)
            => frame.Command + " " + (IsEmpty(frame) ? "null" : Encoding.UTF8.GetString(frame.Payload));

        private static bool IsEmpty(DecodedFrame frame) => frame.Payload == null || frame.Payload.Length == 0;
    }
}
