using UnityEngine;
using Newtonsoft.Json.Linq;
using System.Linq;

namespace HCIKonstanz.Colibri.Synchronization
{
    public static class JsonExtensions
    {
        public static JArray ToJson(this Vector2 v) => new JArray { v.x, v.y };
        public static JArray ToJson(this Vector3 v) => new JArray { v.x, v.y, v.z };
        public static JArray ToJson(this Quaternion v) => new JArray { v.x, v.y, v.z, v.w };
        public static string ToJson(this Color c) => "#" + ColorUtility.ToHtmlStringRGBA(c);

        public static Vector2 ToVector2(this JToken val)
        {
            return TryReadFloats(val, 2, "vector2", out var vals)
                ? new Vector2(vals[0], vals[1])
                : Vector2.zero;
        }

        public static Vector3 ToVector3(this JToken val)
        {
            return TryReadFloats(val, 3, "vector3", out var vals)
                ? new Vector3(vals[0], vals[1], vals[2])
                : Vector3.zero;
        }

        public static Quaternion ToQuaternion(this JToken val)
        {
            return TryReadFloats(val, 4, "quaternion", out var vals)
                ? new Quaternion(vals[0], vals[1], vals[2], vals[3])
                : Quaternion.identity;
        }

        /// <summary>
        /// Colibri's own wire form for a colour is the HTML string Unity writes
        /// (<c>#RRGGBBAA</c>), which is what colibri-web's <c>receiveColor</c> is typed for.
        /// colibri-web's <c>sendColor</c>, however, puts an <c>[r,g,b,a]</c> array on the wire,
        /// so both are accepted here - otherwise a colour sent from a web client arrives in
        /// Unity as an exception rather than a colour.
        /// </summary>
        public static Color ToColor(this JToken val)
        {
            if (val != null && val.Type == JTokenType.String)
            {
                if (ColorUtility.TryParseHtmlString(val.Value<string>(), out var parsed))
                    return parsed;

                Debug.LogWarning($"Colibri: '{val}' is not a colour Unity can parse - expected an HTML colour like \"#RRGGBBAA\". Using black.");
                return Color.black;
            }

            // r, g, b and optionally a, each 0-1, the way colibri-web's sendColor writes them.
            if (TryReadFloats(val, 3, "color", out var vals))
                return new Color(vals[0], vals[1], vals[2], vals.Length > 3 ? vals[3] : 1f);

            return Color.black;
        }

        /// <summary>
        /// Reads at least <paramref name="minCount"/> numbers out of a JSON array, reporting a
        /// payload of the wrong shape instead of throwing. A malformed message used to raise an
        /// InvalidCastException out of WebServerConnection.Update, which also dropped every
        /// message queued behind it that frame.
        /// </summary>
        private static bool TryReadFloats(JToken val, int minCount, string typeName, out float[] values)
        {
            values = null;

            if (val is JArray array)
            {
                if (array.Count < minCount)
                {
                    Debug.LogWarning($"Colibri: received a {typeName} with {array.Count} value(s), expected at least {minCount}. Ignoring it.");
                    return false;
                }

                values = new float[array.Count];
                for (var i = 0; i < array.Count; i++)
                {
                    if (array[i] is JValue number && (number.Type == JTokenType.Float || number.Type == JTokenType.Integer))
                    {
                        values[i] = number.Value<float>();
                        continue;
                    }

                    Debug.LogWarning($"Colibri: received a {typeName} whose value #{i} is '{array[i]}', not a number. Ignoring it.");
                    return false;
                }

                return true;
            }

            Debug.LogWarning($"Colibri: received a {typeName} shaped like '{val}' - expected an array of {minCount} numbers. Ignoring it.");
            return false;
        }


        public static JToken ToJson(this object obj)
        {
            if (obj is bool)
                return new JValue((bool)obj);
            if (obj is int)
                return new JValue((int)obj);
            if (obj is float)
                return new JValue((float)obj);
            if (obj is string)
                return new JValue((string)obj);
            if (obj is Vector2 v2)
                return v2.ToJson();
            if (obj is Vector3 v3)
                return v3.ToJson();
            if (obj is Quaternion q)
                return q.ToJson();
            if (obj is Color c)
                return c.ToJson();
            if (obj is JObject jobj)
                return jobj;
            if (obj is JToken jtok)
                return jtok;

            if (obj is bool[])
                return new JArray((bool[])obj);
            if (obj is int[])
                return new JArray((int[])obj);
            if (obj is float[])
                return new JArray((float[])obj);
            if (obj is string[])
                return new JArray((string[])obj);
            if (obj is Vector2[] v2a)
                return new JArray(v2a.Select(x => x.ToJson()));
            if (obj is Vector3[] v3a)
                return new JArray(v3a.Select(x => x.ToJson()));
            if (obj is Quaternion[] qa)
                return new JArray(qa.Select(x => x.ToJson()));
            if (obj is Color[] ca)
                return new JArray(ca.Select(x => x.ToJson()));

            try
            {
                return new JValue(obj);
            }
            catch
            {
                Debug.LogWarning("Cannot synchronize unknown type");
                return new JValue("UNKNOWN TYPE");
            }
        }
    }
}
