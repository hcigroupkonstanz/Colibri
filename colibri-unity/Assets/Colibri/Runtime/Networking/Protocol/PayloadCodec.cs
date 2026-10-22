using System;
using System.IO;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace HCIKonstanz.Colibri.Networking.Protocol
{
    /// <summary>Encodes outgoing message frames, parses received payloads and sanitizes handshake fields.</summary>
    internal static class PayloadCodec
    {
        // The server's ClientLogger (client-logger.ts) reads this payload with asString(), so it goes out as
        // raw text instead of JSON. Quoted, the admin UI's log page would show stray quotes.
        private const string LOG_CHANNEL = "log";

        private static readonly Encoding Utf8 = new UTF8Encoding(false, false);

        internal static byte[] EncodeFrame(string channel, string command, JToken payload)
        {
            try
            {
                return FrameCodec.EncodeMessage(channel, command, EncodePayload(channel, payload));
            }
            catch (FrameException e)
            {
                // One unrepresentable message is dropped as one bad message, exactly as the
                // server does on its own egress path.
                Debug.LogError($"Colibri: dropping unencodable message ({channel} / {command}): {e.Message}");
                return null;
            }
        }

        internal static byte[] TryEncodeFrame(string channel, string command, JToken payload)
        {
            try
            {
                return FrameCodec.EncodeMessage(channel, command, EncodePayload(channel, payload));
            }
            catch (FrameException)
            {
                return null;
            }
        }

        internal static byte[] EncodePayload(string channel, JToken payload)
        {
            if (payload == null || payload.Type == JTokenType.Null)
                return Array.Empty<byte>();

            // Everything except the log channel goes out as JSON. A string payload written unquoted (as 1.x did)
            // is not valid JSON, so the server's Payload.asValue() would throw and fall back to asString(), and a
            // Unity string and a web client's string would not round-trip identically.
            if (channel == LOG_CHANNEL)
                return Utf8.GetBytes(payload.Type == JTokenType.String ? payload.Value<string>() : payload.ToString(Formatting.None));

            return Utf8.GetBytes(payload.ToString(Formatting.None));
        }

        /// <summary>
        /// Reads a received payload as JSON, keeping every string exactly as it was sent.
        /// </summary>
        /// <remarks>
        /// JToken.Parse reads a string that looks like a date ("2026-10-08T12:00:00Z", what JavaScript's
        /// toISOString() and C#'s ToString("o") write) as a DateTime. A string listener or a [Sync] string
        /// member would get "10/08/2026 12:00:00" instead, and a timestamp with an offset would be moved into
        /// this device's time zone, while colibri-web, reading the message with JSON.parse, keeps the string.
        /// </remarks>
        internal static JToken ParsePayload(byte[] payload)
        {
            if (payload == null || payload.Length == 0)
                return JValue.CreateNull();

            var text = Utf8.GetString(payload);
            try
            {
                // What JToken.Parse does, but with dates left as strings.
                using (var reader = new JsonTextReader(new StringReader(text)) { DateParseHandling = DateParseHandling.None })
                {
                    var token = JToken.ReadFrom(reader);

                    // Anything but a comment after the value is an error, as in JToken.Parse: the
                    // reader throws on it.
                    while (reader.Read())
                    {
                    }

                    return token;
                }
            }
            catch (JsonException)
            {
                // A non-JSON body (e.g. a raw log line) is still delivered, as a raw string.
                return new JValue(text);
            }
        }

        /// <summary>
        /// The app the handshake sends for the App Name <paramref name="appName"/>, which is the app the server
        /// puts this client in. Voice packets carry its hash as their app id, as the server relays voice only
        /// from the address of a Unity client of the packet's app.
        /// </summary>
        /// <remarks>Also used by VoiceServerConnection.</remarks>
        internal static string HandshakeAppName(string appName) => SanitizeHandshakeField(appName);

        /// <summary>
        /// Makes a device or app name safe to put in the handshake. '::' is the field separator, so a name
        /// containing one produces a frame the server rejects outright. A single ':' at either end is worse,
        /// because nothing rejects it: it merges with the separator next to it into ':::', which the server
        /// splits as '::' + ':', so app "app:" arrives as app "app" with the colon moved onto the client name,
        /// another app, silently.
        /// </summary>
        internal static string SanitizeHandshakeField(string value)
        {
            if (string.IsNullOrEmpty(value))
                return value;

            // After this there is no '::' left, so at most one ':' can remain at each end.
            var sanitized = value.Replace(FrameCodec.FieldSeparator, "_");

            if (sanitized[0] == ':')
                sanitized = "_" + sanitized.Substring(1);
            if (sanitized[sanitized.Length - 1] == ':')
                sanitized = sanitized.Substring(0, sanitized.Length - 1) + "_";

            return sanitized;
        }
    }
}
