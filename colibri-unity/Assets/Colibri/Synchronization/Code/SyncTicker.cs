using System.Collections.Generic;
using UnityEngine;

namespace HCIKonstanz.Colibri.Synchronization
{
    /// <summary>
    /// The single per-frame driver behind every <see cref="SyncBehaviour{T}"/> in the scene.
    ///
    /// Change detection used to be one reactive subscription per synced attribute, i.e. five
    /// per <c>SyncTransform</c>. This is one <c>Update</c> and one <c>LateUpdate</c> for the
    /// whole application, no matter how many objects are synchronized: <c>Update</c> polls every
    /// synced attribute for changes, <c>LateUpdate</c> flushes each object's accumulated changes
    /// as a single message. Splitting the two guarantees that a frame's changes are all collected
    /// before any of them go out.
    ///
    /// The flush is also where the send-rate limit (<see cref="SyncSettings.MaxSendRate"/>) is
    /// applied, per object: every registered object is flushed in every frame, so changes it holds
    /// back go out once their interval is up even if the object never changes again.
    /// </summary>
    internal sealed class SyncTicker : MonoBehaviour
    {
        internal interface ITickable
        {
            /// <summary>
            /// Slot in the ticker's list, or -1 while unregistered. Owned by <see cref="SyncTicker"/>;
            /// implementations only have to store it and initialize it to -1.
            /// </summary>
            int TickIndex { get; set; }

            void PollChanges();

            /// <param name="now">The ticker's clock, in seconds.</param>
            /// <param name="interval">
            /// The send-rate limit as an interval, 1 / <see cref="SyncSettings.MaxSendRate"/>
            /// seconds; 0 for no limit.
            /// </param>
            /// <param name="heardAt">
            /// When this client last heard from the server, on the same clock: what is sent after
            /// it may be going into a link that has died (see <see cref="SentValues"/>).
            /// </param>
            void FlushUpdate(double now, double interval, double heardAt);
        }

        private static readonly List<ITickable> _tickables = new List<ITickable>();
        private static bool _hasEmptySlots;
        private static SyncTicker _instance;

        // Statics survive Play mode when domain reload is disabled, which would otherwise leave
        // the list full of destroyed components from the previous session.
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        private static void ResetState()
        {
            _tickables.Clear();
            _hasEmptySlots = false;
            _instance = null;

            DestroyStrayTickers();
        }

        /// <summary>
        /// Cleans up tickers left behind by an earlier Play session.
        /// </summary>
        /// <remarks>
        /// The ticker GameObject used to carry <c>HideFlags.DontSave</c>, which does not only keep
        /// it out of the saved scene - it also exempts it from being destroyed when Play mode ends.
        /// One survived every Play session, still enabled, and since they all drive the same static
        /// list, the *n*-th session ran PollChanges and FlushUpdate n times per frame: duplicate
        /// messages on the wire and a sync cost that grew every time the play button was pressed.
        /// The flag is gone, but a project that has already accumulated them needs them clearing,
        /// and they outlive a domain reload.
        /// </remarks>
        private static void DestroyStrayTickers()
        {
            foreach (var stray in Resources.FindObjectsOfTypeAll<SyncTicker>())
            {
                if (stray)
                    Destroy(stray.gameObject);
            }
        }

        /// <summary>
        /// How many objects the ticker is currently driving, ignoring slots that have been cleared
        /// but not yet compacted. Exists for the end-to-end suite: "one ticker" and "one entry per
        /// synced object" are the two halves of the leak that made the *n*-th Play session send
        /// every update n times, and neither is observable from the public API.
        /// </summary>
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

            // Nothing ticks outside Play mode, and registering there would leave an entry that
            // ResetState clears while the object still believes it is registered.
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

            // Cleared rather than removed: Deregister runs from OnDisable/OnDestroy, which can
            // happen in the middle of a tick, and RemoveAt would shift the indices under the loop.
            _tickables[index] = null;
            tickable.TickIndex = -1;
            _hasEmptySlots = true;
        }

        private static void EnsureInstance()
        {
            if (_instance)
                return;

            // Deliberately not a SingletonBehaviour: that one creates its GameObject on any
            // property access, including from an editor window.
            //
            // No HideFlags: DontDestroyOnLoad already keeps this out of any saved scene, and
            // HideFlags.DontSave additionally survives Play mode - see DestroyStrayTickers.
            var go = new GameObject("[Colibri SyncTicker]");
            _instance = go.AddComponent<SyncTicker>();
            DontDestroyOnLoad(go);
        }

        private void Update()
        {
            // Index loop over the raw list: no enumerator, no defensive copy, no allocation.
            for (var i = 0; i < _tickables.Count; i++)
                _tickables[i]?.PollChanges();
        }

        private void LateUpdate()
        {
            // Read once per frame, so every object is flushed against the same clock and limit,
            // and against the same moment the server was last heard from, which Sync notes on this
            // clock as it is asked here.
            // Unscaled, or a game paused with timeScale = 0 would stop sending; and the double,
            // which still resolves milliseconds after the app has been running for days.
            var now = Time.unscaledTimeAsDouble;
            var interval = SyncSettings.SendInterval;
            var heardAt = Sync.LastHeardAt(now);

            for (var i = 0; i < _tickables.Count; i++)
                _tickables[i]?.FlushUpdate(now, interval, heardAt);

            if (_hasEmptySlots)
                Compact();
        }

        /*
         *  The last changes before the app stops. The server keeps the objects for the clients
         *  that stay, so whatever the send-rate limit is still holding back - up to one interval
         *  of the last motion - has to go out now, or they keep the object where it was a moment
         *  earlier. This object is always active, which the synced objects themselves need not be,
         *  so it receives these messages for all of them.
         */

        /// <summary>
        /// Leaving Play mode or a desktop app. Unity sends this to every active object before it
        /// tears any of them down.
        /// </summary>
        /// <remarks>
        /// Best effort: this hands the updates to the connection, whose socket writes complete on
        /// a worker thread, and the connection closes its socket in its own OnDisable during the
        /// same teardown. An update can still be lost in between.
        /// </remarks>
        private void OnApplicationQuit() => SendPendingChanges();

        /// <summary>
        /// The way out on Android, and so on Quest, where Unity may never call OnApplicationQuit:
        /// taking the headset off or leaving the app pauses it, no further frame runs to send what
        /// is held, and the system may end the paused process later. The process is still alive
        /// while paused, and the socket writes run on a worker thread, so what is handed to the
        /// connection here does go out.
        /// </summary>
        private void OnApplicationPause(bool paused)
        {
            if (paused)
                SendPendingChanges();
        }

        /// <summary>
        /// Losing focus is what Unity's documentation says to rely on as the exit on Android. It
        /// also happens while the app goes on running - a Quest's system menu, another window
        /// clicked on a desktop - and then the early send has merely skipped the limit once.
        /// </summary>
        private void OnApplicationFocus(bool focused)
        {
            if (!focused)
                SendPendingChanges();
        }

        /// <summary>
        /// Polls every object and sends each one's waiting update now, whatever the send-rate
        /// limit says. Polled first, because a change made in this frame after the ticker's own
        /// Update - by a script that runs later, or in LateUpdate - would otherwise only be seen
        /// in a next frame that may never come.
        /// </summary>
        internal static void SendPendingChanges()
        {
            for (var i = 0; i < _tickables.Count; i++)
                _tickables[i]?.PollChanges();

            var now = Time.unscaledTimeAsDouble;
            var heardAt = Sync.LastHeardAt(now);
            for (var i = 0; i < _tickables.Count; i++)
                _tickables[i]?.FlushUpdate(now, 0, heardAt);
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
