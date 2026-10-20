using UnityEngine;
using UnityEngine.Networking;
using System.Threading.Tasks;
using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Setup;
using HCIKonstanz.Colibri.Synchronization;
using Newtonsoft.Json;

namespace HCIKonstanz.Colibri.Store
{
    /// <summary>
    /// Reads, writes and deletes JSON values in the server's REST store, in the app of the Colibri configuration.
    /// </summary>
    public static class Store
    {
        // UnityWebRequest has no timeout by default, so an unreachable server would leave a request pending forever.
        private const int TimeoutSeconds = 10;

        // Colibri's converters for Vector2/3/4, Quaternion and Color.
        private static readonly JsonSerializerSettings JsonSettings = ColibriJson.CreateSettings();

        // Sent as Accept on every request and as Content-Type on Put. colibri-server 2.x refuses a value as
        // plain application/json; a reverse proxy can route by the Accept header.
        internal static string MediaType => $"application/vnd.colibri.v{WebServerConnection.ClientVersion}+json";

        // No RunContinuationsAsynchronously: `completed` fires on the main thread and completing inline
        // resumes the caller there. The task never faults; the caller checks request.result.
        private static Task SendAsync(UnityWebRequest request)
        {
            var tcs = new TaskCompletionSource<bool>();
            request.SendWebRequest().completed += _ => tcs.TrySetResult(true);
            return tcs.Task;
        }

        private static void LogFailure(string action, string objectName, UnityWebRequest request, string url)
        {
            Debug.LogError($"Colibri: could not {action} \"{objectName}\" at {url} - {request.error} (HTTP {request.responseCode}). Check the server address and app name in Window -> Colibri Configuration.");
        }

        // Each name is one path segment, escaped like colibri-web's encodeURIComponent so '/', '#' and '?'
        // stay part of the key. EscapeDataString also escapes ! * ' ( ); the server decodes both to the same key.
        internal static string StorePath(string appName, string objectName)
            => $"api/store/{System.Uri.EscapeDataString(appName ?? "")}/{System.Uri.EscapeDataString(objectName ?? "")}";

        private static string Url(string objectName) => ColibriConfig.GetWebUrl(StorePath(ColibriConfig.Load().App, objectName));

        // The key as colibri-web normalizes it: surrounding whitespace and leading slashes removed.
        // Null for "", "." and "..", which a URL parser resolves as directory steps (Delete("") would hit the app).
        internal static string KeyName(string objectName)
        {
            var name = (objectName ?? "").Trim().TrimStart('/');
            return name.Length == 0 || name == "." || name == ".." ? null : name;
        }

        private static bool TryKeyName(string action, string objectName, out string name)
        {
            name = KeyName(objectName);
            if (name == null)
                Debug.LogError($"Colibri: could not {action} \"{objectName}\" - a name must not be empty, \".\" or \"..\".");
            return name != null;
        }

        /// <summary>
        /// Loads the value stored under <paramref name="objectName"/>. Logs an error and returns default if there is no such value or it cannot be loaded.
        /// </summary>
        public static async Task<T> Get<T>(string objectName)
        {
            if (!TryKeyName("load", objectName, out objectName))
                return default;
            var url = Url(objectName);
            using (UnityWebRequest request = UnityWebRequest.Get(url))
            {
                request.method = UnityWebRequest.kHttpVerbGET;
                request.timeout = TimeoutSeconds;
                request.certificateHandler = ServerCertificateHandler.For(ColibriConfig.Load());
                request.SetRequestHeader("Accept", MediaType);
                await SendAsync(request);

                if (request.result == UnityWebRequest.Result.Success && request.responseCode == 200)
                    return TryFromJson<T>(objectName, request.downloadHandler.text, out var value) ? value : default;

                LogFailure("load", objectName, request, url);
            }
            return default;
        }

        /// <summary>
        /// Stores <paramref name="putObject"/> as JSON under <paramref name="objectName"/>. Logs an error and returns false on failure.
        /// </summary>
        public static async Task<bool> Put(string objectName, object putObject)
        {
            if (!TryKeyName("save", objectName, out objectName))
                return false;
            if (!TryToJson(objectName, putObject, out var jsonData))
                return false;

            var url = Url(objectName);
            using (UnityWebRequest request = UnityWebRequest.Put(url, jsonData))
            {
                request.method = UnityWebRequest.kHttpVerbPUT;
                request.timeout = TimeoutSeconds;
                request.certificateHandler = ServerCertificateHandler.For(ColibriConfig.Load());
                request.SetRequestHeader("Content-Type", MediaType);
                request.SetRequestHeader("Accept", MediaType);
                await SendAsync(request);

                if (request.result == UnityWebRequest.Result.Success && (request.responseCode == 200 || request.responseCode == 201))
                    return true;

                LogFailure("save", objectName, request, url);
            }
            return false;
        }

        /// <summary>
        /// Deletes the value stored under <paramref name="objectName"/>. Logs an error and returns false on failure.
        /// </summary>
        public static async Task<bool> Delete(string objectName)
        {
            if (!TryKeyName("delete", objectName, out objectName))
                return false;
            var url = Url(objectName);
            using (UnityWebRequest request = UnityWebRequest.Delete(url))
            {
                request.method = UnityWebRequest.kHttpVerbDELETE;
                request.timeout = TimeoutSeconds;
                request.certificateHandler = ServerCertificateHandler.For(ColibriConfig.Load());
                request.SetRequestHeader("Accept", MediaType);
                await SendAsync(request);

                if (request.result == UnityWebRequest.Result.Success && request.responseCode == 200)
                    return true;

                LogFailure("delete", objectName, request, url);
            }
            return false;
        }

        // Newtonsoft instead of JsonUtility, which cannot round-trip dictionaries, properties or top-level arrays.
        // A JsonException is logged and reported as false/default; no other exception is caught.

        internal static bool TryToJson(string objectName, object value, out string json)
        {
            try
            {
                json = JsonConvert.SerializeObject(value, JsonSettings);
                return true;
            }
            catch (JsonException e)
            {
                Debug.LogError($"Colibri: could not save \"{objectName}\" - {TypeName(value?.GetType())} cannot be converted to JSON: {e.Message}");
                json = null;
                return false;
            }
        }

        internal static bool TryFromJson<T>(string objectName, string json, out T value)
        {
            try
            {
                value = JsonConvert.DeserializeObject<T>(json, JsonSettings);
                return true;
            }
            catch (JsonException e)
            {
                Debug.LogError($"Colibri: could not load \"{objectName}\" as {TypeName(typeof(T))} - what the server holds does not fit it: {e.Message}");
                value = default;
                return false;
            }
        }

        /// <summary>"List&lt;Score&gt;" rather than "List`1".</summary>
        private static string TypeName(System.Type type)
        {
            if (type == null)
                return "null";
            if (!type.IsGenericType)
                return type.Name;

            // A type nested in a generic one is generic but has no backtick in its name.
            var tick = type.Name.IndexOf('`');
            var name = tick < 0 ? type.Name : type.Name.Substring(0, tick);
            return $"{name}<{string.Join(", ", System.Array.ConvertAll(type.GetGenericArguments(), TypeName))}>";
        }
    }
}
