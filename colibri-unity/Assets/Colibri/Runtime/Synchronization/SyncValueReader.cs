using System;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace HCIKonstanz.Colibri.Synchronization
{
    internal static class SyncValueReader
    {
        internal static readonly object UnsupportedValue = new object();

        internal static object ReadValue(Type type, JToken value)
        {
            if (type == typeof(bool))
                return value.Value<bool>();
            if (type == typeof(int))
                return value.Value<int>();
            if (type == typeof(float))
                return value.Value<float>();
            if (type == typeof(string))
                return value.Value<string>();
            if (type == typeof(Vector2))
                return value.ToVector2Strict();
            if (type == typeof(Vector3))
                return value.ToVector3Strict();
            if (type == typeof(Quaternion))
                return value.ToQuaternionStrict();
            if (type == typeof(Color))
                return value.ToColorStrict();
            // ArrayStrict throws on a JSON null or a single value instead of making an empty array.
            if (type == typeof(bool[]))
                return value.ArrayStrict().Select(x => (bool)x).ToArray();
            if (type == typeof(int[]))
                return value.ArrayStrict().Select(x => (int)x).ToArray();
            if (type == typeof(float[]))
                return value.ArrayStrict().Select(x => (float)x).ToArray();
            if (type == typeof(string[]))
                return value.ArrayStrict().Select(x => (string)x).ToArray();
            if (type == typeof(Vector2[]))
                return value.ArrayStrict().Select(x => x.ToVector2Strict()).ToArray();
            if (type == typeof(Vector3[]))
                return value.ArrayStrict().Select(x => x.ToVector3Strict()).ToArray();
            if (type == typeof(Quaternion[]))
                return value.ArrayStrict().Select(x => x.ToQuaternionStrict()).ToArray();
            if (type == typeof(Color[]))
                return value.ArrayStrict().Select(x => x.ToColorStrict()).ToArray();
            if (type == typeof(JObject))
            {
                // A null JObject member arrives as a JSON null, which is a JValue and not a JObject.
                if (value.Type == JTokenType.Null)
                    return null;
                return value as JObject ?? throw new InvalidCastException($"{value.Type} is not a JSON object");
            }
            return UnsupportedValue;
        }
    }
}
