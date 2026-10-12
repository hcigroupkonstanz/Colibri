using HCIKonstanz.Colibri.Networking;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using UnityEngine;

namespace HCIKonstanz.Colibri.Synchronization
{
    public static class Sync
    {
        private static WebServerConnection _connection;

        /// <summary>
        /// A registered callback, together with the Unity object it belongs to. Keeping the owner
        /// next to the delegate is what lets a listener disappear along with the component that
        /// registered it - see <see cref="ListenerOwner"/> for how the owner is found and why.
        /// </summary>
        private readonly struct Listener<T>
        {
            public readonly Action<T> Callback;

            /// <summary>
            /// Model listeners only: the id whose state was requested when the listener was added,
            /// or null for the listener that asked for every model on the channel. Kept so the
            /// same request can be made again after a reconnect.
            /// </summary>
            public readonly string FetchId;

            /// <summary>
            /// A SyncBehaviour's model listener only: told each time the request for
            /// <see cref="FetchId"/> is made again after a reconnect, with the round of answers
            /// it is part of. See <see cref="RequestModelsAgain(double)"/>.
            /// </summary>
            public readonly Action<ReconnectRound> RequestedAgain;

            private readonly UnityEngine.Object _owner;
            private readonly bool _isOwned;

            public Listener(Action<T> callback, string fetchId = null, Action<ReconnectRound> requestedAgain = null)
            {
                Callback = callback;
                FetchId = fetchId;
                RequestedAgain = requestedAgain;
                _owner = ListenerOwner.Of(callback);
                // Resolved once, here: after the owner is destroyed, `_owner == null` can no
                // longer tell "belongs to a destroyed object" from "belongs to nothing at all".
                _isOwned = !ReferenceEquals(_owner, null);
            }

            /// <summary>True once the Unity object this listener belonged to has been destroyed.</summary>
            public bool IsOrphaned => _isOwned && _owner == null;
        }

        private static readonly Dictionary<string, List<Listener<bool>>> _boolListeners = new Dictionary<string, List<Listener<bool>>>();
        private static readonly Dictionary<string, List<Listener<int>>> _intListeners = new Dictionary<string, List<Listener<int>>>();
        private static readonly Dictionary<string, List<Listener<float>>> _floatListeners = new Dictionary<string, List<Listener<float>>>();
        private static readonly Dictionary<string, List<Listener<string>>> _stringListeners = new Dictionary<string, List<Listener<string>>>();
        private static readonly Dictionary<string, List<Listener<Vector2>>> _vector2Listeners = new Dictionary<string, List<Listener<Vector2>>>();
        private static readonly Dictionary<string, List<Listener<Vector3>>> _vector3Listeners = new Dictionary<string, List<Listener<Vector3>>>();
        private static readonly Dictionary<string, List<Listener<Quaternion>>> _quaternionListeners = new Dictionary<string, List<Listener<Quaternion>>>();
        private static readonly Dictionary<string, List<Listener<Color>>> _colorListeners = new Dictionary<string, List<Listener<Color>>>();
        private static readonly Dictionary<string, List<Listener<bool[]>>> _boolArrayListeners = new Dictionary<string, List<Listener<bool[]>>>();
        private static readonly Dictionary<string, List<Listener<int[]>>> _intArrayListeners = new Dictionary<string, List<Listener<int[]>>>();
        private static readonly Dictionary<string, List<Listener<float[]>>> _floatArrayListeners = new Dictionary<string, List<Listener<float[]>>>();
        private static readonly Dictionary<string, List<Listener<string[]>>> _stringArrayListeners = new Dictionary<string, List<Listener<string[]>>>();
        private static readonly Dictionary<string, List<Listener<Vector2[]>>> _vector2ArrayListeners = new Dictionary<string, List<Listener<Vector2[]>>>();
        private static readonly Dictionary<string, List<Listener<Vector3[]>>> _vector3ArrayListeners = new Dictionary<string, List<Listener<Vector3[]>>>();
        private static readonly Dictionary<string, List<Listener<Quaternion[]>>> _quaternionArrayListeners = new Dictionary<string, List<Listener<Quaternion[]>>>();
        private static readonly Dictionary<string, List<Listener<Color[]>>> _colorArrayListeners = new Dictionary<string, List<Listener<Color[]>>>();
        private static readonly Dictionary<string, List<Listener<JToken>>> _jsonListeners = new Dictionary<string, List<Listener<JToken>>>();

        private static readonly Dictionary<string, List<Listener<JObject>>> _modelUpdateListeners = new Dictionary<string, List<Listener<JObject>>>();
        private static readonly Dictionary<string, List<Listener<JObject>>> _modelDeleteListeners = new Dictionary<string, List<Listener<JObject>>>();

        /// <summary>
        /// The live connection, creating it on first use. Null only while the application is
        /// shutting down, when there is nothing left to send to.
        /// </summary>
        private static WebServerConnection Connection()
        {
            // Unity's ==, so the previous Play session's destroyed connection is replaced rather
            // than reused - see SingletonBehaviour.
            if (_connection == null)
            {
                _connection = WebServerConnection.Instance;
                if (_connection == null)
                    return null;

                _connection.OnMessageReceived += OnServerMessage;
                _connection.OnConnected += OnConnected;
                _connection.OnDisconnected += OnDisconnected;

                // The answers of a round still open were asked for on the connection replaced
                // here, and never come on this one; nor does the end of the deletes in question,
                // which went with its queue.
                if (_reconnectRound != null)
                {
                    _reconnectRound.IsOver = true;
                    _reconnectRound = null;
                }
                EndAnswerRounds();
                ForgetUnreadDeletes();

                // Nor has this one heard from the server yet, and it makes no requests again at
                // its first connection.
                _heardStamps = 0;
                _heardAt = double.NegativeInfinity;
                _heardAtHeld = false;

                // Without a server from here on, unless something else made the connection and
                // connected it before: the [RemoteLogger], say, whose OnConnected came before this
                // class listened.
                _withoutServerSince = _connection.Status == ConnectionStatus.Connected
                    ? double.PositiveInfinity
                    : Time.unscaledTimeAsDouble;
            }
            return _connection;
        }

        /// <summary>
        /// Since when this client has been without a server, on SyncTicker's clock: since it took up
        /// its connection, or noticed that the connection was gone. Positive infinity while
        /// connected. NaN at the start of a session: without a connection taken up then, it counts
        /// from when <see cref="StopsWaitingForServer"/> is first asked.
        /// </summary>
        private static double _withoutServerSince = double.NaN;

        private static bool _hasWarnedAboutNoServer;

        /// <summary>
        /// For a placed body that waits for the server's state before it is simulated (see
        /// GenericSyncTransform): whether it stops waiting at <paramref name="now"/>, on
        /// SyncTicker's clock. It does once this client has been without a server for the connect
        /// timeout, and is not in the middle of a connect attempt. The first body that stops
        /// waiting in a session says so in the console.
        /// </summary>
        internal static bool StopsWaitingForServer(double now)
        {
            if (double.IsNaN(_withoutServerSince))
                _withoutServerSince = now;

            var timeout = WebServerConnection.CONNECT_TIMEOUT_MS / 1000.0;
            if (now - _withoutServerSince < timeout)
                return false;

            // Nor while the connection is up or trying. It comes up on a worker thread, and
            // OnConnected follows only in the next Update, after this frame's FixedUpdates. An
            // attempt gives up after the connect timeout itself, and may have started later than
            // the time counted from, the start of the frame in which Awake took up the connection:
            // seconds later in a frame that loads a scene.
            var connection = _connection;
            if (!ReferenceEquals(connection, null))
            {
                var status = connection.Status;
                if (status == ConnectionStatus.Connected || status == ConnectionStatus.Connecting
                    || status == ConnectionStatus.Reconnecting)
                    return false;
            }

            if (!_hasWarnedAboutNoServer)
            {
                _hasWarnedAboutNoServer = true;
                Debug.LogWarning($"Colibri: no connection to a server for {timeout.ToString("0.#", CultureInfo.InvariantCulture)} s, "
                    + "so placed SyncTransforms with a Rigidbody and PhysicsAuthority ticked are simulated without the server's state; "
                    + "once a server answers, the positions they reached replace the shared ones. Start colibri-server, or check the "
                    + "server address in the Colibri configuration. Said once per session.");
            }
            return true;
        }

        /// <summary>
        /// When this client last noticed that its connection was gone, on SyncTicker's clock
        /// (<c>Time.unscaledTimeAsDouble</c>); negative infinity before it ever has.
        /// </summary>
        private static double _disconnectedAt = double.NegativeInfinity;

        /// <summary>
        /// Notes when the outage was noticed, and sends again the deletes that may have gone into
        /// the dead link.
        /// </summary>
        /// <remarks>
        /// <para>
        /// A synced object destroyed in the moment the Wi-Fi drops writes its model::delete into a
        /// link that is already dead, and nothing sent it again: the reconnect asks only for the
        /// objects this client still has. The server and every other client kept the object, and
        /// the answers after the reconnect offered it to this client's managers again, which
        /// LocallyDeletedModels holds off for a minute only.
        /// </para>
        /// <para>
        /// So a delete made after this client last heard from the server, or in the second before,
        /// when it may still have been on its way, goes out again. It waits for the next
        /// connection and goes ahead of the requests made again there, as a delete made during the
        /// outage does. One that did arrive is deleted again, which changes nothing unless another
        /// client has created the object anew meanwhile, with the same id: then that one goes, as
        /// it would for a delete made during the outage.
        /// </para>
        /// <para>
        /// The server has read those deletes once the answers to the reconnect's requests are in
        /// (see <see cref="ReconnectRound"/>), and the ones made during the outage, or while the
        /// answers come in, are no different. If the link drops again before, they may have gone
        /// into that link as well, and all of them go out again, however old: like a delete made
        /// during the outage, which goes out however old, the server may never have had them. A
        /// minute is all LocallyDeletedModels remembers, and an outage at the edge of Wi-Fi range
        /// can last longer.
        /// </para>
        /// </remarks>
        private static void OnDisconnected() => OnDisconnected(Time.unscaledTimeAsDouble);

        /// <summary><see cref="OnDisconnected()"/>, with the outage noticed at <paramref name="now"/>.</summary>
        /// <remarks>Internal for the EditMode tests, which set the time of the outage with it.</remarks>
        internal static void OnDisconnected(double now)
        {
            _disconnectedAt = now;
            _withoutServerSince = now;

            var madeAtTheDrop = LocallyDeletedModels.Since(LastHeardAt(now) - 1, now);

            // Until the requests go out again: see _heardAtHeld.
            _heardAtHeld = true;

            // From here until the answers are in, every delete sent is one the server may not have
            // read.
            _unreadDeletes ??= new List<(string Channel, string Id)>();
            if (madeAtTheDrop != null)
            {
                foreach (var (channel, id) in madeAtTheDrop)
                    NoteUnreadDelete(channel, id);
            }

            foreach (var (channel, id) in _unreadDeletes)
                SendCommand(channel, "model::delete", new JObject { { "id", id } });
        }

        /// <summary>
        /// The deletes the server may not have read, oldest first: from when this client notices an
        /// outage, those it sends again then and every one it sends afterwards, until the answers to
        /// the requests made again after the reconnect are in (see <see cref="ReconnectRound"/>).
        /// Null while none is in question.
        /// </summary>
        private static List<(string Channel, string Id)> _unreadDeletes;
        private static readonly HashSet<(string Channel, string Id)> _unreadDeleteKeys = new HashSet<(string Channel, string Id)>();

        private static void NoteUnreadDelete(string channel, string id)
        {
            if (_unreadDeletes != null && _unreadDeleteKeys.Add((channel, id)))
                _unreadDeletes.Add((channel, id));
        }

        /// <summary>
        /// For a model asked for afresh: the id is in use again on the server, and a delete of it
        /// sent once more would remove the object this client has now, there and on every other
        /// client.
        /// </summary>
        private static void ForgetUnreadDelete(string channel, string id)
        {
            if (_unreadDeletes != null && _unreadDeleteKeys.Remove((channel, id)))
                _unreadDeletes.Remove((channel, id));
        }

        private static void ForgetUnreadDeletes()
        {
            _unreadDeletes = null;
            _unreadDeleteKeys.Clear();
        }

        /// <summary>
        /// When this client last heard from the server, on SyncTicker's clock, how many times the
        /// connection had heard from it then, and when this was last asked (see
        /// <see cref="LastHeardAt"/>).
        /// </summary>
        private static double _heardAt = double.NegativeInfinity;
        private static long _heardStamps;
        private static double _heardAskedAt = double.NegativeInfinity;

        /// <summary>
        /// Whether <see cref="LastHeardAt"/> keeps the time the connection that died last heard
        /// from the server: from when this client notices the outage until it makes the requests
        /// again after the reconnect.
        /// </summary>
        /// <remarks>
        /// The next connection hears from the server as soon as it is accepted, a frame or so
        /// before the requests go out. The values a member sent into the dead link are kept for
        /// the answers to those requests (see SentValues), and a value sent in that frame, counted
        /// as sent after the server was last heard from again, pushed them out: the answer holding
        /// one was taken for another client's change if the link dropped again before it came.
        /// </remarks>
        private static bool _heardAtHeld;

        /// <summary>
        /// When this client last heard from the server, on SyncTicker's clock, as of
        /// <paramref name="now"/>: any bytes count, and the server heartbeats every 100 ms, so
        /// while the connection works that was a moment ago. What is sent after it may be going
        /// into a link that has died (see SentValues). <paramref name="now"/> without a connection;
        /// negative infinity before this connection has heard from the server at all. Held from
        /// an outage until the requests go out again (see <see cref="_heardAtHeld"/>).
        /// </summary>
        /// <remarks>
        /// SyncTicker asks once a frame. When the connection has heard from the server since the
        /// last time, its time since the last heartbeat is taken off <paramref name="now"/>, but no
        /// further back than that last time. The connection times the heartbeats on the system
        /// clock, which Unity's clock need not keep pace with: the system clock is set now and then,
        /// and may run on while a headset sleeps. Taken off in full, its time could put the
        /// last-heard time minutes back, and the deletes made in those minutes went out again. Nor
        /// does <paramref name="now"/> alone do: after a frame that took seconds, such as a scene
        /// loaded synchronously, it lay seconds after the last heartbeat, and a delete made just
        /// before that frame, which the link may have died with, did not go out again.
        /// </remarks>
        internal static double LastHeardAt(double now)
        {
            var connection = _connection;
            if (connection == null)
                return now;

            var stamps = connection.LivenessStamps;
            if (stamps != _heardStamps && !_heardAtHeld)
            {
                _heardStamps = stamps;
                var heardAt = now - connection.MillisSinceLastHeartbeat() / 1000.0;
                _heardAt = Math.Min(now, Math.Max(_heardAskedAt, heardAt));
            }
            _heardAskedAt = now;
            return _heardAt;
        }

        /// <summary>
        /// The requests made again after one reconnect, from when they go out until the answers
        /// to all of them have arrived: the stretch in which a SyncBehaviour compares what it
        /// receives with what it sent before the outage (see SyncBehaviour's OnModelUpdate), and
        /// in which the deletes sent again ahead of the requests may not have reached the server.
        /// </summary>
        /// <remarks>
        /// <para>
        /// On the wire an answer is an ordinary model::update, and so is an update that another
        /// client sends meanwhile. The server relays those to this client as soon as it accepts the
        /// connection, so they arrive before the answers, between them and after them, and nothing
        /// in them tells them apart. Nor can the answers be counted off: an update from another
        /// client would take the place of one, and the answer it stood in for would then be applied
        /// as if it were news, putting back a value from before the outage.
        /// </para>
        /// <para>
        /// A SyncBehaviour that keeps changes of its own at its first answer opens a round of its
        /// own, for the answers still on their way then (see <see cref="AskForEndOfAnswers"/>).
        /// </para>
        /// <para>
        /// What can be told is when the answers are over. The server handles one client's messages
        /// in the order they were sent and writes its answers to that client in the same order, so
        /// the answer to a request sent after all the others comes after all of theirs. That last
        /// request asks for an id that no model has, on a channel that holds no models
        /// (<see cref="ReconnectRoundChannel"/>), and the bare <c>{ id }</c> it is answered with can
        /// be nothing else. The server needs nothing new for this: it answers any model::request.
        /// </para>
        /// <para>
        /// Whatever arrives before that answer was sent by the server before it read the request,
        /// and so before it read anything this client sends in reply to an answer. Updates from
        /// other clients in that stretch hold the server's values at the time just as the answers
        /// do, and are judged with them. Once it has arrived, the server has read everything this
        /// client queued ahead of the request, the deletes sent again included.
        /// </para>
        /// </remarks>
        internal sealed class ReconnectRound
        {
            /// <summary>
            /// When this client noticed the outage, on SyncTicker's clock: the one before this
            /// reconnect, or an earlier one if the link dropped again before that one's round was
            /// over. Negative infinity for a round an object opened at its first answer, which
            /// follows no outage: everything the object sends counts.
            /// </summary>
            internal readonly double DisconnectedAt;

            /// <summary>The id the last request asks for, whose answer ends the round.</summary>
            internal readonly string EndMarkerId = Guid.NewGuid().ToString();

            /// <summary>Whether the answers are all in.</summary>
            internal bool IsOver;

            internal ReconnectRound(double disconnectedAt) => DisconnectedAt = disconnectedAt;
        }

        /// <summary>
        /// The channel the request that ends a <see cref="ReconnectRound"/> goes out on. No model
        /// is ever put on it, and nothing received on it reaches a listener.
        /// </summary>
        internal const string ReconnectRoundChannel = "colibri::reconnect";

        /// <summary>The round whose answers are still coming in, if any.</summary>
        private static ReconnectRound _reconnectRound;

        /// <summary>The id whose answer ends the current round; null when none is open. For the EditMode tests.</summary>
        internal static string ReconnectRoundEndMarker => _reconnectRound?.EndMarkerId;

        /// <summary>
        /// The rounds objects opened at their first answer (see <see cref="AskForEndOfAnswers"/>),
        /// by the id their last request asks for, until its answer arrives.
        /// </summary>
        private static readonly Dictionary<string, ReconnectRound> _answerRounds = new Dictionary<string, ReconnectRound>();

        /// <summary>
        /// For a SyncBehaviour that keeps changes of its own at its first answer, and sends them in
        /// place of the server's values (see its "Changes made before the first answer"): one more
        /// request, sent now, ahead of those changes, and the round its answer ends. The answer to
        /// every request this client sent before comes ahead of it, a manager's request for its
        /// whole channel included, and so does every update the server relayed before it read the
        /// request. Each of those holds what the server had before it read the changes.
        /// </summary>
        internal static ReconnectRound AskForEndOfAnswers()
        {
            var round = new ReconnectRound(double.NegativeInfinity);

            // Noted once sent: a connection put in place of a destroyed one on the way ends the
            // rounds asked for on that one.
            SendCommand(ReconnectRoundChannel, "model::request", new JObject { { "id", round.EndMarkerId }, { "again", true } });
            _answerRounds[round.EndMarkerId] = round;
            return round;
        }

        /// <summary>
        /// Ends every round objects opened at their first answer. The answers that end them were
        /// asked for on a connection that is gone, and after a reconnect the requests made again
        /// open the round those objects are in.
        /// </summary>
        private static void EndAnswerRounds()
        {
            foreach (var round in _answerRounds.Values)
                round.IsOver = true;
            _answerRounds.Clear();
        }

        /// <summary>
        /// After a reconnect, every model this client holds may be stale: whatever other clients
        /// changed - or created - while it was offline never reached it, and nothing used to ask
        /// again. <c>model::request</c> was sent once, when a listener registered, so a Wi-Fi blip
        /// left the client showing old state until each object happened to change once more.
        ///
        /// So on every reconnect the same requests go out again, from the registry here rather than
        /// from each SyncBehaviour. They queue behind anything sent during the outage, so the server
        /// answers with this client's own offline changes already applied. Not on the first
        /// connection: that is what the requests made at registration were queued for.
        /// </summary>
        /// <remarks>Internal for the EditMode tests, which stand in for the connection coming up with it.</remarks>
        internal static void OnConnected()
        {
            // A body that waits for the server's state waits for its answer now: see StopsWaitingForServer.
            _withoutServerSince = double.PositiveInfinity;

            var connection = _connection;
            if (connection == null || connection.ConnectedSessions < 2)
                return;

            RequestModelsAgain();
        }

        /// <summary>
        /// Asks again for every model a listener asked for. A request for one object says
        /// <c>again: true</c>: this client held the object before the outage, and it is not putting
        /// it into the scene now. The server answers it with <c>model::delete</c> if another client
        /// deleted the object meanwhile, and keeps the object deleted. A request without it - what a
        /// listener sends when it registers - says the object is in this client's scene now, or being
        /// created, and makes the server forget such a delete: the id is in use again.
        /// </summary>
        /// <remarks>Internal for the EditMode tests, which stand in for a reconnect with it.</remarks>
        internal static void RequestModelsAgain() => RequestModelsAgain(_disconnectedAt);

        /// <summary>
        /// <see cref="RequestModelsAgain()"/>. One more request follows them all, whose answer marks
        /// the end of theirs, and each SyncBehaviour whose object was among the models asked for is
        /// told about the round of answers it is part of (see <see cref="ReconnectRound"/>),
        /// including when the connection was lost (<paramref name="disconnectedAt"/>, on
        /// SyncTicker's clock).
        /// </summary>
        /// <remarks>Internal for the EditMode tests, which set the time of the outage with it.</remarks>
        internal static void RequestModelsAgain(double disconnectedAt)
        {
            List<Action<ReconnectRound>> toTell = null;

            foreach (var entry in _modelUpdateListeners.ToArray())
            {
                var channel = entry.Key;
                var channelListeners = entry.Value;

                Prune(channel, channelListeners, track: false);
                if (channelListeners.Count == 0)
                {
                    _modelUpdateListeners.Remove(channel);
                    continue;
                }

                // A listener that asked for every model on the channel (a SyncBehaviourManager)
                // asks again; one that asked for its own object (a SyncBehaviour) does too - the
                // server answers an id it does not know with a bare { id }, and only a request for
                // that id gets that answer.
                var requestedAll = false;
                var requestedIds = new HashSet<string>();
                foreach (var listener in channelListeners)
                {
                    if (listener.FetchId == null)
                    {
                        if (!requestedAll)
                            SendCommand(channel, "model::request", null);
                        requestedAll = true;
                    }
                    else if (requestedIds.Add(listener.FetchId))
                    {
                        SendCommand(channel, "model::request", new JObject { { "id", listener.FetchId }, { "again", true } });
                    }
                }

                foreach (var listener in channelListeners)
                {
                    if (listener.FetchId != null && listener.RequestedAgain != null)
                        (toTell ??= new List<Action<ReconnectRound>>()).Add(listener.RequestedAgain);
                }
            }

            // A round still open lost its answers to this outage: the link dropped again soon after
            // the last reconnect. A change lost at the drop before that is still in question, so
            // the new round counts from that earlier outage. Counted from this one, the lost change
            // could lie before the window, and the answer, which still holds the value from before
            // it, would be applied after all. OnDisconnected has sent that one's deletes again too.
            if (_reconnectRound != null)
            {
                disconnectedAt = Math.Min(disconnectedAt, _reconnectRound.DisconnectedAt);
                _reconnectRound.IsOver = true;
            }

            // So did a round an object opened at its first answer. The object is in this one now,
            // and what it sent in place of the server's values is judged as any other value sent.
            EndAnswerRounds();

            // After every other request, on every channel: its answer comes after all of theirs.
            // Sent even when no object was asked for again: its answer also says that the server
            // has read the deletes sent again ahead of the requests. And only an answered round
            // ends: one left open would carry its outage over to a round much later, which would
            // judge as lost what other clients changed in between.
            var round = new ReconnectRound(disconnectedAt);
            _reconnectRound = round;
            SendCommand(ReconnectRoundChannel, "model::request", new JObject { { "id", round.EndMarkerId }, { "again", true } });

            // What is sent from here on goes out after the requests, and their answers cannot hold
            // it: hearing from the server on this connection counts again.
            _heardAtHeld = false;

            if (toTell == null)
                return;

            foreach (var tell in toTell)
                tell(round);
        }

        /// <summary>
        /// The answer to the request that ends a <see cref="ReconnectRound"/>. One with an earlier
        /// round's id answers a request that a failed write kept for this connection; that round is
        /// over already.
        /// </summary>
        private static void EndReconnectRound(JToken data)
        {
            if (!(data is JObject answer) || !answer.TryGetValue("id", out var id) || id.Type != JTokenType.String)
                return;

            var marker = (string)id;
            if (_answerRounds.TryGetValue(marker, out var answerRound))
            {
                _answerRounds.Remove(marker);
                answerRound.IsOver = true;
                return;
            }

            var round = _reconnectRound;
            if (round == null || marker != round.EndMarkerId)
                return;

            round.IsOver = true;
            _reconnectRound = null;

            // The server has read them, with everything queued ahead of the request. One sent
            // after it may still be on its way, but from here on, like any other, it goes out
            // again only if made around when the server was last heard from (see OnDisconnected).
            ForgetUnreadDeletes();
        }

        /*
         *  Every message that arrives goes through here, so nothing in it may throw: an exception
         *  leaving this method skips every other handler of the message, and every message still
         *  queued behind it that frame. A payload that cannot be read as the type its command
         *  names is reported and dropped; a listener that throws is reported and the rest are
         *  still called.
         *
         *  The conversions below keep exactly the leniency they always had (JToken.Value<T>() and
         *  the explicit casts accept "5" for an int, 1 for a bool, ...). Only what used to throw
         *  is new: that is now one warning instead of an exception.
         */

        /// <remarks>Internal so the EditMode tests can deliver a message without a socket.</remarks>
        internal static void OnServerMessage(string channel, string command, JToken data)
        {
            RecordTraffic(true, channel, command);

            // Colibri's own, and nothing a listener asked for: see ReconnectRound.
            if (channel == ReconnectRoundChannel)
            {
                EndReconnectRound(data);
                return;
            }

            switch (command)
            {
                case "broadcast::bool":
                    Deliver(channel, command, data, _boolListeners, token => token.Value<bool>());
                    break;
                case "broadcast::int":
                    Deliver(channel, command, data, _intListeners, token => token.Value<int>());
                    break;
                case "broadcast::float":
                    Deliver(channel, command, data, _floatListeners, token => token.Value<float>());
                    break;
                case "broadcast::string":
                    Deliver(channel, command, data, _stringListeners, token => token.Value<string>());
                    break;
                case "broadcast::vector2":
                    Deliver(channel, command, data, _vector2Listeners, token => token.ToVector2());
                    break;
                case "broadcast::vector3":
                    Deliver(channel, command, data, _vector3Listeners, token => token.ToVector3());
                    break;
                case "broadcast::quaternion":
                    Deliver(channel, command, data, _quaternionListeners, token => token.ToQuaternion());
                    break;
                case "broadcast::color":
                    Deliver(channel, command, data, _colorListeners, token => token.ToColor());
                    break;

                case "broadcast::bool[]":
                    Deliver(channel, command, data, _boolArrayListeners, token => ToArray(token, x => (bool)x));
                    break;
                case "broadcast::int[]":
                    Deliver(channel, command, data, _intArrayListeners, token => ToArray(token, x => (int)x));
                    break;
                case "broadcast::float[]":
                    Deliver(channel, command, data, _floatArrayListeners, token => ToArray(token, x => (float)x));
                    break;
                case "broadcast::string[]":
                    Deliver(channel, command, data, _stringArrayListeners, token => ToArray(token, x => (string)x));
                    break;
                case "broadcast::vector2[]":
                    Deliver(channel, command, data, _vector2ArrayListeners, token => ToArray(token, x => x.ToVector2()));
                    break;
                case "broadcast::vector3[]":
                    Deliver(channel, command, data, _vector3ArrayListeners, token => ToArray(token, x => x.ToVector3()));
                    break;
                case "broadcast::quaternion[]":
                    Deliver(channel, command, data, _quaternionArrayListeners, token => ToArray(token, x => x.ToQuaternion()));
                    break;
                case "broadcast::color[]":
                    Deliver(channel, command, data, _colorArrayListeners, token => ToArray(token, x => x.ToColor()));
                    break;

                case "broadcast::json":
                    Invoke(channel, command, _jsonListeners, data);
                    break;

                case "model::update":
                    // Not routed through Invoke<T>: these are Colibri's own plumbing, so a model
                    // message arriving with nothing listening is not a type mismatch worth
                    // reporting - it is just a model this client does not have.
                    if (data is JObject updated)
                        Dispatch(channel, command, _modelUpdateListeners, updated, track: false);
                    break;

                case "model::delete":
                    if (data is JObject deleted)
                        Dispatch(channel, command, _modelDeleteListeners, deleted, track: false);
                    break;
            }
        }

        /// <summary>
        /// Converts and delivers one message. The payload is only read when something on the
        /// channel listens for this type: every client sees every channel its app uses, so a
        /// malformed value on a channel this one ignores is not worth a warning here - nor worth
        /// the conversion.
        /// </summary>
        private static void Deliver<T>(string channel, string command, JToken data,
            Dictionary<string, List<Listener<T>>> listeners, Func<JToken, T> convert)
        {
            if (!listeners.ContainsKey(channel))
            {
                ReportMismatch<T>(channel);
                return;
            }

            T value;
            try
            {
                // ParsePayload never hands over a C# null, but a caller other than the socket
                // might; it means the same as a JSON null.
                value = convert(data ?? JValue.CreateNull());
            }
            catch (Exception e)
            {
                Debug.LogWarning($"Colibri: received a {command} on channel '{channel}' that cannot be read as "
                    + $"{ChannelListenerRegistry.FriendlyName(typeof(T))}: '{Abbreviate(data)}' ({e.GetType().Name}: {e.Message}). Ignoring it.");
                return;
            }

            Invoke(channel, command, listeners, value);
        }

        /// <summary>
        /// Arrays are read element by element, and only out of a JSON array. Enumerating any other
        /// token "works" - a number or null yields no elements at all - which used to hand the
        /// listener an empty array for a payload that was nothing of the kind.
        /// </summary>
        private static TElement[] ToArray<TElement>(JToken token, Func<JToken, TElement> readElement)
        {
            if (!(token is JArray array))
                throw new InvalidCastException($"expected a JSON array, got {token.Type}");

            var values = new TElement[array.Count];
            for (var i = 0; i < array.Count; i++)
                values[i] = readElement(array[i]);
            return values;
        }

        private static string Abbreviate(JToken data)
        {
            const int maxLength = 100;

            var text = data == null ? "null" : data.ToString(Newtonsoft.Json.Formatting.None);
            return text.Length <= maxLength ? text : text.Substring(0, maxLength) + "...";
        }

        private static void Invoke<T>(string channel, string command, Dictionary<string, List<Listener<T>>> listeners, T val)
        {
            if (val == null)
                return;

            if (Dispatch(channel, command, listeners, val, track: true))
                return;

            ReportMismatch<T>(channel);
        }

        private static void ReportMismatch<T>(string channel)
        {
            // Nothing is listening for this type on this channel. That is only worth reporting
            // when *something else* is - a channel with no listeners at all is normal, since
            // every client sees every channel its app uses.
            if (ChannelListenerRegistry.TryDescribeMismatch(channel, typeof(T), out var message))
                Debug.LogWarning(message);
        }

        /// <summary>
        /// Calls everything still listening on the channel, dropping the listeners whose objects
        /// have been destroyed on the way past. Returns false when the channel had nobody left.
        /// </summary>
        private static bool Dispatch<T>(string channel, string command, Dictionary<string, List<Listener<T>>> listeners, T val, bool track)
        {
            if (!listeners.TryGetValue(channel, out var channelListeners))
                return false;

            Prune(channel, channelListeners, track);
            if (channelListeners.Count == 0)
            {
                // Left in place, an empty list would keep answering the lookup above, and every
                // future message on this channel would be dropped without a word.
                listeners.Remove(channel);
                return false;
            }

            // Copied, because a listener is allowed to register or unregister while being called.
            foreach (var listener in channelListeners.ToArray())
            {
                try
                {
                    listener.Callback.Invoke(val);
                }
                catch (Exception e)
                {
                    // One listener's bug is that listener's problem: the others on the channel
                    // still get the message, and so does everything queued behind it.
                    Debug.LogError($"Colibri: a listener for {command} on channel '{channel}' threw an exception. "
                        + $"The other listeners still received the message.\n{e}");
                }
            }

            return true;
        }

        /// <summary>Removes the listeners whose owning object is gone. See <see cref="ListenerOwner"/>.</summary>
        private static void Prune<T>(string channel, List<Listener<T>> channelListeners, bool track)
        {
            for (var i = channelListeners.Count - 1; i >= 0; i--)
            {
                if (!channelListeners[i].IsOrphaned)
                    continue;

                channelListeners.RemoveAt(i);
                if (track)
                    ChannelListenerRegistry.Remove(channel, typeof(T));
            }
        }


        /*
         *  Traffic log, for the Colibri Status window. Compiled out of release builds entirely,
         *  so neither the buffer nor the calls that fill it cost a shipped build anything.
         */

        public struct TrafficEntry
        {
            public bool Incoming;
            public string Channel;
            public string Command;
            public float Time;
        }

#if UNITY_EDITOR || DEVELOPMENT_BUILD
        private const int TrafficLogSize = 20;

        private const float DefaultTrafficRetentionSeconds = 10f;

        /// <summary>
        /// How long an entry stays in the log. It is a "what is happening right now" list, so an
        /// idle channel should empty out rather than leave the last twenty messages on screen
        /// with ages counting up indefinitely.
        /// </summary>
        /// <remarks>
        /// Settable only so the test suite can shorten it - a test that has to sit out the real
        /// ten seconds to watch an entry expire is one nobody will keep running.
        /// </remarks>
        internal static float TrafficRetentionSeconds = DefaultTrafficRetentionSeconds;

        private static readonly TrafficEntry[] _traffic = new TrafficEntry[TrafficLogSize];
        private static int _trafficCount;

        /// <summary>
        /// Entries survive Play mode with domain reload disabled, and their timestamps are
        /// <c>realtimeSinceStartup</c> - which keeps running in edit mode. Without this the next
        /// session opened showing the last one's messages, dated from before it started.
        /// </summary>
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        private static void ResetTraffic()
        {
            Array.Clear(_traffic, 0, _traffic.Length);
            _trafficCount = 0;
            TrafficRetentionSeconds = DefaultTrafficRetentionSeconds;
        }

        /// <summary>
        /// The most recent messages sent and received, newest first, dropping anything older
        /// than <see cref="TrafficRetentionSeconds"/>.
        /// </summary>
        public static IEnumerable<TrafficEntry> RecentTraffic
        {
            get
            {
                var oldest = Time.realtimeSinceStartup - TrafficRetentionSeconds;
                var count = Math.Min(_trafficCount, TrafficLogSize);

                for (var i = 1; i <= count; i++)
                {
                    var entry = _traffic[(_trafficCount - i) % TrafficLogSize];

                    // Newest first, so the first entry past the window means every entry after it
                    // is older still.
                    if (entry.Time < oldest)
                        yield break;

                    yield return entry;
                }
            }
        }
#else
        public static IEnumerable<TrafficEntry> RecentTraffic => Enumerable.Empty<TrafficEntry>();
#endif

        [System.Diagnostics.Conditional("UNITY_EDITOR"), System.Diagnostics.Conditional("DEVELOPMENT_BUILD")]
        private static void RecordTraffic(bool incoming, string channel, string command)
        {
#if UNITY_EDITOR || DEVELOPMENT_BUILD
            _traffic[_trafficCount % TrafficLogSize] = new TrafficEntry
            {
                Incoming = incoming,
                Channel = channel,
                Command = command,
                Time = Time.realtimeSinceStartup
            };
            _trafficCount++;
#endif
        }

        private static void SendCommand(string channel, string command, JToken data)
        {
            var connection = Connection();
            if (connection == null)
                return;

            RecordTraffic(false, channel, command);
            connection.SendCommand(channel, command, data);
        }


        /*
         *  Sending data
         */
        public static void Send(string channel, bool data) => SendCommand(channel, "broadcast::bool", data.ToJson());
        public static void Send(string channel, int data) => SendCommand(channel, "broadcast::int", data.ToJson());
        public static void Send(string channel, float data) => SendCommand(channel, "broadcast::float", data.ToJson());
        public static void Send(string channel, string data) => SendCommand(channel, "broadcast::string", data.ToJson());
        public static void Send(string channel, Vector2 data) => SendCommand(channel, "broadcast::vector2", data.ToJson());
        public static void Send(string channel, Vector3 data) => SendCommand(channel, "broadcast::vector3", data.ToJson());
        public static void Send(string channel, Quaternion data) => SendCommand(channel, "broadcast::quaternion", data.ToJson());
        public static void Send(string channel, Color data) => SendCommand(channel, "broadcast::color", data.ToJson());
        public static void Send(string channel, bool[] data) => SendCommand(channel, "broadcast::bool[]", new JArray(data));
        public static void Send(string channel, int[] data) => SendCommand(channel, "broadcast::int[]", new JArray(data));
        public static void Send(string channel, float[] data) => SendCommand(channel, "broadcast::float[]", new JArray(data));
        public static void Send(string channel, string[] data) => SendCommand(channel, "broadcast::string[]", new JArray(data));
        public static void Send(string channel, Vector2[] data) => SendCommand(channel, "broadcast::vector2[]", new JArray(data.Select(x => x.ToJson())));
        public static void Send(string channel, Vector3[] data) => SendCommand(channel, "broadcast::vector3[]", new JArray(data.Select(x => x.ToJson())));
        public static void Send(string channel, Quaternion[] data) => SendCommand(channel, "broadcast::quaternion[]", new JArray(data.Select(x => x.ToJson())));
        public static void Send(string channel, Color[] data) => SendCommand(channel, "broadcast::color[]", new JArray(data.Select(x => x.ToJson())));
        public static void Send(string channel, JToken data) => SendCommand(channel, "broadcast::json", data);

        public static void SendModelUpdate(string channel, JObject data) => SendCommand(channel, "model::update", data);
        public static void SendModelDelete(string channel, string id)
        {
            NoteUnreadDelete(channel, id);
            SendCommand(channel, "model::delete", new JObject { { "id", id } });
        }




        /*
         *  Listeners
         */

        /// <summary>
        /// A Play session starts without the previous one's listeners. With domain reload disabled
        /// these dictionaries survive from one session to the next, and so did every listener in
        /// them that belongs to no Unity object - a static method, a lambda that captures nothing.
        /// One the new session never registers kept being called, and the types of the old
        /// session's listeners kept counting for the type-mismatch warning. Listeners owned by an
        /// object went with it (see <see cref="ListenerOwner"/>), but only once the next message on
        /// their channel swept them out.
        /// </summary>
        /// <remarks>
        /// What this clears was registered in an earlier Play session or in edit mode; entering Play
        /// mode with domain reload enabled, the default, starts without those too. Only another
        /// SubsystemRegistration callback could register before this runs - they come before any
        /// other RuntimeInitializeOnLoadMethod, any scene load and any Awake - and none in Colibri
        /// does. In a player it runs once, at startup, on empty dictionaries. Internal for the
        /// EditMode tests, which stand in for the start of a session with it.
        /// </remarks>
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        internal static void ResetListeners()
        {
            _boolListeners.Clear();
            _intListeners.Clear();
            _floatListeners.Clear();
            _stringListeners.Clear();
            _vector2Listeners.Clear();
            _vector3Listeners.Clear();
            _quaternionListeners.Clear();
            _colorListeners.Clear();
            _boolArrayListeners.Clear();
            _intArrayListeners.Clear();
            _floatArrayListeners.Clear();
            _stringArrayListeners.Clear();
            _vector2ArrayListeners.Clear();
            _vector3ArrayListeners.Clear();
            _quaternionArrayListeners.Clear();
            _colorArrayListeners.Clear();
            _jsonListeners.Clear();
            _modelUpdateListeners.Clear();
            _modelDeleteListeners.Clear();

            // The per-channel counts behind the type-mismatch warning, which describe the same
            // listeners.
            ChannelListenerRegistry.Clear();

            // The previous session's outage and the deletes it sent again, on a clock that has gone
            // on running since, its rounds of answers, which no object of this session is part of,
            // and when its connection last heard from the server, as last asked and held.
            _disconnectedAt = double.NegativeInfinity;
            ForgetUnreadDeletes();
            _reconnectRound = null;
            EndAnswerRounds();
            _heardStamps = 0;
            _heardAt = double.NegativeInfinity;
            _heardAskedAt = double.NegativeInfinity;
            _heardAtHeld = false;

            // When the previous session went without a server, and whether it said so.
            _withoutServerSince = double.NaN;
            _hasWarnedAboutNoServer = false;
        }

        // `track` is off for the model channels: they are Colibri's own SyncBehaviour plumbing,
        // they never go through Invoke<T>, and listing them would only bury the channels the
        // application code actually registered.
        private static void AddListener<T>(string channel, Dictionary<string, List<Listener<T>>> listeners, Action<T> listener,
            bool track = true, string fetchId = null, Action<ReconnectRound> requestedAgain = null)
        {
            // Ensures the connection is in the scene and that this class is subscribed to it - on
            // every registration, not only a channel's first. A channel's entry below can outlive
            // the connection it was subscribed to: destroying the connection's GameObject leaves
            // it in place, and so, before ResetListeners, did the end of a Play session with
            // domain reload disabled. A client that only listens then never got a connection again.
            Connection();

            if (!listeners.TryGetValue(channel, out var channelListeners))
            {
                channelListeners = new List<Listener<T>>();
                listeners.Add(channel, channelListeners);
            }
            else
            {
                // Registering is the other natural moment to sweep: reloading a scene registers
                // everything again, and without this the previous scene's listeners would pile up
                // on a channel that nothing happens to send on.
                Prune(channel, channelListeners, track);

                // Already listening. Delegates are equal when they call the same method on the
                // same object, so this is a listener that belongs to nothing that is ever destroyed
                // - a static method, or a lambda that captures nothing, which the compiler creates
                // once and hands out again - or the same object registering the same method twice.
                // Registered in Start, the first kind used to be added again on every scene
                // reload, and every message was delivered to it twice, then three times, ...
                for (var i = 0; i < channelListeners.Count; i++)
                {
                    if (channelListeners[i].Callback.Equals(listener) && channelListeners[i].FetchId == fetchId)
                        return;
                }
            }

            channelListeners.Add(new Listener<T>(listener, fetchId, requestedAgain));

            if (track)
                ChannelListenerRegistry.Add(channel, typeof(T));
        }

        private static void RemoveListener<T>(string channel, Dictionary<string, List<Listener<T>>> listeners, Action<T> listener, bool track = true)
        {
            if (!listeners.TryGetValue(channel, out var channelListeners))
                return;

            for (var i = 0; i < channelListeners.Count; i++)
            {
                if (!channelListeners[i].Callback.Equals(listener))
                    continue;

                channelListeners.RemoveAt(i);
                if (track)
                    ChannelListenerRegistry.Remove(channel, typeof(T));
                break;
            }

            Prune(channel, channelListeners, track);

            if (channelListeners.Count == 0)
                listeners.Remove(channel);
        }

        public static void Receive(string channel, Action<bool> listener) => AddListener(channel, _boolListeners, listener);
        public static void Unregister(string channel, Action<bool> listener) => RemoveListener(channel, _boolListeners, listener);

        public static void Receive(string channel, Action<int> listener) => AddListener(channel, _intListeners, listener);
        public static void Unregister(string channel, Action<int> listener) => RemoveListener(channel, _intListeners, listener);

        public static void Receive(string channel, Action<float> listener) => AddListener(channel, _floatListeners, listener);
        public static void Unregister(string channel, Action<float> listener) => RemoveListener(channel, _floatListeners, listener);

        public static void Receive(string channel, Action<string> listener) => AddListener(channel, _stringListeners, listener);
        public static void Unregister(string channel, Action<string> listener) => RemoveListener(channel, _stringListeners, listener);

        public static void Receive(string channel, Action<Vector2> listener) => AddListener(channel, _vector2Listeners, listener);
        public static void Unregister(string channel, Action<Vector2> listener) => RemoveListener(channel, _vector2Listeners, listener);

        public static void Receive(string channel, Action<Vector3> listener) => AddListener(channel, _vector3Listeners, listener);
        public static void Unregister(string channel, Action<Vector3> listener) => RemoveListener(channel, _vector3Listeners, listener);

        public static void Receive(string channel, Action<Quaternion> listener) => AddListener(channel, _quaternionListeners, listener);
        public static void Unregister(string channel, Action<Quaternion> listener) => RemoveListener(channel, _quaternionListeners, listener);

        public static void Receive(string channel, Action<Color> listener) => AddListener(channel, _colorListeners, listener);
        public static void Unregister(string channel, Action<Color> listener) => RemoveListener(channel, _colorListeners, listener);

        public static void Receive(string channel, Action<bool[]> listener) => AddListener(channel, _boolArrayListeners, listener);
        public static void Unregister(string channel, Action<bool[]> listener) => RemoveListener(channel, _boolArrayListeners, listener);

        public static void Receive(string channel, Action<int[]> listener) => AddListener(channel, _intArrayListeners, listener);
        public static void Unregister(string channel, Action<int[]> listener) => RemoveListener(channel, _intArrayListeners, listener);

        public static void Receive(string channel, Action<float[]> listener) => AddListener(channel, _floatArrayListeners, listener);
        public static void Unregister(string channel, Action<float[]> listener) => RemoveListener(channel, _floatArrayListeners, listener);

        public static void Receive(string channel, Action<string[]> listener) => AddListener(channel, _stringArrayListeners, listener);
        public static void Unregister(string channel, Action<string[]> listener) => RemoveListener(channel, _stringArrayListeners, listener);

        public static void Receive(string channel, Action<Vector2[]> listener) => AddListener(channel, _vector2ArrayListeners, listener);
        public static void Unregister(string channel, Action<Vector2[]> listener) => RemoveListener(channel, _vector2ArrayListeners, listener);

        public static void Receive(string channel, Action<Vector3[]> listener) => AddListener(channel, _vector3ArrayListeners, listener);
        public static void Unregister(string channel, Action<Vector3[]> listener) => RemoveListener(channel, _vector3ArrayListeners, listener);

        public static void Receive(string channel, Action<Quaternion[]> listener) => AddListener(channel, _quaternionArrayListeners, listener);
        public static void Unregister(string channel, Action<Quaternion[]> listener) => RemoveListener(channel, _quaternionArrayListeners, listener);

        public static void Receive(string channel, Action<Color[]> listener) => AddListener(channel, _colorArrayListeners, listener);
        public static void Unregister(string channel, Action<Color[]> listener) => RemoveListener(channel, _colorArrayListeners, listener);


        public static void Receive(string channel, Action<JToken> listener) => AddListener(channel, _jsonListeners, listener);
        public static void Unregister(string channel, Action<JToken> listener) => RemoveListener(channel, _jsonListeners, listener);

        public static void AddModelUpdateListener(string channel, Action<JObject> listener)
        {
            AddListener(channel, _modelUpdateListeners, listener, track: false);
            SendCommand(channel, "model::request", null);
        }

        public static void AddModelUpdateListener(string channel, Action<JObject> listener, string fetchInitialStateId)
            => AddModelUpdateListener(channel, listener, fetchInitialStateId, requestedAgain: null);

        /// <summary>
        /// The overload above, for a SyncBehaviour: <paramref name="requestedAgain"/> is told each
        /// time the model is asked for again after a reconnect (see
        /// <see cref="RequestModelsAgain(double)"/>).
        /// </summary>
        internal static void AddModelUpdateListener(string channel, Action<JObject> listener, string fetchInitialStateId,
            Action<ReconnectRound> requestedAgain)
        {
            AddListener(channel, _modelUpdateListeners, listener, track: false, fetchId: fetchInitialStateId, requestedAgain: requestedAgain);
            ForgetUnreadDelete(channel, fetchInitialStateId);
            SendCommand(channel, "model::request", new JObject { { "id", fetchInitialStateId } });
        }

        /// <summary>
        /// Listens for one model's updates like the overload above, but asks the server for nothing
        /// now. For an object a SyncBehaviourManager builds from another client's update, which
        /// carries the model's state already: the request the overload above sends says that this
        /// client has the object in its scene now, or is creating it, and the server lifts the
        /// tombstone of a model of that id deleted a moment ago. After a reconnect the model is
        /// asked for again like every other one (see <see cref="RequestModelsAgain()"/>).
        /// </summary>
        internal static void AddModelUpdateListenerWithoutRequest(string channel, Action<JObject> listener, string id,
            Action<ReconnectRound> requestedAgain)
            => AddListener(channel, _modelUpdateListeners, listener, track: false, fetchId: id, requestedAgain: requestedAgain);

        public static void RemoveModelUpdateListener(string channel, Action<JObject> listener) => RemoveListener(channel, _modelUpdateListeners, listener, track: false);

        public static void AddModelDeleteListener(string channel, Action<JObject> listener) => AddListener(channel, _modelDeleteListeners, listener, track: false);
        public static void RemoveModelDeleteListener(string channel, Action<JObject> listener) => RemoveListener(channel, _modelDeleteListeners, listener, track: false);




        /*
         *  Generic listener registration.
         *
         *  Receive is overloaded once per supported type, which makes
         *      Sync.Receive("MyChannel", MyHandler)
         *  ambiguous and forces a cast onto every call site. Naming the type instead -
         *      Sync.Receive<float>("MyChannel", MyHandler)
         *  - is unambiguous, because supplying type arguments rules the overloads out.
         *
         *  Dispatch is a pattern match on the delegate, so there is no reflection involved and
         *  the compiler still sees the same typed calls as before.
         *
         *  There is deliberately no Send<T>: Sync.Send("ch", value) already resolves without a
         *  cast, so a generic version would buy nothing and would turn today's compile error on
         *  an unsupported type into a runtime message.
         */

        private const string SupportedTypes = "bool, int, float, string, Vector2, Vector3, Quaternion, Color, JToken and arrays of those";

        public static void Receive<T>(string channel, Action<T> listener)
        {
            switch (listener)
            {
                case Action<bool> l: Receive(channel, l); break;
                case Action<int> l: Receive(channel, l); break;
                case Action<float> l: Receive(channel, l); break;
                case Action<string> l: Receive(channel, l); break;
                case Action<Vector2> l: Receive(channel, l); break;
                case Action<Vector3> l: Receive(channel, l); break;
                case Action<Quaternion> l: Receive(channel, l); break;
                case Action<Color> l: Receive(channel, l); break;
                case Action<bool[]> l: Receive(channel, l); break;
                case Action<int[]> l: Receive(channel, l); break;
                case Action<float[]> l: Receive(channel, l); break;
                case Action<string[]> l: Receive(channel, l); break;
                case Action<Vector2[]> l: Receive(channel, l); break;
                case Action<Vector3[]> l: Receive(channel, l); break;
                case Action<Quaternion[]> l: Receive(channel, l); break;
                case Action<Color[]> l: Receive(channel, l); break;
                case Action<JToken> l: Receive(channel, l); break;
                default: LogUnsupportedType<T>(channel); break;
            }
        }

        public static void Unregister<T>(string channel, Action<T> listener)
        {
            switch (listener)
            {
                case Action<bool> l: Unregister(channel, l); break;
                case Action<int> l: Unregister(channel, l); break;
                case Action<float> l: Unregister(channel, l); break;
                case Action<string> l: Unregister(channel, l); break;
                case Action<Vector2> l: Unregister(channel, l); break;
                case Action<Vector3> l: Unregister(channel, l); break;
                case Action<Quaternion> l: Unregister(channel, l); break;
                case Action<Color> l: Unregister(channel, l); break;
                case Action<bool[]> l: Unregister(channel, l); break;
                case Action<int[]> l: Unregister(channel, l); break;
                case Action<float[]> l: Unregister(channel, l); break;
                case Action<string[]> l: Unregister(channel, l); break;
                case Action<Vector2[]> l: Unregister(channel, l); break;
                case Action<Vector3[]> l: Unregister(channel, l); break;
                case Action<Quaternion[]> l: Unregister(channel, l); break;
                case Action<Color[]> l: Unregister(channel, l); break;
                case Action<JToken> l: Unregister(channel, l); break;
                default: LogUnsupportedType<T>(channel); break;
            }
        }

        private static void LogUnsupportedType<T>(string channel)
        {
            var name = ChannelListenerRegistry.FriendlyName(typeof(T));
            Debug.LogError($"Colibri: cannot receive '{name}' on channel '{channel}' - supported types are {SupportedTypes}. "
                + $"For your own classes, receive a JToken and convert it: Sync.Receive<JToken>(\"{channel}\", token => token.ToObject<{name}>()).");
        }
    }
}
