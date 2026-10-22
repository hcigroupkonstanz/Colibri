using Newtonsoft.Json.Linq;
using System;
using UnityEngine;

namespace HCIKonstanz.Colibri.Synchronization
{
    public static partial class Sync
    {
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
