using System.Collections.Generic;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace HCIKonstanz.Colibri.Synchronization
{
    /// <summary>
    /// Newtonsoft JSON that converts Unity's Vector2, Vector3, Vector4, Quaternion and Color inside
    /// your own classes. The Store uses it. To put such a class into a [Sync] JObject member or
    /// Sync.Send(channel, JToken), use <c>JObject.FromObject(value, ColibriJson.Serializer)</c>,
    /// and back <c>token.ToObject&lt;YourClass&gt;(ColibriJson.Serializer)</c>.
    /// </summary>
    /// <remarks>
    /// Plain Newtonsoft fails on these types with "Self referencing loop detected", because e.g.
    /// <c>Vector3.normalized</c> is a Vector3 again.
    /// Written as the arrays Colibri puts on the wire (matching colibri-web): Vector2 <c>[x, y]</c>,
    /// Vector3 <c>[x, y, z]</c>, Vector4 and Quaternion <c>[x, y, z, w]</c>, Color <c>[r, g, b, a]</c>.
    /// Color is not written as the <c>"#RRGGBBAA"</c> of a [Sync] Color, which keeps only 8 bits per
    /// channel and clamps to 1.
    /// Read: those arrays, objects with the component names (<c>{"x": 1, "y": 2, "z": 3}</c>, the
    /// shape JsonUtility and the 1.x Store wrote), and for Color also <c>"#RRGGBBAA"</c>.
    /// Anything else throws a JsonSerializationException.
    /// </remarks>
    public static class ColibriJson
    {
        /// <summary>New settings with Colibri's converters, for JsonConvert.</summary>
        /// <remarks>
        /// Date-like strings stay strings when read into a JToken, an object or a string, as with
        /// JSON.parse in colibri-web. Read into a DateTime or DateTimeOffset, they are still dates.
        /// </remarks>
        public static JsonSerializerSettings CreateSettings()
        {
            var settings = new JsonSerializerSettings { DateParseHandling = DateParseHandling.None };
            AddConverters(settings.Converters);
            return settings;
        }

        /// <summary>
        /// A serializer with Colibri's converters, for <c>JToken.FromObject</c> and <c>ToObject</c>.
        /// Shared, so do not change its settings; use <see cref="CreateSettings"/> for your own.
        /// </summary>
        public static JsonSerializer Serializer { get; } = JsonSerializer.Create(CreateSettings());

        private static void AddConverters(IList<JsonConverter> converters)
        {
            converters.Add(new Vector2Converter());
            converters.Add(new Vector3Converter());
            converters.Add(new Vector4Converter());
            converters.Add(new QuaternionConverter());
            converters.Add(new ColorConverter());
        }

        private sealed class Vector2Converter : ComponentsConverter<Vector2>
        {
            public Vector2Converter() : base(2, "x", "y") { }
            protected override float Get(Vector2 value, int index) => index == 0 ? value.x : value.y;
            protected override Vector2 Create(float[] c, int count) => new Vector2(c[0], c[1]);
        }

        private sealed class Vector3Converter : ComponentsConverter<Vector3>
        {
            public Vector3Converter() : base(3, "x", "y", "z") { }
            protected override float Get(Vector3 value, int index) => index == 0 ? value.x : index == 1 ? value.y : value.z;
            protected override Vector3 Create(float[] c, int count) => new Vector3(c[0], c[1], c[2]);
        }

        private sealed class Vector4Converter : ComponentsConverter<Vector4>
        {
            public Vector4Converter() : base(4, "x", "y", "z", "w") { }
            protected override float Get(Vector4 value, int index) => index == 0 ? value.x : index == 1 ? value.y : index == 2 ? value.z : value.w;
            protected override Vector4 Create(float[] c, int count) => new Vector4(c[0], c[1], c[2], c[3]);
        }

        private sealed class QuaternionConverter : ComponentsConverter<Quaternion>
        {
            public QuaternionConverter() : base(4, "x", "y", "z", "w") { }
            protected override float Get(Quaternion value, int index) => index == 0 ? value.x : index == 1 ? value.y : index == 2 ? value.z : value.w;
            protected override Quaternion Create(float[] c, int count) => new Quaternion(c[0], c[1], c[2], c[3]);
        }

        // Alpha is optional (opaque if missing), as in colibri-web's [r, g, b] and "#RRGGBB".
        private sealed class ColorConverter : ComponentsConverter<Color>
        {
            public ColorConverter() : base(3, "r", "g", "b", "a") { }
            protected override float Get(Color value, int index) => index == 0 ? value.r : index == 1 ? value.g : index == 2 ? value.b : value.a;
            protected override Color Create(float[] c, int count) => new Color(c[0], c[1], c[2], count > 3 ? c[3] : 1f);

            protected override string Expected => "[r, g, b, a], an object with those names or an HTML colour like \"#RRGGBBAA\"";

            protected override bool TryReadOther(JToken token, out Color value)
            {
                value = default;
                return token.Type == JTokenType.String && ColorUtility.TryParseHtmlString(token.Value<string>(), out value);
            }
        }
    }
}
