using UnityEngine;
using UnityEngine.Networking;
using System.Threading.Tasks;
using HCIKonstanz.Colibri.Setup;
using HCIKonstanz.Colibri.Synchronization;
using Newtonsoft.Json;

namespace HCIKonstanz.Colibri.Store
{
    public static class Store
    {
        /// <summary>
        /// UnityWebRequest defaults to no timeout at all, so a wrong or unreachable server
        /// address left Get/Put/Delete outstanding forever - no result, no error, nothing in
        /// the console. An unconfigured project reaches the public default server, where this
        /// was observed to still be waiting after a minute. Ten seconds is long enough for a
        /// slow link and short enough that the failure is reported while the developer is still
        /// looking at it.
        /// </summary>
        private const int TimeoutSeconds = 10;

        /// <summary>
        /// Newtonsoft with Colibri's converters, so a Vector3, Quaternion or Color in a saved
        /// class converts - see <see cref="ColibriJson"/>.
        /// </summary>
        private static readonly JsonSerializerSettings JsonSettings = ColibriJson.CreateSettings();

        /// <summary>
        /// Awaits a UnityWebRequest without pulling in a third-party awaiter.
        /// </summary>
        /// <remarks>
        /// Deliberately *not* created with TaskCreationOptions.RunContinuationsAsynchronously:
        /// UnityWebRequestAsyncOperation raises `completed` on the main thread, and completing the
        /// task inline is what keeps the caller's code after `await` on the main thread too. Unlike
        /// the UniTask awaiter this never throws - the caller checks `request.result` instead.
        /// </remarks>
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

        /// <summary>
        /// The path of <paramref name="objectName"/> in the store of <paramref name="appName"/>.
        /// Each is one path segment, escaped as colibri-web escapes them (encodeURIComponent), so
        /// that both clients address the same entry. Pasted in as they were, a '/' in a key made a
        /// path the server has no route for, a '#' cut the key off there, and a '?' turned the
        /// rest into a query string: Store.Put("round#2", ...) wrote the key "round".
        /// </summary>
        /// <remarks>
        /// Uri.EscapeDataString also escapes ! * ' ( ), which encodeURIComponent leaves as they
        /// are. The server decodes both forms to the same key.
        /// </remarks>
        internal static string StorePath(string appName, string objectName)
            => $"api/store/{System.Uri.EscapeDataString(appName ?? "")}/{System.Uri.EscapeDataString(objectName ?? "")}";

        private static string Url(string objectName) => ColibriConfig.GetWebUrl(StorePath(ColibriConfig.Load().AppName, objectName));

        public static async Task<T> Get<T>(string objectName)
        {
            var url = Url(objectName);
            using (UnityWebRequest request = UnityWebRequest.Get(url))
            {
                request.method = UnityWebRequest.kHttpVerbGET;
                request.timeout = TimeoutSeconds;
                request.certificateHandler = ServerCertificateHandler.For(ColibriConfig.Load());
                request.SetRequestHeader("Accept", "application/json");
                await SendAsync(request);

                if (request.result == UnityWebRequest.Result.Success && request.responseCode == 200)
                    return TryFromJson<T>(objectName, request.downloadHandler.text, out var value) ? value : default;

                LogFailure("load", objectName, request, url);
            }
            return default;
        }

        public static async Task<bool> Put(string objectName, object putObject)
        {
            if (!TryToJson(objectName, putObject, out var jsonData))
                return false;

            var url = Url(objectName);
            using (UnityWebRequest request = UnityWebRequest.Put(url, jsonData))
            {
                request.method = UnityWebRequest.kHttpVerbPUT;
                request.timeout = TimeoutSeconds;
                request.certificateHandler = ServerCertificateHandler.For(ColibriConfig.Load());
                request.SetRequestHeader("Content-Type", "application/json");
                request.SetRequestHeader("Accept", "application/json");
                await SendAsync(request);

                if (request.result == UnityWebRequest.Result.Success && (request.responseCode == 200 || request.responseCode == 201))
                    return true;

                LogFailure("save", objectName, request, url);
            }
            return false;
        }

        public static async Task<bool> Delete(string objectName)
        {
            var url = Url(objectName);
            using (UnityWebRequest request = UnityWebRequest.Delete(url))
            {
                request.method = UnityWebRequest.kHttpVerbDELETE;
                request.timeout = TimeoutSeconds;
                request.certificateHandler = ServerCertificateHandler.For(ColibriConfig.Load());
                request.SetRequestHeader("Content-Type", "application/json");
                await SendAsync(request);

                if (request.result == UnityWebRequest.Result.Success && request.responseCode == 200)
                    return true;

                LogFailure("delete", objectName, request, url);
            }
            return false;
        }


        /*
         *  Conversion. Newtonsoft rather than JsonUtility: JsonUtility cannot round-trip
         *  dictionaries, properties, or top-level arrays, so Get/Put silently disagreed with
         *  everything Sync can carry.
         *
         *  A value Newtonsoft cannot convert used to throw a JsonException out of Put, or out of
         *  Get after a successful request - past the await, into code written against a Store
         *  that reports a failure and returns false or default. Now it does exactly that. An
         *  exception thrown by the class itself - its constructor, a callback - still comes
         *  through, with its own stack trace.
         */

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

            // No backtick on a type nested in a generic one, which is generic all the same.
            var tick = type.Name.IndexOf('`');
            var name = tick < 0 ? type.Name : type.Name.Substring(0, tick);
            return $"{name}<{string.Join(", ", System.Array.ConvertAll(type.GetGenericArguments(), TypeName))}>";
        }
    }
}
