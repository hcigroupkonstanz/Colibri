using Newtonsoft.Json.Linq;
using System.Linq;
using UnityEngine;

namespace HCIKonstanz.Colibri.Synchronization
{
    public static partial class Sync
    {
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
            _unreadDeletes.Note(channel, id);
            SendCommand(channel, "model::delete", new JObject { { "id", id } });
        }
    }
}
