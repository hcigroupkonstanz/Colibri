using System;
using System.Collections.Generic;
using System.Globalization;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace HCIKonstanz.Colibri.Synchronization
{
    /// <summary>
    /// Newtonsoft JSON that can convert Unity's Vector2, Vector3, Vector4, Quaternion and Color
    /// inside your own classes. The Store uses it; use it yourself to put such a class into a
    /// [Sync] JObject member or Sync.Send(channel, JToken):
    /// <c>JObject.FromObject(value, ColibriJson.Serializer)</c>, and back with
    /// <c>token.ToObject&lt;YourClass&gt;(ColibriJson.Serializer)</c>.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Newtonsoft on its own cannot write any of these types. It writes every public property, and
    /// <c>Vector3.normalized</c> is a Vector3 again - as are <c>Quaternion.normalized</c> and
    /// <c>Color.linear</c> - so it stops with "Self referencing loop detected", and a class holding
    /// one cannot be converted at all.
    /// </para>
    /// <para>
    /// Written in the shapes Colibri puts on the wire, which are also the ones colibri-web's types
    /// describe: Vector2 <c>[x, y]</c>, Vector3 <c>[x, y, z]</c>, Vector4 and Quaternion
    /// <c>[x, y, z, w]</c>, Color <c>[r, g, b, a]</c>. A colour goes as numbers rather than the
    /// <c>"#RRGGBBAA"</c> a [Sync] Color travels as: that string keeps 8 bits per channel and
    /// nothing above 1, and a saved value should load as it was saved. Colibri reads both colour
    /// shapes everywhere, and so does colibri-web.
    /// </para>
    /// <para>
    /// Read: those arrays; objects with the components named, as in <c>{"x": 1, "y": 2, "z": 3}</c>,
    /// which is how Unity's JsonUtility - and with it Colibri 1.x's Store - wrote them; and for a
    /// colour also <c>"#RRGGBBAA"</c>. Anything else is a JsonSerializationException.
    /// </para>
    /// </remarks>
    public static class ColibriJson
    {
        /// <summary>New settings with Colibri's converters, for JsonConvert.</summary>
        /// <remarks>
        /// A string that looks like a date stays the string it is when it is read into a JToken,
        /// an object or a string - as JSON.parse in colibri-web leaves it. Newtonsoft's default turns
        /// "2026-10-08T12:00:00Z" into a DateTime there, which comes back as "10/08/2026 12:00:00",
        /// or moved into this device's time zone. Read into a DateTime or DateTimeOffset, it is
        /// still a date.
        /// </remarks>
        public static JsonSerializerSettings CreateSettings()
        {
            var settings = new JsonSerializerSettings { DateParseHandling = DateParseHandling.None };
            AddConverters(settings.Converters);
            return settings;
        }

        /// <summary>
        /// A serializer with Colibri's converters, for <c>JToken.FromObject</c> and
        /// <c>ToObject</c>. Shared, so leave its settings alone; take
        /// <see cref="CreateSettings"/> for settings of your own.
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


        /// <summary>
        /// One Unity value type, written as an array of its float components. Non-generic
        /// JsonConverter rather than JsonConverter&lt;T&gt;, so that it takes the nullable form of
        /// the type too.
        /// </summary>
        private abstract class ComponentsConverter<TValue> : JsonConverter
            where TValue : struct
        {
            private readonly string[] _names;
            private readonly int _required;

            /// <param name="required">How many leading components a value has to have.</param>
            /// <param name="names">The components, in the order they are written.</param>
            protected ComponentsConverter(int required, params string[] names)
            {
                _required = required;
                _names = names;
            }

            protected abstract float Get(TValue value, int index);

            /// <summary>The value from its components; <paramref name="count"/> of them were given, the rest are 0.</summary>
            protected abstract TValue Create(float[] components, int count);

            /// <summary>A shape other than the array and the object, such as a colour's hex string.</summary>
            protected virtual bool TryReadOther(JToken token, out TValue value)
            {
                value = default;
                return false;
            }

            /// <summary>The shapes this converter reads, for the message about one it cannot.</summary>
            protected virtual string Expected => $"[{string.Join(", ", _names)}] or an object with those names";

            public override bool CanConvert(Type objectType)
                => objectType == typeof(TValue) || objectType == typeof(TValue?);

            public override void WriteJson(JsonWriter writer, object value, JsonSerializer serializer)
            {
                if (value == null)
                {
                    writer.WriteNull();
                    return;
                }

                var typed = (TValue)value;
                writer.WriteStartArray();
                for (var i = 0; i < _names.Length; i++)
                    writer.WriteValue(Get(typed, i));
                writer.WriteEndArray();
            }

            public override object ReadJson(JsonReader reader, Type objectType, object existingValue, JsonSerializer serializer)
            {
                // Taken before the token is loaded: a loaded token is a root of its own, and its
                // path no longer says where in the document it was.
                var path = reader.Path;
                var token = JToken.Load(reader);

                if (token.Type == JTokenType.Null && objectType == typeof(TValue?))
                    return null;

                if (TryReadOther(token, out var value) || TryRead(token, out value))
                    return value;

                var text = token.ToString(Formatting.None);
                if (text.Length > 100)
                    text = text.Substring(0, 100) + "...";

                throw new JsonSerializationException($"'{text}' at '{path}' is not a {typeof(TValue).Name} - expected {Expected}.");
            }

            private bool TryRead(JToken token, out TValue value)
            {
                value = default;
                var components = new float[_names.Length];
                var count = 0;

                if (token is JArray array)
                {
                    if (array.Count < _required)
                        return false;

                    count = Math.Min(array.Count, _names.Length);
                    for (var i = 0; i < count; i++)
                    {
                        if (!TryReadNumber(array[i], out components[i]))
                            return false;
                    }
                }
                else if (token is JObject named)
                {
                    for (var i = 0; i < _names.Length; i++)
                    {
                        if (!named.TryGetValue(_names[i], out var component))
                        {
                            if (i < _required)
                                return false;
                            break;
                        }

                        if (!TryReadNumber(component, out components[i]))
                            return false;
                        count = i + 1;
                    }
                }
                else
                {
                    return false;
                }

                value = Create(components, count);
                return true;
            }

            private static bool TryReadNumber(JToken component, out float number)
            {
                if (component.Type == JTokenType.Float || component.Type == JTokenType.Integer)
                {
                    number = component.Value<float>();
                    return true;
                }

                // How Newtonsoft writes NaN and the infinities by default.
                if (component.Type == JTokenType.String)
                    return float.TryParse(component.Value<string>(), NumberStyles.Float, CultureInfo.InvariantCulture, out number);

                number = 0f;
                return false;
            }
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

        /// <summary>Alpha is optional, as in colibri-web's [r, g, b] and Unity's "#RRGGBB": opaque.</summary>
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
