using System;
using System.Collections.Generic;
using UnityEngine;
using Object = UnityEngine.Object;

namespace HCIKonstanz.Colibri.Synchronization
{
    /// <summary>
    /// The per-frame driver for every <see cref="SyncBehaviour{T}"/>: <c>Update</c> polls all synced
    /// attributes for changes, <c>LateUpdate</c> flushes each object's changes as a single message, so
    /// a frame's changes are all collected before any go out.
    /// </summary>
    /// <remarks>
    /// The flush applies the send-rate limit (<see cref="SyncSettings.MaxSendRate"/>) per object. Every
    /// registered object is flushed every frame, so held-back changes go out once the interval is up
    /// even if the object never changes again.
    /// </remarks>
    internal sealed class SyncTicker : MonoBehaviour
    {
        internal interface ITickable
        {
            /// <summary>
            /// Slot in the ticker's list, or -1 while unregistered. Owned by the ticker; implementations
            /// only store it, initialized to -1.
            /// </summary>
            int TickIndex { get; set; }

            void PollChanges();

            /// <param name="now">The ticker's clock, in seconds.</param>
            /// <param name="interval">
            /// The send-rate limit as an interval (1 / <see cref="SyncSettings.MaxSendRate"/>); 0 for no limit.
            /// </param>
            /// <param name="heardAt">
            /// When the server was last heard from, on the same clock. Anything sent after it may have gone
            /// into a dead link (see <see cref="SentValues"/>).
            /// </param>
            void FlushUpdate(double now, double interval, double heardAt);
        }

        private static readonly List<ITickable> _tickables = new List<ITickable>();
        private static bool _hasEmptySlots;
        private static SyncTicker _instance;

        // Objects whose exception was already logged, so one that fails every frame is reported once.
        private static readonly HashSet<ITickable> _reported = new HashSet<ITickable>();

        // Statics survive Play mode with domain reload disabled and would keep the previous session's
        // destroyed components.
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        private static void ResetState()
        {
            _tickables.Clear();
            _hasEmptySlots = false;
            _instance = null;
            _reported.Clear();

            DestroyStrayTickers();
        }

        // Removes tickers that survived an earlier Play session (HideFlags.DontSave does that). Each would
        // drive the same static list and send every update again.
        private static void DestroyStrayTickers()
        {
            foreach (var stray in Resources.FindObjectsOfTypeAll<SyncTicker>())
            {
                if (stray)
                    Destroy(stray.gameObject);
            }
        }

        // Objects being driven, skipping cleared slots that are not compacted yet. For tests.
        internal static int RegisteredCount
        {
            get
            {
                var count = 0;
                for (var i = 0; i < _tickables.Count; i++)
                {
                    if (_tickables[i] != null)
                        count++;
                }
                return count;
            }
        }

        internal static void Register(ITickable tickable)
        {
            if (tickable.TickIndex >= 0)
                return;

            // Nothing ticks outside Play mode, and ResetState would clear the entry while the object
            // still believes it is registered.
            if (!Application.isPlaying)
                return;

            EnsureInstance();
            tickable.TickIndex = _tickables.Count;
            _tickables.Add(tickable);
        }

        internal static void Deregister(ITickable tickable)
        {
            var index = tickable.TickIndex;
            if (index < 0)
                return;

            // Cleared, not removed: IsLive calls this from inside the tick loops, and RemoveAt would shift
            // their indices.
            _tickables[index] = null;
            tickable.TickIndex = -1;
            _hasEmptySlots = true;
            _reported.Remove(tickable);
        }

        private static void EnsureInstance()
        {
            if (_instance)
                return;

            // Not a SingletonBehaviour: that creates its GameObject on any Instance access, including
            // from an editor window.
            // No HideFlags: DontDestroyOnLoad already keeps it out of saved scenes, and HideFlags.DontSave
            // would survive Play mode (see DestroyStrayTickers).
            var go = new GameObject("[Colibri SyncTicker]");
            _instance = go.AddComponent<SyncTicker>();
            DontDestroyOnLoad(go);
        }

        // Takes a destroyed object off the list; one whose script hides SyncBehaviour's OnDestroy
        // never deregistered itself.
        private static bool IsLive(ITickable tickable)
        {
            if (tickable == null)
                return false;
            if (tickable is Object unityObject && !unityObject)
            {
                Deregister(tickable);
                if (tickable is ISyncedObject synced)
                    SyncedIds.Deregister(synced.RegisteredId ?? synced.Id);
                return false;
            }
            return true;
        }

        private static void Report(ITickable tickable, Exception exception)
        {
            if (!_reported.Add(tickable))
                return;
            var context = tickable as Object;
            Debug.LogError($"Colibri: syncing '{(context ? context.name : tickable.GetType().Name)}' failed. The other objects go on "
                + $"syncing. This is logged once per object.\n{exception}", context);
        }

        // Poll and Flush catch per object, so one that fails does not stop the objects after it.
        private static void Poll(ITickable tickable)
        {
            try
            {
                tickable.PollChanges();
            }
            catch (Exception exception)
            {
                Report(tickable, exception);
            }
        }

        private static void Flush(ITickable tickable, double now, double interval, double heardAt)
        {
            try
            {
                tickable.FlushUpdate(now, interval, heardAt);
            }
            catch (Exception exception)
            {
                Report(tickable, exception);
            }
        }

        private void Update()
        {
            // Index loop: tolerates Register/Deregister during the tick and allocates nothing.
            for (var i = 0; i < _tickables.Count; i++)
            {
                var tickable = _tickables[i];
                if (IsLive(tickable))
                    Poll(tickable);
            }
        }

        private void LateUpdate()
        {
            // Read once per frame so every object is flushed against the same clock, limit and last-heard time.
            // Unscaled so timeScale = 0 does not stop sending; double because a float stops resolving
            // milliseconds after days of runtime.
            var now = Time.unscaledTimeAsDouble;
            var interval = SyncSettings.SendInterval;
            var heardAt = Sync.LastHeardAt(now);

            for (var i = 0; i < _tickables.Count; i++)
            {
                var tickable = _tickables[i];
                if (IsLive(tickable))
                    Flush(tickable, now, interval, heardAt);
            }

            if (_hasEmptySlots)
                Compact();
        }

        // The messages below send what the rate limit still holds back before the app stops, so the clients
        // that stay do not see the object where it was a moment earlier. This object is always active,
        // unlike the synced ones, so it receives them for all of them.

        // Best effort: socket writes complete on a worker thread, and the connection's OnDisable waits only
        // briefly (QUIT_DRAIN_TIMEOUT_MS) for them before closing the socket, so an update can still be lost.
        private void OnApplicationQuit() => SendPendingChanges();

        // Android (Quest) may never call OnApplicationQuit: the app is paused, no further frame runs, and the
        // system may end the process later. Socket writes run on a worker thread, so what is handed to the
        // connection here goes out.
        private void OnApplicationPause(bool paused)
        {
            if (paused)
            {
                SendPendingChanges();
                PhysicsClient.SaveRun();
            }
        }

        // Unity documents focus loss as the exit signal on Android. It also fires while the app keeps
        // running (Quest system menu, another desktop window); the early send then only skips the limit once.
        private void OnApplicationFocus(bool focused)
        {
            if (!focused)
                SendPendingChanges();
        }

        /// <summary>
        /// Polls every object and sends its waiting update now, ignoring the send-rate limit.
        /// </summary>
        /// <remarks>
        /// Polls first: a change made after the ticker's Update (a later script, LateUpdate) would
        /// otherwise wait for a frame that may never come.
        /// </remarks>
        internal static void SendPendingChanges()
        {
            for (var i = 0; i < _tickables.Count; i++)
            {
                var tickable = _tickables[i];
                if (IsLive(tickable))
                    Poll(tickable);
            }

            var now = Time.unscaledTimeAsDouble;
            var heardAt = Sync.LastHeardAt(now);
            for (var i = 0; i < _tickables.Count; i++)
            {
                var tickable = _tickables[i];
                if (IsLive(tickable))
                    Flush(tickable, now, 0, heardAt);
            }
        }

        private static void Compact()
        {
            _hasEmptySlots = false;

            var write = 0;
            for (var read = 0; read < _tickables.Count; read++)
            {
                var tickable = _tickables[read];
                if (tickable == null)
                    continue;

                _tickables[write] = tickable;
                tickable.TickIndex = write;
                write++;
            }

            _tickables.RemoveRange(write, _tickables.Count - write);
        }
    }
}
