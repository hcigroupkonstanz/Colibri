using UnityEngine;
using UnityEngine.Networking;
using System.Threading.Tasks;
using Cysharp.Threading.Tasks;

namespace HCIKonstanz.Colibri.Store
{
    public static class Store
    {
        public static async Task<T> Get<T>(string objectName)
        {
            var url = $"http://{SyncConfiguration.SERVER_IP}:9001/api/store/{SyncConfiguration.APP_NAME}/{objectName}";
            using (UnityWebRequest request = UnityWebRequest.Get(url))
            {
                request.method = UnityWebRequest.kHttpVerbGET;
                request.SetRequestHeader("Accept", "application/json");
                await request.SendWebRequest();
                if (!request.isNetworkError && request.responseCode == 200)
                {
                    return JsonUtility.FromJson<T>(request.downloadHandler.text);
                }
            }
            return default;
        }

        public static async Task<bool> Put(string objectName, object putObject)
        {
            string jsonData = JsonUtility.ToJson(putObject);
            var url = $"http://{SyncConfiguration.SERVER_IP}:9001/api/store/{SyncConfiguration.APP_NAME}/{objectName}";
            using (UnityWebRequest request = UnityWebRequest.Put(url, jsonData))
            {
                request.method = UnityWebRequest.kHttpVerbPUT;
                request.SetRequestHeader("Content-Type", "application/json");
                request.SetRequestHeader("Accept", "application/json");
                await request.SendWebRequest();
                if (!request.isNetworkError && (request.responseCode == 200 || request.responseCode == 201))
                {
                    return true;
                }
            }
            return false;
        }

        public static async Task<bool> Delete(string objectName)
        {
            var url = $"http://{SyncConfiguration.SERVER_IP}:9001/api/store/{SyncConfiguration.APP_NAME}/{objectName}";
            using (UnityWebRequest request = UnityWebRequest.Delete(url))
            {
                request.method = UnityWebRequest.kHttpVerbDELETE;
                request.SetRequestHeader("Content-Type", "application/json");
                await request.SendWebRequest();
                if (!request.isNetworkError && request.responseCode == 200)
                {
                    return true;
                }
            }
            return false;
        }
    }
}
