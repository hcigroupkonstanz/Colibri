using System;
using System.Collections.Generic;
using UnityEngine;

namespace HCIKonstanz.Colibri.Synchronization
{
    // Traffic log for the Colibri Status window. The buffer and the calls that fill it are compiled out of
    // release builds.
    internal static class TrafficLog
    {
#if UNITY_EDITOR || DEVELOPMENT_BUILD
        private const int LogSize = 20;

        private const float DefaultRetentionSeconds = 10f;

        /// <summary>
        /// How long an entry stays in the log, so an idle channel empties out instead of showing the last messages with
        /// ever-growing ages. Settable for the test suite.
        /// </summary>
        internal static float RetentionSeconds = DefaultRetentionSeconds;

        private static readonly Sync.TrafficEntry[] _entries = new Sync.TrafficEntry[LogSize];
        private static int _count;

        // With domain reload disabled the log survives Play mode, and realtimeSinceStartup keeps running in edit mode,
        // so the next session would start with the last one's messages, dated from before it began.
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        private static void Reset()
        {
            Array.Clear(_entries, 0, _entries.Length);
            _count = 0;
            RetentionSeconds = DefaultRetentionSeconds;
        }

        /// <summary>
        /// The most recent messages sent and received, newest first, dropping anything older
        /// than <see cref="RetentionSeconds"/>.
        /// </summary>
        internal static IEnumerable<Sync.TrafficEntry> RecentTraffic
        {
            get
            {
                var oldest = Time.realtimeSinceStartup - RetentionSeconds;
                var count = Math.Min(_count, LogSize);

                for (var i = 1; i <= count; i++)
                {
                    var entry = _entries[(_count - i) % LogSize];

                    // Newest first: once one is past the window, all the rest are older still.
                    if (entry.Time < oldest)
                        yield break;

                    yield return entry;
                }
            }
        }
#endif

        [System.Diagnostics.Conditional("UNITY_EDITOR"), System.Diagnostics.Conditional("DEVELOPMENT_BUILD")]
        internal static void Record(bool incoming, string channel, string command)
        {
#if UNITY_EDITOR || DEVELOPMENT_BUILD
            _entries[_count % LogSize] = new Sync.TrafficEntry
            {
                Incoming = incoming,
                Channel = channel,
                Command = command,
                Time = Time.realtimeSinceStartup
            };
            _count++;
#endif
        }
    }
}
