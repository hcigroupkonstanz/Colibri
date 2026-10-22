using UnityEngine;

namespace HCIKonstanz.Colibri.Synchronization
{
    /// <summary>
    /// This client's id as physics owner (see <see cref="GenericSyncTransform{T}.PhysicsId"/>): new
    /// for each run, plus the previous run's id from PlayerPrefs.
    /// </summary>
    internal static class PhysicsClient
    {
        private const string PreviousRunKey = "Colibri.PhysicsClientId";

        private static string _id;
        private static string _previousRunId;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        internal static void ResetForPlaySession()
        {
            if (_id != null)
                Application.quitting -= SaveRun;
            _id = null;
            _previousRunId = null;
        }

        internal static string Id
        {
            get
            {
                if (_id == null)
                {
                    _previousRunId = PlayerPrefs.GetString(PreviousRunKey, "");
                    _id = System.Guid.NewGuid().ToString();
                    Application.quitting += SaveRun;
                }
                return _id;
            }
        }

        // Saved as the run ends, not at its start: a second instance on the same machine (another
        // Editor on a copy of the project) would read the live id of the first as its previous run.
        // Also called on pause, since Android does not report quitting reliably.
        internal static void SaveRun()
        {
            if (_id == null)
                return;
            PlayerPrefs.SetString(PreviousRunKey, _id);
            PlayerPrefs.Save();
        }

        internal static bool WasPreviousRun(string id)
        {
            _ = Id; // loads the previous run's id
            return !string.IsNullOrEmpty(id) && id == _previousRunId;
        }
    }
}
