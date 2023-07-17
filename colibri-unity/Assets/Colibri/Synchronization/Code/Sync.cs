using HCIKonstanz.Colibri.Networking;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;

namespace HCIKonstanz.Colibri.Synchronization
{
    public static class Sync
    {
        private static WebServerConnection _connection;

        private static readonly Dictionary<string, List<Action<bool>>> _boolListeners = new Dictionary<string, List<Action<bool>>>();
        private static readonly Dictionary<string, List<Action<int>>> _intListeners = new Dictionary<string, List<Action<int>>>();
        private static readonly Dictionary<string, List<Action<float>>> _floatListeners = new Dictionary<string, List<Action<float>>>();
        private static readonly Dictionary<string, List<Action<string>>> _stringListeners = new Dictionary<string, List<Action<string>>>();
        private static readonly Dictionary<string, List<Action<Vector2>>> _vector2Listeners = new Dictionary<string, List<Action<Vector2>>>();
        private static readonly Dictionary<string, List<Action<Vector3>>> _vector3Listeners = new Dictionary<string, List<Action<Vector3>>>();
        private static readonly Dictionary<string, List<Action<Quaternion>>> _quaternionListeners = new Dictionary<string, List<Action<Quaternion>>>();
        private static readonly Dictionary<string, List<Action<Color>>> _colorListeners = new Dictionary<string, List<Action<Color>>>();
        private static readonly Dictionary<string, List<Action<bool[]>>> _boolArrayListeners = new Dictionary<string, List<Action<bool[]>>>();
        private static readonly Dictionary<string, List<Action<int[]>>> _intArrayListeners = new Dictionary<string, List<Action<int[]>>>();
        private static readonly Dictionary<string, List<Action<float[]>>> _floatArrayListeners = new Dictionary<string, List<Action<float[]>>>();
        private static readonly Dictionary<string, List<Action<string[]>>> _stringArrayListeners = new Dictionary<string, List<Action<string[]>>>();
        private static readonly Dictionary<string, List<Action<Vector2[]>>> _vector2ArrayListeners = new Dictionary<string, List<Action<Vector2[]>>>();
        private static readonly Dictionary<string, List<Action<Vector3[]>>> _vector3ArrayListeners = new Dictionary<string, List<Action<Vector3[]>>>();
        private static readonly Dictionary<string, List<Action<Quaternion[]>>> _quaternionArrayListeners = new Dictionary<string, List<Action<Quaternion[]>>>();
        private static readonly Dictionary<string, List<Action<Color[]>>> _colorArrayListeners = new Dictionary<string, List<Action<Color[]>>>();
        private static readonly Dictionary<string, List<Action<JToken>>> _jsonListeners = new Dictionary<string, List<Action<JToken>>>();

        private static readonly Dictionary<string, List<Action<JObject>>> _modelUpdateListeners = new Dictionary<string, List<Action<JObject>>>();
        private static readonly Dictionary<string, List<Action<JObject>>> _modelDeleteListeners = new Dictionary<string, List<Action<JObject>>>();

        private static WebServerConnection Connection()
        {
            if (_connection == null)
            {
                _connection = WebServerConnection.Instance;
                _connection.OnMessageReceived += OnServerMessage;
            }
            return _connection;
        }

        private static void OnServerMessage(string channel, string command, JToken data)
        {
            switch (command)
            {
                case "bool":
                    Invoke(channel, _boolListeners, data.Value<bool>());
                    break;
                case "int":
                    Invoke(channel, _intListeners, data.Value<int>());
                    break;
                case "float":
                    Invoke(channel, _floatListeners, data.Value<float>());
                    break;
                case "string":
                    Invoke(channel, _stringListeners, data.Value<string>());
                    break;
                case "vector2":
                    Invoke(channel, _vector2Listeners, data.ToVector2());
                    break;
                case "vector3":
                    Invoke(channel, _vector3Listeners, data.ToVector3());
                    break;
                case "quaternion":
                    Invoke(channel, _quaternionListeners, data.ToQuaternion());
                    break;
                case "color":
                    Invoke(channel, _colorListeners, data.ToColor());
                    break;

                case "bool[]":
                    Invoke(channel, _boolArrayListeners, data.Select(x => (bool)x).ToArray());
                    break;
                case "int[]":
                    Invoke(channel, _intArrayListeners, data.Select(x => (int)x).ToArray());
                    break;
                case "float[]":
                    Invoke(channel, _floatArrayListeners, data.Select(x => (float)x).ToArray());
                    break;
                case "string[]":
                    Invoke(channel, _stringArrayListeners, data.Select(x => (string)x).ToArray());
                    break;
                case "vector2[]":
                    Invoke(channel, _vector2ArrayListeners, data.Select(x => x.ToVector2()).ToArray());
                    break;
                case "vector3[]":
                    Invoke(channel, _vector3ArrayListeners, data.Select(x => x.ToVector3()).ToArray());
                    break;
                case "quaternion[]":
                    Invoke(channel, _quaternionArrayListeners, data.Select(x => x.ToQuaternion()).ToArray());
                    break;
                case "color[]":
                    Invoke(channel, _colorArrayListeners, data.Select(x => x.ToColor()).ToArray());
                    break;

                case "JSON":
                    Invoke(channel, _jsonListeners, data);
                    break;

                case "modelUpdate":
                    // cause TypeLoadExceptions sometimes??
                    //Invoke<JObject>(channel, _modelUpdateListeners, (JObject)data);
                    if (_modelUpdateListeners.ContainsKey(channel))
                    {
                        foreach (var listener in _modelUpdateListeners[channel].ToArray())
                        {
                            if (data is JObject jdata)
                                listener.Invoke(jdata);
                        }
                    }
                    break;

                case "modelDelete":
                    // cause TypeLoadExceptions sometimes??
                    //Invoke<JObject>(channel, _modelDeleteListeners, (JObject)data);
                    if (_modelDeleteListeners.ContainsKey(channel))
                    {
                        foreach (var listener in _modelDeleteListeners[channel].ToArray())
                        {
                            if (data is JObject jdata)
                                listener.Invoke(jdata);
                        }
                    }
                    break;
            }
        }

        private static void Invoke<T>(string channel, Dictionary<string, List<Action<T>>> listeners, T val)
        {
            if (listeners.ContainsKey(channel) && val != null)
            {
                foreach (var listener in listeners[channel].ToArray())
                    listener.Invoke(val);
            }
        }





        /*
         *  Sending data
         */
        public static void SendData(string channel, bool data) => Connection().SendCommand(channel, "bool", data);
        public static void SendData(string channel, int data) => Connection().SendCommand(channel, "int", data);
        public static void SendData(string channel, float data) => Connection().SendCommand(channel, "float", data);
        public static void SendData(string channel, string data) => Connection().SendCommand(channel, "string", data);
        public static void SendData(string channel, Vector2 data) => Connection().SendCommand(channel, "vector2", data.ToJson());
        public static void SendData(string channel, Vector3 data) => Connection().SendCommand(channel, "vector3", data.ToJson());
        public static void SendData(string channel, Quaternion data) => Connection().SendCommand(channel, "quaternion", data.ToJson());
        public static void SendData(string channel, Color data) => Connection().SendCommand(channel, "color", data.ToJson());
        public static void SendData(string channel, bool[] data) => Connection().SendCommand(channel, "bool[]", new JArray(data));
        public static void SendData(string channel, int[] data) => Connection().SendCommand(channel, "int[]", new JArray(data));
        public static void SendData(string channel, float[] data) => Connection().SendCommand(channel, "float[]", new JArray(data));
        public static void SendData(string channel, string[] data) => Connection().SendCommand(channel, "string[]", new JArray(data));
        public static void SendData(string channel, Vector2[] data) => Connection().SendCommand(channel, "vector2[]", new JArray(data.Select(x => x.ToJson())));
        public static void SendData(string channel, Vector3[] data) => Connection().SendCommand(channel, "vector3[]", new JArray(data.Select(x => x.ToJson())));
        public static void SendData(string channel, Quaternion[] data) => Connection().SendCommand(channel, "quaternion[]", new JArray(data.Select(x => x.ToJson())));
        public static void SendData(string channel, Color[] data) => Connection().SendCommand(channel, "color[]", new JArray(data.Select(x => x.ToJson())));
        public static void SendData(string channel, JToken data) => Connection().SendCommand(channel, "JSON", data);

        public static void SendModelUpdate(string channel, JObject data) => Connection().SendCommand(channel, "modelUpdate", data);
        public static void SendModelDelete(string channel, int id) => Connection().SendCommand(channel, "modelDelete", new JObject { { "Id", id } });
        public static void SendModelDelete(string channel, string id) => Connection().SendCommand(channel, "modelDelete", new JObject { { "Id", id } });




        /*
         *  Listeners
         */

        private static void AddListener<T>(string channel, Dictionary<string, List<Action<T>>> listeners, Action<T> listener)
        {
            if (!listeners.ContainsKey(channel))
                listeners.Add(channel, new List<Action<T>>());
            listeners[channel].Add(listener);
        }

        private static void RemoveListener<T>(string channel, Dictionary<string, List<Action<T>>> listeners, Action<T> listener)
        {
            if (listeners.ContainsKey(channel))
            {
                var list = listeners[channel];
                list.Remove(listener);
                if (list.Count == 0)
                    listeners.Remove(channel);
            }
        }

        public static void AddBoolListener(string channel, Action<bool> listener) => AddListener(channel, _boolListeners, listener);
        public static void RemoveBoolListener(string channel, Action<bool> listener) => RemoveListener(channel, _boolListeners, listener);

        public static void AddIntListener(string channel, Action<int> listener) => AddListener(channel, _intListeners, listener);
        public static void RemoveIntListener(string channel, Action<int> listener) => RemoveListener(channel, _intListeners, listener);

        public static void AddFloatListener(string channel, Action<float> listener) => AddListener(channel, _floatListeners, listener);
        public static void RemoveFloatListener(string channel, Action<float> listener) => RemoveListener(channel, _floatListeners, listener);

        public static void AddStringListener(string channel, Action<string> listener) => AddListener(channel, _stringListeners, listener);
        public static void RemoveStringListener(string channel, Action<string> listener) => RemoveListener(channel, _stringListeners, listener);

        public static void AddVector2Listener(string channel, Action<Vector2> listener) => AddListener(channel, _vector2Listeners, listener);
        public static void RemoveVector2Listener(string channel, Action<Vector2> listener) => RemoveListener(channel, _vector2Listeners, listener);

        public static void AddVector3Listener(string channel, Action<Vector3> listener) => AddListener(channel, _vector3Listeners, listener);
        public static void RemoveVector3Listener(string channel, Action<Vector3> listener) => RemoveListener(channel, _vector3Listeners, listener);

        public static void AddQuaternionListener(string channel, Action<Quaternion> listener) => AddListener(channel, _quaternionListeners, listener);
        public static void RemoveQuaternionListener(string channel, Action<Quaternion> listener) => RemoveListener(channel, _quaternionListeners, listener);

        public static void AddColorListener(string channel, Action<Color> listener) => AddListener(channel, _colorListeners, listener);
        public static void RemoveColorListener(string channel, Action<Color> listener) => RemoveListener(channel, _colorListeners, listener);

        public static void AddBoolArrayListener(string channel, Action<bool[]> listener) => AddListener(channel, _boolArrayListeners, listener);
        public static void RemoveBoolArrayListener(string channel, Action<bool[]> listener) => RemoveListener(channel, _boolArrayListeners, listener);

        public static void AddIntArrayListener(string channel, Action<int[]> listener) => AddListener(channel, _intArrayListeners, listener);
        public static void RemoveIntArrayListener(string channel, Action<int[]> listener) => RemoveListener(channel, _intArrayListeners, listener);

        public static void AddFloatArrayListener(string channel, Action<float[]> listener) => AddListener(channel, _floatArrayListeners, listener);
        public static void RemoveFloatArrayListener(string channel, Action<float[]> listener) => RemoveListener(channel, _floatArrayListeners, listener);

        public static void AddStringArrayListener(string channel, Action<string[]> listener) => AddListener(channel, _stringArrayListeners, listener);
        public static void RemoveStringArrayListener(string channel, Action<string[]> listener) => RemoveListener(channel, _stringArrayListeners, listener);

        public static void AddVector2ArrayListener(string channel, Action<Vector2[]> listener) => AddListener(channel, _vector2ArrayListeners, listener);
        public static void RemoveVector2ArrayListener(string channel, Action<Vector2[]> listener) => RemoveListener(channel, _vector2ArrayListeners, listener);

        public static void AddVector3ArrayListener(string channel, Action<Vector3[]> listener) => AddListener(channel, _vector3ArrayListeners, listener);
        public static void RemoveVector3ArrayListener(string channel, Action<Vector3[]> listener) => RemoveListener(channel, _vector3ArrayListeners, listener);

        public static void AddQuaternionArrayListener(string channel, Action<Quaternion[]> listener) => AddListener(channel, _quaternionArrayListeners, listener);
        public static void RemoveQuaternionArrayListener(string channel, Action<Quaternion[]> listener) => RemoveListener(channel, _quaternionArrayListeners, listener);

        public static void AddColorArrayListener(string channel, Action<Color[]> listener) => AddListener(channel, _colorArrayListeners, listener);
        public static void RemoveColorArrayListener(string channel, Action<Color[]> listener) => RemoveListener(channel, _colorArrayListeners, listener);


        public static void AddJSONListener(string channel, Action<JToken> listener) => AddListener(channel, _jsonListeners, listener);
        public static void RemoveJSONListener(string channel, Action<JToken> listener) => RemoveListener(channel, _jsonListeners, listener);

        public static void AddModelUpdateListener(string channel, Action<JObject> listener)
        {
            AddListener(channel, _modelUpdateListeners, listener);
            Connection().SendCommand(channel, "modelInitialState", null);
        }

        public static void AddModelUpdateListener(string channel, Action<JObject> listener, int fetchInitialStateId)
        {
            AddListener(channel, _modelUpdateListeners, listener);
            Connection().SendCommand(channel, "modelInitialState", new JObject { { "Id", fetchInitialStateId } });
        }

        public static void AddModelUpdateListener(string channel, Action<JObject> listener, string fetchInitialStateId)
        {
            AddListener(channel, _modelUpdateListeners, listener);
            Connection().SendCommand(channel, "modelInitialState", new JObject { { "Id", fetchInitialStateId } });
        }

        public static void RemoveModelUpdateListener(string channel, Action<JObject> listener) => RemoveListener(channel, _modelUpdateListeners, listener);

        public static void AddModelDeleteListener(string channel, Action<JObject> listener) => AddListener(channel, _modelDeleteListeners, listener);
        public static void RemoveModelDeleteListener(string channel, Action<JObject> listener) => RemoveListener(channel, _modelDeleteListeners, listener);
    }
}
