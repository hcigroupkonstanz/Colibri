using UnityEngine;

namespace HCIKonstanz.Colibri.Setup
{
    public class ColibriConfig : ScriptableObject
    {
        public static readonly string CONFIG_NAME = "ColibriConfig.asset";

        private static ColibriConfig _instance;
        public static ColibriConfig Load()
        {
            if (!_instance)
                _instance = Resources.Load<ColibriConfig>("ColibriConfig");
            return _instance;
        }

        public string AppName = "";
        public string ServerAddress = "colibri.hci.uni-konstanz.de";
        public int WebServerPort = 9011;
        public int TcpServerPort = 9012;
        public int VoiceServerPort = 9013;
        public bool IsSSL = true;

        /// <summary>
        /// Generates a URL for the WebRequest
        /// </summary>
        /// <param name="endpoint">Server Endpoint. Not leading slash (/) required</param>
        /// <returns></returns>
        public static string GetWebUrl(string endpoint)
        {
            var config = Load();
            var protocol = config.IsSSL ? "https" : "http";
            endpoint = endpoint.TrimStart('/'); // remove leading slash

            var uri = $"{protocol}://{config.ServerAddress}:{config.WebServerPort}/{endpoint}";
            Debug.Log($"URI: {uri}");
            return uri;
        }
    }
}
