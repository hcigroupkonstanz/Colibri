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

        // A callback with the Unity object it belongs to, so the listener goes away with that object.
        private readonly struct Listener<T>
        {
            public readonly Action<T> Callback;

            // Model listeners only: the id of the model, or null for a listener of every model on the channel.
            // Requested again after a reconnect.
            public readonly string FetchId;

            // SyncBehaviour model listeners only: called with the round when FetchId is requested again after a reconnect.
            public readonly Action<ReconnectRound> RequestedAgain;

            private readonly UnityEngine.Object _owner;
            private readonly bool _isOwned;

            public Listener(Action<T> callback, string fetchId = null, Action<ReconnectRound> requestedAgain = null)
            {
                Callback = callback;
                FetchId = fetchId;
                RequestedAgain = requestedAgain;
                _owner = ListenerOwner.Of(callback);
                _isOwned = !ReferenceEquals(_owner, null);
            }

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

        // Null while the application is quitting.
        private static WebServerConnection Connection()
        {
            // A destroyed connection (an earlier Play session's, say) is replaced.
            if (_connection == null)
            {
                _connection = WebServerConnection.Instance;
                if (_connection == null)
                    return null;

                _connection.OnMessageReceived += OnServerMessage;
                _connection.OnConnected += OnConnected;
                _connection.OnDisconnected += OnDisconnected;

                // The replaced connection's rounds never get their answers on this one, and its queued deletes are gone.
                if (_reconnectRound != null)
                {
                    _reconnectRound.IsOver = true;
                    _reconnectRound = null;
                }
                EndAnswerRounds();
                ForgetUnreadDeletes();

                // The heard-from state belongs to the replaced connection.
                _heardStamps = 0;
                _heardAt = double.NegativeInfinity;
                _heardAtHeld = false;

                // Connected already if something else created the connection first (the [RemoteLogger], say):
                // its OnConnected fired before this class subscribed.
                _withoutServerSince = _connection.Status == ConnectionStatus.Connected
                    ? double.PositiveInfinity
                    : Time.unscaledTimeAsDouble;
            }
            return _connection;
        }

        // Since when this client has had no server, on SyncTicker's clock: from taking up the connection or
        // noticing it gone. Positive infinity while connected; NaN from the session start until a connection is taken
        // up or StopsWaitingForServer is first asked.
        private static double _withoutServerSince = double.NaN;

        private static bool _hasWarnedAboutNoServer;

        /// <summary>
        /// Whether a placed body waiting for the server's state (see GenericSyncTransform) is simulated without it at
        /// <paramref name="now"/> (SyncTicker's clock): once this client has been without a server for the connect
        /// timeout and is neither connected nor connecting. The first body to do so warns once per session.
        /// </summary>
        internal static bool StopsWaitingForServer(double now)
        {
            if (double.IsNaN(_withoutServerSince))
                _withoutServerSince = now;

            var timeout = WebServerConnection.CONNECT_TIMEOUT_MS / 1000.0;
            if (now - _withoutServerSince < timeout)
                return false;

            // Not while connected or connecting. The connection comes up on a worker thread but OnConnected only
            // follows in the next Update, and an attempt can start later than _withoutServerSince (seconds later in a
            // frame that loads a scene) and gives up after the connect timeout itself.
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

        // When the last outage was noticed, on SyncTicker's clock; negative infinity before the first.
        private static double _disconnectedAt = double.NegativeInfinity;

        // Sends again the deletes the server may not have read: those made since it was last heard from, less a second
        // for those in flight. A delete made as the link drops is lost, since the reconnect only requests the objects
        // this client still has. They queue ahead of the requests made after the reconnect. One that did arrive is
        // repeated and removes an object another client has since created under the same id.
        private static void OnDisconnected() => OnDisconnected(Time.unscaledTimeAsDouble);

        /// <summary><see cref="OnDisconnected()"/>, with the outage noticed at <paramref name="now"/>.</summary>
        /// <remarks>Internal for the EditMode tests, which set the time of the outage with it.</remarks>
        internal static void OnDisconnected(double now)
        {
            _disconnectedAt = now;
            _withoutServerSince = now;

            var madeAtTheDrop = LocallyDeletedModels.Since(LastHeardAt(now) - 1, now);

            // Held until the requests go out again (see _heardAtHeld).
            _heardAtHeld = true;

            // From here until the answers are in, every delete sent counts as unread.
            _unreadDeletes ??= new List<(string Channel, string Id)>();
            if (madeAtTheDrop != null)
            {
                foreach (var (channel, id) in madeAtTheDrop)
                    NoteUnreadDelete(channel, id);
            }

            foreach (var (channel, id) in _unreadDeletes)
                SendCommand(channel, "model::delete", new JObject { { "id", id } });
        }

        // Deletes the server may not have read, oldest first: those sent again at an outage and every one sent
        // since, until the answers to the requests made after the reconnect are in (see ReconnectRound). Null while
        // none is in question. If the link drops again meanwhile they all go out again, however old: the
        // LocallyDeletedModels window is a minute and an outage can last longer.
        private static List<(string Channel, string Id)> _unreadDeletes;
        private static readonly HashSet<(string Channel, string Id)> _unreadDeleteKeys = new HashSet<(string Channel, string Id)>();

        private static void NoteUnreadDelete(string channel, string id)
        {
            if (_unreadDeletes != null && _unreadDeleteKeys.Add((channel, id)))
                _unreadDeletes.Add((channel, id));
        }

        // The id is in use again (asked for afresh): sending its delete once more would remove the new object
        // here and on every other client.
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

        // When the server was last heard from (SyncTicker's clock), the connection's liveness stamp count then,
        // and when LastHeardAt was last asked.
        private static double _heardAt = double.NegativeInfinity;
        private static long _heardStamps;
        private static double _heardAskedAt = double.NegativeInfinity;

        // Freezes LastHeardAt from an outage until the requests go out again. The next connection hears from the
        // server a frame before those requests, and a value sent in that frame would count as sent after the server
        // was last heard from, pushing out the values SentValues keeps for the answers.
        private static bool _heardAtHeld;

        /// <summary>
        /// When the server was last heard from, on SyncTicker's clock, as of <paramref name="now"/>. Any received
        /// bytes count and the server heartbeats every 100 ms. Values sent after it may have gone into a dead link
        /// (see SentValues). <paramref name="now"/> without a connection, negative infinity before anything was
        /// heard, held during an outage (see <see cref="_heardAtHeld"/>).
        /// </summary>
        internal static double LastHeardAt(double now)
        {
            var connection = _connection;
            if (connection == null)
                return now;

            // Asked once a frame (SyncTicker). The age of the last heartbeat is taken off now, but not past the previous
            // ask: the connection times heartbeats on the system clock, which is set now and then and runs on while a
            // headset sleeps, so it need not follow Unity's clock. now alone is too late after a long frame, such as a
            // synchronous scene load.
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
        /// The requests made again after one reconnect, from when they go out until the answers to all of them have
        /// arrived. During it a SyncBehaviour compares what it receives with what it sent before the outage (see
        /// SyncBehaviour's OnModelUpdate), and the deletes sent again ahead of the requests may not have reached
        /// the server.
        /// </summary>
        // An answer is an ordinary model::update, so it cannot be told from an update relayed from another client, and
        // answers cannot be counted. What can be told is the end: the server handles one client's messages in order and
        // answers in the same order, so the answer to a final request comes after all the others. That request asks for
        // an id no model has, on a channel with no models (ReconnectRoundChannel), so its bare { id } answer is
        // unmistakable. Whatever arrives before it was sent before the server read the request, so before anything this
        // client sends in reply; relayed updates in that stretch hold the server's values like the answers and are
        // judged with them. Once it arrives, the server has read everything queued ahead of the request, the resent
        // deletes included.
        // A SyncBehaviour that keeps changes of its own at its first answer opens a round of its own (see
        // AskForEndOfAnswers).
        internal sealed class ReconnectRound
        {
            // When the outage was noticed, on SyncTicker's clock: an earlier one if the link dropped again before the
            // previous round was over. Negative infinity for a round an object opened at its first answer, which
            // follows no outage: everything the object sends counts.
            internal readonly double DisconnectedAt;

            internal readonly string EndMarkerId = Guid.NewGuid().ToString();

            internal bool IsOver;

            internal ReconnectRound(double disconnectedAt) => DisconnectedAt = disconnectedAt;
        }

        /// <summary>
        /// The channel the request that ends a <see cref="ReconnectRound"/> goes out on. No model
        /// is ever put on it, and nothing received on it reaches a listener.
        /// </summary>
        internal const string ReconnectRoundChannel = "colibri::reconnect";

        private static ReconnectRound _reconnectRound;

        /// <summary>The id whose answer ends the current round; null when none is open. For the EditMode tests.</summary>
        internal static string ReconnectRoundEndMarker => _reconnectRound?.EndMarkerId;

        // Rounds an object opened at its first answer (see AskForEndOfAnswers), by the id their last request asks for,
        // until it is answered.
        private static readonly Dictionary<string, ReconnectRound> _answerRounds = new Dictionary<string, ReconnectRound>();

        /// <summary>
        /// For a SyncBehaviour that keeps changes of its own at its first answer: sends one more request now, ahead of
        /// those changes, and returns the round its answer ends. That answer comes after the answer to every earlier
        /// request, a manager's whole-channel one included, and after every update the server relayed before it read
        /// the request: all of them hold what the server had before it read the changes.
        /// </summary>
        internal static ReconnectRound AskForEndOfAnswers()
        {
            var round = new ReconnectRound(double.NegativeInfinity);

            // Added after sending: SendCommand may replace the connection, which ends the rounds of the old one.
            SendCommand(ReconnectRoundChannel, "model::request", new JObject { { "id", round.EndMarkerId }, { "again", true } });
            _answerRounds[round.EndMarkerId] = round;
            return round;
        }

        // These rounds' end markers were requested on a connection that is gone. After a reconnect the requests made
        // again open the round those objects are in.
        private static void EndAnswerRounds()
        {
            foreach (var round in _answerRounds.Values)
                round.IsOver = true;
            _answerRounds.Clear();
        }

        /// <summary>
        /// After a reconnect, requests every model again: changes other clients made during the outage never reached
        /// this client. Not on the first connection, which the requests made at registration cover.
        /// </summary>
        /// <remarks>Internal for the EditMode tests, which stand in for the connection coming up with it.</remarks>
        internal static void OnConnected()
        {
            // A body waiting for the server's state now waits for its answer (see StopsWaitingForServer).
            _withoutServerSince = double.PositiveInfinity;

            var connection = _connection;
            if (connection == null || connection.ConnectedSessions < 2)
                return;

            // Queued behind anything sent during the outage, so the answers include this client's own offline changes.
            RequestModelsAgain();
        }

        /// <summary>
        /// Requests again every model a listener is registered for. A request for one object says <c>again: true</c>:
        /// this client held it before the outage and is not putting it into the scene now, so the server answers
        /// <c>model::delete</c> if another client deleted it meanwhile, and keeps its tombstone. Without it, as when a
        /// listener registers, the object is in this client's scene or being created, and the server drops the tombstone.
        /// </summary>
        /// <remarks>Internal for the EditMode tests, which stand in for a reconnect with it.</remarks>
        internal static void RequestModelsAgain() => RequestModelsAgain(_disconnectedAt);

        /// <summary>
        /// <see cref="RequestModelsAgain()"/> with the outage noticed at <paramref name="disconnectedAt"/> (SyncTicker's
        /// clock). One more request follows them all, whose answer ends the round, and each SyncBehaviour among the
        /// requested models is told which round its answers belong to (see <see cref="ReconnectRound"/>).
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

                // A SyncBehaviour asks for its own id as well as the manager's whole-channel request: only a request for
                // that id gets the server's bare { id } answer for a model it does not have.
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

            // A round still open lost its answers: the link dropped again soon after the last reconnect. A change lost at
            // the earlier drop is still in question, so the new round counts from that outage. Counted from this one, that
            // change would predate DisconnectedAt and the stale answer would be applied.
            if (_reconnectRound != null)
            {
                disconnectedAt = Math.Min(disconnectedAt, _reconnectRound.DisconnectedAt);
                _reconnectRound.IsOver = true;
            }

            // Same for a round an object opened at its first answer: the object is in the new round now, and what it sent
            // in place of the server's values is judged like any other value sent.
            EndAnswerRounds();

            // After every other request, on every channel, so its answer comes after all of theirs. Sent even when no model
            // was requested: its answer also says the server has read the deletes sent again, and a round that is never
            // answered would carry its outage into a much later one and judge as lost what other clients changed in between.
            var round = new ReconnectRound(disconnectedAt);
            _reconnectRound = round;
            SendCommand(ReconnectRoundChannel, "model::request", new JObject { { "id", round.EndMarkerId }, { "again", true } });

            // Values sent from here on go out after the requests, so the answers cannot hold them: hearing from the
            // server counts again.
            _heardAtHeld = false;

            if (toTell == null)
                return;

            foreach (var tell in toTell)
                tell(round);
        }

        // The answer that ends a round. An id from an earlier round answers a request a failed write kept for this
        // connection; that round is over already.
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

            // The server has read everything queued ahead of the request, the resent deletes included. Later deletes are
            // resent only if made around when the server was last heard from (see OnDisconnected).
            ForgetUnreadDeletes();
        }

        // A payload that cannot be read as its command's type is reported and dropped rather than thrown, and a
        // listener that throws is reported without skipping the channel's other listeners.
        // The conversions are as lenient as JToken.Value<T>() and the explicit casts ("5" for an int, 1 for a bool).
        // Internal so the EditMode tests can deliver a message without a socket.
        internal static void OnServerMessage(string channel, string command, JToken data)
        {
            RecordTraffic(true, channel, command);

            // Colibri's own channel; never reaches listeners (see ReconnectRound).
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
                    // Not through Invoke<T>: a model message with nothing listening is not a type mismatch,
                    // only a model this client does not have.
                    if (data is JObject updated)
                        Dispatch(channel, command, _modelUpdateListeners, updated, track: false);
                    break;

                case "model::delete":
                    if (data is JObject deleted)
                        Dispatch(channel, command, _modelDeleteListeners, deleted, track: false);
                    break;
            }
        }

        // Converts only if this type has a listener on the channel: a channel this client ignores needs neither the
        // conversion nor a warning about a malformed value.
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
                // ParsePayload never returns a C# null, but other callers might; it means JSON null.
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

        // Only a JSON array is read. Enumerating any other token yields no elements, which would hand the listener an
        // empty array for a payload that is not an array.
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
            // Reported only if the channel has listeners of another type; a channel without listeners is normal.
            if (ChannelListenerRegistry.TryDescribeMismatch(channel, typeof(T), out var message))
                Debug.LogWarning(message);
        }

        // Calls the channel's listeners, pruning those whose owner was destroyed. False when none is left.
        private static bool Dispatch<T>(string channel, string command, Dictionary<string, List<Listener<T>>> listeners, T val, bool track)
        {
            if (!listeners.TryGetValue(channel, out var channelListeners))
                return false;

            Prune(channel, channelListeners, track);
            if (channelListeners.Count == 0)
            {
                // Not left empty: it would keep answering the lookup above, and later messages on this channel would be
                // dropped without a word.
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
                    // One listener's exception must not stop the others or the messages queued behind it.
                    Debug.LogError($"Colibri: a listener for {command} on channel '{channel}' threw an exception. "
                        + $"The other listeners still received the message.\n{e}");
                }
            }

            return true;
        }

        // Drops listeners whose owner was destroyed (see ListenerOwner); track also updates ChannelListenerRegistry.
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


        // Traffic log for the Colibri Status window. The buffer and the calls that fill it are compiled out of
        // release builds.

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
        /// How long an entry stays in the log, so an idle channel empties out instead of showing the last messages with
        /// ever-growing ages. Settable for the test suite.
        /// </summary>
        internal static float TrafficRetentionSeconds = DefaultTrafficRetentionSeconds;

        private static readonly TrafficEntry[] _traffic = new TrafficEntry[TrafficLogSize];
        private static int _trafficCount;

        // With domain reload disabled the log survives Play mode, and realtimeSinceStartup keeps running in edit mode,
        // so the next session would start with the last one's messages, dated from before it began.
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

                    // Newest first: once one is past the window, all the rest are older still.
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
        /// Starts a Play session without the previous one's listeners. With domain reload disabled the dictionaries
        /// survive, and so would every listener owned by no Unity object (a static method, a lambda that captures
        /// nothing): still called, and still counted for the type-mismatch warning.
        /// </summary>
        /// <remarks>
        /// No other SubsystemRegistration callback in Colibri registers a listener, so nothing registered earlier is lost
        /// here. Internal for the EditMode tests, which stand in for the start of a session with it.
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

            // Per-channel counts behind the type-mismatch warning.
            ChannelListenerRegistry.Clear();

            // Outage and heard-from state of the previous session: its clock has run on since, and no object of this
            // session is in its rounds.
            _disconnectedAt = double.NegativeInfinity;
            ForgetUnreadDeletes();
            _reconnectRound = null;
            EndAnswerRounds();
            _heardStamps = 0;
            _heardAt = double.NegativeInfinity;
            _heardAskedAt = double.NegativeInfinity;
            _heardAtHeld = false;

            _withoutServerSince = double.NaN;
            _hasWarnedAboutNoServer = false;
        }

        // track is off for the model channels: Colibri's own plumbing, which never goes through Invoke<T> and would
        // only bury the application's channels in the registry.
        private static void AddListener<T>(string channel, Dictionary<string, List<Listener<T>>> listeners, Action<T> listener,
            bool track = true, string fetchId = null, Action<ReconnectRound> requestedAgain = null)
        {
            // Ensure the connection is in the scene and subscribed to, on every registration: a channel's entry outlives
            // a destroyed connection GameObject, and a client that only listens would never get a connection again.
            Connection();

            if (!listeners.TryGetValue(channel, out var channelListeners))
            {
                channelListeners = new List<Listener<T>>();
                listeners.Add(channel, channelListeners);
            }
            else
            {
                // Sweep on registration too: a scene reload registers everything again, and the old scene's listeners would
                // pile up on a channel nothing sends on.
                Prune(channel, channelListeners, track);

                // Skip a duplicate (same method, same object). Nothing prunes a static method or a lambda that captures
                // nothing (the compiler caches it), so it would be added again on every scene reload.
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

        /// <summary>Requests every model of the channel, as registering a listener for it does.</summary>
        internal static void RequestModels(string channel) => SendCommand(channel, "model::request", null);

        public static void AddModelUpdateListener(string channel, Action<JObject> listener, string fetchInitialStateId)
            => AddModelUpdateListener(channel, listener, fetchInitialStateId, requestedAgain: null);

        /// <summary>
        /// The overload above, for a SyncBehaviour: <paramref name="requestedAgain"/> is called with the round each time
        /// the model is requested again after a reconnect.
        /// </summary>
        internal static void AddModelUpdateListener(string channel, Action<JObject> listener, string fetchInitialStateId,
            Action<ReconnectRound> requestedAgain)
        {
            AddListener(channel, _modelUpdateListeners, listener, track: false, fetchId: fetchInitialStateId, requestedAgain: requestedAgain);
            ForgetUnreadDelete(channel, fetchInitialStateId);
            SendCommand(channel, "model::request", new JObject { { "id", fetchInitialStateId } });
        }

        /// <summary>
        /// Like the overload above but sends no request. For an object a SyncBehaviourManager builds from a remote
        /// update, which already carries the state: that request would lift the server's tombstone for a model of this
        /// id deleted a moment ago. Requested again after a reconnect like every other model.
        /// </summary>
        internal static void AddModelUpdateListenerWithoutRequest(string channel, Action<JObject> listener, string id,
            Action<ReconnectRound> requestedAgain)
            => AddListener(channel, _modelUpdateListeners, listener, track: false, fetchId: id, requestedAgain: requestedAgain);

        public static void RemoveModelUpdateListener(string channel, Action<JObject> listener) => RemoveListener(channel, _modelUpdateListeners, listener, track: false);

        public static void AddModelDeleteListener(string channel, Action<JObject> listener) => AddListener(channel, _modelDeleteListeners, listener, track: false);
        public static void RemoveModelDeleteListener(string channel, Action<JObject> listener) => RemoveListener(channel, _modelDeleteListeners, listener, track: false);




        // Receive is overloaded once per supported type, so Sync.Receive("MyChannel", MyHandler) is ambiguous and every
        // call site needs a cast. Sync.Receive<float>("MyChannel", MyHandler) is not: type arguments rule the overloads
        // out. It dispatches by pattern match on the delegate, no reflection.
        // There is deliberately no Send<T>: Sync.Send("ch", value) resolves without a cast, and a generic version would
        // turn the compile error for an unsupported type into a runtime message.

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
