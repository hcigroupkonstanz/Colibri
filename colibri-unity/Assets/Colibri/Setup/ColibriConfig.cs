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

        public string ServerAddress = "colibri.hci.uni.kn";
        public string AppName = "";
    }
}
