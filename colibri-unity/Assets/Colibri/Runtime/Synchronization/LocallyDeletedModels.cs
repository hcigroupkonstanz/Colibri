using System.Collections.Generic;
using UnityEngine;

namespace HCIKonstanz.Colibri.Synchronization
{
    /// <summary>
    /// The models this client deleted itself in the last <see cref="WindowSeconds"/>, by channel
    /// and id, so that a <see cref="SyncBehaviourManager{T}"/> does not build them again.
    /// </summary>
    /// <remarks>
    /// A remote update sent before the server had this client's delete arrives after the object is
    /// gone, and the manager would build it again from its template. A delete received from the
    /// server comes after every update relayed before it, so only deletes this client sent are
    /// remembered.
    /// Remembered only for the window: after it, an update for the id means the id is in use again,
    /// e.g. a scene with placed objects of fixed ids loaded on another client. An object created
    /// here with the id again forgets it in its Awake.
    /// </remarks>
    internal static class LocallyDeletedModels
    {
        internal const double DefaultWindowSeconds = 60;

        /// <summary>How long a delete is remembered. Settable for the test suite.</summary>
        internal static double WindowSeconds = DefaultWindowSeconds;

        private static readonly Dictionary<(string Channel, string Id), double> _deletedAt
            = new Dictionary<(string Channel, string Id), double>();

        // The same deletes oldest first, so Expire stops at the first one still in the window.
        private static readonly Queue<((string Channel, string Id) Key, double At)> _byAge
            = new Queue<((string Channel, string Id) Key, double At)>();

        /// <summary>Resets all state at the start of a Play session; statics survive with domain reload disabled.</summary>
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        internal static void Reset()
        {
            _deletedAt.Clear();
            _byAge.Clear();
            WindowSeconds = DefaultWindowSeconds;
        }

        private static double Now => Time.unscaledTimeAsDouble;

        internal static void Remember(string channel, string id) => Remember(channel, id, Now);

        internal static void Remember(string channel, string id, double now)
        {
            Expire(now);

            var key = (channel, id);
            _deletedAt[key] = now;
            _byAge.Enqueue((key, now));
        }

        internal static void Forget(string channel, string id) => _deletedAt.Remove((channel, id));

        internal static bool Contains(string channel, string id) => Contains(channel, id, Now);

        internal static bool Contains(string channel, string id, double now)
        {
            if (!_deletedAt.TryGetValue((channel, id), out var at))
                return false;

            // now < at: the clock restarted since the delete, so it no longer counts.
            if (now - at < WindowSeconds && now >= at)
                return true;

            _deletedAt.Remove((channel, id));
            return false;
        }

        /// <summary>The remembered deletes; expired ones are counted until the next Remember.</summary>
        internal static int Count => _deletedAt.Count;

        /// <summary>
        /// The deletes made at or after <paramref name="since"/> and still remembered at
        /// <paramref name="now"/>, oldest first; null if there are none. Sync.OnDisconnected
        /// sends them again.
        /// </summary>
        internal static List<(string Channel, string Id)> Since(double since, double now)
        {
            List<(string Channel, string Id)> deletes = null;
            foreach (var (key, at) in _byAge)
            {
                // Expired as in Contains, but still queued until the next Remember.
                if (at < since || now - at >= WindowSeconds || now < at)
                    continue;

                // Skip entries superseded by a later Remember or removed by Forget.
                if (_deletedAt.TryGetValue(key, out var latest) && latest == at)
                    (deletes ??= new List<(string Channel, string Id)>()).Add(key);
            }
            return deletes;
        }

        private static void Expire(double now)
        {
            while (_byAge.Count > 0)
            {
                var oldest = _byAge.Peek();
                if (now - oldest.At < WindowSeconds && now >= oldest.At)
                    return;

                _byAge.Dequeue();

                // Keep it if the id was remembered again since; its younger queue entry expires it.
                if (_deletedAt.TryGetValue(oldest.Key, out var at) && at == oldest.At)
                    _deletedAt.Remove(oldest.Key);
            }
        }
    }
}
