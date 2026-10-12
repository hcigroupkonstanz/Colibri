using System.Collections.Generic;
using UnityEngine;

namespace HCIKonstanz.Colibri.Synchronization
{
    /// <summary>
    /// The models this client deleted itself in the last <see cref="WindowSeconds"/>, by channel
    /// and id, so that a <see cref="SyncBehaviourManager{T}"/> does not build them again.
    /// </summary>
    /// <remarks>
    /// <para>
    /// While this client deletes an object, another one may still be moving it. An update that
    /// client sent before the server had the delete is relayed here as well, and arrives after
    /// the object is gone. The manager no longer knew the id, so it built the object again from
    /// its template, with the template's values for every member the update did not carry. Every
    /// other client receives that update before the delete, on the same connection, so it reaches
    /// their copy while the copy still exists.
    /// </para>
    /// <para>
    /// Remembered for a while rather than for good: once the updates from before the delete have
    /// arrived, an update for that id means the id is in use again, say a scene with placed objects
    /// of fixed ids loaded on another client. One created on this client again is forgotten at once,
    /// in its Awake. Only deletes this client sent are remembered: one it receives arrives after
    /// every update relayed before it.
    /// </para>
    /// </remarks>
    internal static class LocallyDeletedModels
    {
        internal const double DefaultWindowSeconds = 60;

        /// <summary>How long a delete is remembered. Settable for the test suite.</summary>
        internal static double WindowSeconds = DefaultWindowSeconds;

        private static readonly Dictionary<(string Channel, string Id), double> _deletedAt
            = new Dictionary<(string Channel, string Id), double>();

        // The same deletes in the order they were made, which is the order they expire in, so
        // expiring them costs nothing per delete however many objects a scene unload deletes.
        private static readonly Queue<((string Channel, string Id) Key, double At)> _byAge
            = new Queue<((string Channel, string Id) Key, double At)>();

        /// <summary>
        /// A Play session starts with nothing remembered. With domain reload disabled these
        /// survive from one session to the next, and the clock starts again from zero.
        /// </summary>
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

            // A clock behind the delete has been reset since, which no remembered delete outlives.
            if (now - at < WindowSeconds && now >= at)
                return true;

            _deletedAt.Remove((channel, id));
            return false;
        }

        /// <summary>The deletes remembered now, expired ones included until the next Remember.</summary>
        internal static int Count => _deletedAt.Count;

        /// <summary>
        /// The deletes made at or after <paramref name="since"/> and remembered still at
        /// <paramref name="now"/>, oldest first; null if there are none. See Sync's OnDisconnected,
        /// which sends them again.
        /// </summary>
        internal static List<(string Channel, string Id)> Since(double since, double now)
        {
            List<(string Channel, string Id)> deletes = null;
            foreach (var (key, at) in _byAge)
            {
                // As in Contains: one older than the window, or one a clock behind it has been reset
                // since, is not remembered any more, though it stays queued until the next Remember.
                if (at < since || now - at >= WindowSeconds || now < at)
                    continue;

                // A delete remembered again later has an entry of its own, and a forgotten one has
                // none left.
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

                // Only if nothing has remembered or forgotten the id since: a delete of the same
                // id remembered again later has its own, younger entry in the queue.
                if (_deletedAt.TryGetValue(oldest.Key, out var at) && at == oldest.At)
                    _deletedAt.Remove(oldest.Key);
            }
        }
    }
}
