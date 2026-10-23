using HCIKonstanz.Colibri.Networking;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;

namespace HCIKonstanz.Colibri.Synchronization
{
    public static partial class Sync
    {
        private static WebServerConnection _connection;

        private static readonly ListenerTable<bool> _boolListeners = new ListenerTable<bool>();
        private static readonly ListenerTable<int> _intListeners = new ListenerTable<int>();
        private static readonly ListenerTable<float> _floatListeners = new ListenerTable<float>();
        private static readonly ListenerTable<string> _stringListeners = new ListenerTable<string>();
        private static readonly ListenerTable<Vector2> _vector2Listeners = new ListenerTable<Vector2>();
        private static readonly ListenerTable<Vector3> _vector3Listeners = new ListenerTable<Vector3>();
        private static readonly ListenerTable<Quaternion> _quaternionListeners = new ListenerTable<Quaternion>();
        private static readonly ListenerTable<Color> _colorListeners = new ListenerTable<Color>();
        private static readonly ListenerTable<bool[]> _boolArrayListeners = new ListenerTable<bool[]>();
        private static readonly ListenerTable<int[]> _intArrayListeners = new ListenerTable<int[]>();
        private static readonly ListenerTable<float[]> _floatArrayListeners = new ListenerTable<float[]>();
        private static readonly ListenerTable<string[]> _stringArrayListeners = new ListenerTable<string[]>();
        private static readonly ListenerTable<Vector2[]> _vector2ArrayListeners = new ListenerTable<Vector2[]>();
        private static readonly ListenerTable<Vector3[]> _vector3ArrayListeners = new ListenerTable<Vector3[]>();
        private static readonly ListenerTable<Quaternion[]> _quaternionArrayListeners = new ListenerTable<Quaternion[]>();
        private static readonly ListenerTable<Color[]> _colorArrayListeners = new ListenerTable<Color[]>();
        private static readonly ListenerTable<JToken> _jsonListeners = new ListenerTable<JToken>();

        private static readonly ListenerTable<JObject> _modelUpdateListeners = new ListenerTable<JObject>();
        private static readonly ListenerTable<JObject> _modelDeleteListeners = new ListenerTable<JObject>();

        private static readonly UnreadDeletes _unreadDeletes = new UnreadDeletes();
        private static readonly ServerHeardClock _heardClock = new ServerHeardClock();
        private static readonly ServerAbsence _serverAbsence = new ServerAbsence();
        private static readonly ReconnectRounds _reconnectRounds = new ReconnectRounds();
        private static readonly Func<bool> _isConnectedOrConnecting = IsConnectedOrConnecting;

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
                _reconnectRounds.EndAll();
                _unreadDeletes.ForgetAll();

                // The heard-from state belongs to the replaced connection.
                _heardClock.ForgetConnection();

                // Connected already if something else created the connection first (the [RemoteLogger], say):
                // its OnConnected fired before this class subscribed.
                if (_connection.Status == ConnectionStatus.Connected)
                    _serverAbsence.End();
                else
                    _serverAbsence.Begin(Time.unscaledTimeAsDouble);
            }
            return _connection;
        }

        /// <summary>
        /// Whether a placed body waiting for the server's state (see GenericSyncTransform) is simulated without it at
        /// <paramref name="now"/> (SyncTicker's clock): once this client has been without a server for the connect
        /// timeout and is neither connected nor connecting. The first body to do so warns once per session.
        /// </summary>
        internal static bool StopsWaitingForServer(double now)
        {
            var timeout = WebServerConnection.CONNECT_TIMEOUT_MS / 1000.0;
            return _serverAbsence.StopsWaitingForServer(now, timeout, _isConnectedOrConnecting);
        }

        private static bool IsConnectedOrConnecting()
        {
            var connection = _connection;
            if (!ReferenceEquals(connection, null))
            {
                var status = connection.Status;
                if (status == ConnectionStatus.Connected || status == ConnectionStatus.Connecting
                    || status == ConnectionStatus.Reconnecting)
                    return true;
            }
            return false;
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
            _serverAbsence.Begin(now);

            var madeAtTheDrop = LocallyDeletedModels.Since(LastHeardAt(now) - 1, now);

            // Held until the requests go out again (see ServerHeardClock).
            _heardClock.Hold();

            // From here until the answers are in, every delete sent counts as unread.
            _unreadDeletes.StartTracking();
            if (madeAtTheDrop != null)
            {
                foreach (var (channel, id) in madeAtTheDrop)
                    _unreadDeletes.Note(channel, id);
            }

            foreach (var (channel, id) in _unreadDeletes)
                SendCommand(channel, "model::delete", new JObject { { "id", id } });
        }

        /// <summary>
        /// When the server was last heard from, on SyncTicker's clock, as of <paramref name="now"/>. Any received
        /// bytes count and the server heartbeats every 100 ms. Values sent after it may have gone into a dead link
        /// (see SentValues). <paramref name="now"/> without a connection, negative infinity before anything was
        /// heard, held during an outage (see <see cref="ServerHeardClock"/>).
        /// </summary>
        internal static double LastHeardAt(double now)
        {
            var connection = _connection;
            if (connection == null)
                return now;

            var stamps = connection.LivenessStamps;
            if (_heardClock.TakesStamps(stamps))
                _heardClock.Hear(now, stamps, connection.MillisSinceLastHeartbeat());
            return _heardClock.LastHeardAt(now);
        }

        /// <summary>
        /// The channel the request that ends a <see cref="ReconnectRound"/> goes out on. No model
        /// is ever put on it, and nothing received on it reaches a listener.
        /// </summary>
        internal const string ReconnectRoundChannel = "colibri::reconnect";

        /// <summary>The id whose answer ends the current round; null when none is open. For the EditMode tests.</summary>
        internal static string ReconnectRoundEndMarker => _reconnectRounds.CurrentEndMarker;

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
            _reconnectRounds.AddAnswerRound(round);
            return round;
        }

        /// <summary>
        /// After a reconnect, requests every model again: changes other clients made during the outage never reached
        /// this client. Not on the first connection, which the requests made at registration cover.
        /// </summary>
        /// <remarks>Internal for the EditMode tests, which stand in for the connection coming up with it.</remarks>
        internal static void OnConnected()
        {
            // A body waiting for the server's state now waits for its answer (see StopsWaitingForServer).
            _serverAbsence.End();

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

            foreach (var entry in _modelUpdateListeners.Snapshot())
            {
                var channel = entry.Key;
                var channelListeners = entry.Value;

                ListenerTable<JObject>.Prune(channel, channelListeners, track: false);
                if (channelListeners.Count == 0)
                {
                    _modelUpdateListeners.RemoveChannel(channel);
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

            // After every other request, on every channel, so its answer comes after all of theirs. Sent even when no model
            // was requested: its answer also says the server has read the deletes sent again, and a round that is never
            // answered would carry its outage into a much later one and judge as lost what other clients changed in between.
            var round = _reconnectRounds.OpenReconnectRound(disconnectedAt);
            SendCommand(ReconnectRoundChannel, "model::request", new JObject { { "id", round.EndMarkerId }, { "again", true } });

            // Values sent from here on go out after the requests, so the answers cannot hold them: hearing from the
            // server counts again.
            _heardClock.Release();

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
            if (_reconnectRounds.TryEndAnswerRound(marker))
                return;

            if (!_reconnectRounds.TryEndReconnectRound(marker))
                return;

            // The server has read everything queued ahead of the request, the resent deletes included. Later deletes are
            // resent only if made around when the server was last heard from (see OnDisconnected).
            _unreadDeletes.ForgetAll();
        }

        // A payload that cannot be read as its command's type is reported and dropped rather than thrown, and a
        // listener that throws is reported without skipping the channel's other listeners.
        // The conversions are as lenient as JToken.Value<T>() and the explicit casts ("5" for an int, 1 for a bool).
        // Internal so the EditMode tests can deliver a message without a socket.
        internal static void OnServerMessage(string channel, string command, JToken data)
        {
            TrafficLog.Record(true, channel, command);

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
                        _modelUpdateListeners.Dispatch(channel, command, updated, track: false);
                    break;

                case "model::delete":
                    if (data is JObject deleted)
                        _modelDeleteListeners.Dispatch(channel, command, deleted, track: false);
                    break;
            }
        }

        // Converts only if this type has a listener on the channel: a channel this client ignores needs neither the
        // conversion nor a warning about a malformed value.
        private static void Deliver<T>(string channel, string command, JToken data,
            ListenerTable<T> listeners, Func<JToken, T> convert)
        {
            if (!listeners.HasChannel(channel))
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

        private static void Invoke<T>(string channel, string command, ListenerTable<T> listeners, T val)
        {
            if (val == null)
                return;

            if (listeners.Dispatch(channel, command, val, track: true))
                return;

            ReportMismatch<T>(channel);
        }

        private static void ReportMismatch<T>(string channel)
        {
            // Reported only if the channel has listeners of another type; a channel without listeners is normal.
            if (ChannelListenerRegistry.TryDescribeMismatch(channel, typeof(T), out var message))
                Debug.LogWarning(message);
        }

        public struct TrafficEntry
        {
            public bool Incoming;
            public string Channel;
            public string Command;
            public float Time;
        }

#if UNITY_EDITOR || DEVELOPMENT_BUILD
        /// <summary>
        /// The most recent messages sent and received, newest first, dropping anything older
        /// than <see cref="TrafficLog.RetentionSeconds"/>.
        /// </summary>
        public static IEnumerable<TrafficEntry> RecentTraffic => TrafficLog.RecentTraffic;
#else
        public static IEnumerable<TrafficEntry> RecentTraffic => Enumerable.Empty<TrafficEntry>();
#endif

        private static void SendCommand(string channel, string command, JToken data)
        {
            var connection = Connection();
            if (connection == null)
                return;

            TrafficLog.Record(false, channel, command);
            connection.SendCommand(channel, command, data);
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
            _unreadDeletes.ForgetAll();
            _reconnectRounds.Reset();
            _heardClock.Reset();

            _serverAbsence.Reset();
        }

        // track is off for the model channels: Colibri's own plumbing, which never goes through Invoke<T> and would
        // only bury the application's channels in the registry.
        private static void AddListener<T>(string channel, ListenerTable<T> listeners, Action<T> listener,
            bool track = true, string fetchId = null, Action<ReconnectRound> requestedAgain = null)
        {
            // Ensure the connection is in the scene and subscribed to, on every registration: a channel's entry outlives
            // a destroyed connection GameObject, and a client that only listens would never get a connection again.
            Connection();

            listeners.Add(channel, listener, track, fetchId, requestedAgain);
        }
    }
}
