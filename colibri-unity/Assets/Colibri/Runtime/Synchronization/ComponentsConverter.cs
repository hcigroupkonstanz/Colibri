using System;
using System.Globalization;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace HCIKonstanz.Colibri.Synchronization
{
    /// <summary>
    /// Base of the converters for Vector, Quaternion and Color: writes the components as an array, reads an
    /// array or an object of named components.
    /// </summary>
    // Non-generic JsonConverter so that it also takes TValue?.
    internal abstract class ComponentsConverter<TValue> : JsonConverter
        where TValue : struct
    {
        // Component names in write order; the first _required of them must be present.
        private readonly string[] _names;
        private readonly int _required;

        protected ComponentsConverter(int required, params string[] names)
        {
            _required = required;
            _names = names;
        }

        protected abstract float Get(TValue value, int index);

        // Only the first count components were given; the rest are 0.
        protected abstract TValue Create(float[] components, int count);

        // Shapes besides array and object, e.g. a colour's hex string.
        protected virtual bool TryReadOther(JToken token, out TValue value)
        {
            value = default;
            return false;
        }

        // For the error message.
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
            // Before loading: the loaded token is its own root, so its Path no longer locates it.
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
}
