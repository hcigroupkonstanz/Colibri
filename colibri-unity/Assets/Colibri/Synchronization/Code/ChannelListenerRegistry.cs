using System;
using System.Collections.Generic;
using System.Linq;

namespace HCIKonstanz.Colibri.Synchronization
{
    /// <summary>
    /// Remembers which value types each channel currently has listeners for.
    ///
    /// Colibri routes messages by (channel, type). Sending a float on a channel where the only
    /// listener expects a string is the single most common mistake when getting started, and it
    /// used to be completely silent - the message simply found no matching listener list and was
    /// dropped. This registry is what lets that case be reported instead.
    ///
    /// Deliberately free of any UnityEngine dependency, so it can be unit-tested directly.
    /// </summary>
    public static class ChannelListenerRegistry
    {
        // channel -> type -> number of listeners registered for it
        private static readonly Dictionary<string, Dictionary<Type, int>> _listenerTypes = new Dictionary<string, Dictionary<Type, int>>();

        // (channel, received type) pairs already reported, so a mismatch on a channel that keeps
        // receiving does not flood the console once per message.
        private static readonly HashSet<string> _reportedMismatches = new HashSet<string>();

        /// <summary>Every channel that currently has at least one listener.</summary>
        public static IEnumerable<string> Channels => _listenerTypes.Keys;

        public static void Add(string channel, Type listenerType)
        {
            if (!_listenerTypes.TryGetValue(channel, out var types))
            {
                types = new Dictionary<Type, int>();
                _listenerTypes.Add(channel, types);
            }

            types.TryGetValue(listenerType, out var count);
            types[listenerType] = count + 1;

            // A listener for this type now exists, so an earlier mismatch may well be fixed.
            _reportedMismatches.Remove(MismatchKey(channel, listenerType));
        }

        public static void Remove(string channel, Type listenerType)
        {
            if (!_listenerTypes.TryGetValue(channel, out var types))
                return;

            if (!types.TryGetValue(listenerType, out var count))
                return;

            if (count > 1)
                types[listenerType] = count - 1;
            else
                types.Remove(listenerType);

            if (types.Count == 0)
                _listenerTypes.Remove(channel);
        }

        /// <summary>
        /// How many listeners the channel currently has for the given type. A test seam: it is the
        /// only way to tell one live listener from one live listener still counted alongside a
        /// destroyed one.
        /// </summary>
        internal static int ListenerCount(string channel, Type listenerType)
            => _listenerTypes.TryGetValue(channel, out var types) && types.TryGetValue(listenerType, out var count)
                ? count
                : 0;

        /// <summary>The types the given channel has listeners for, in a form worth showing a human.</summary>
        public static IEnumerable<string> ListenerTypesFor(string channel)
        {
            if (!_listenerTypes.TryGetValue(channel, out var types))
                return Enumerable.Empty<string>();

            return types.Keys.Select(FriendlyName).OrderBy(name => name);
        }

        /// <summary>
        /// Produces a message for a value that arrived on a channel whose listeners all expect a
        /// different type. Returns false when there is nothing worth saying: either no listener is
        /// registered on the channel at all (perfectly normal - other clients broadcast on channels
        /// this one does not care about) or this exact mismatch has already been reported.
        /// </summary>
        public static bool TryDescribeMismatch(string channel, Type receivedType, out string message)
        {
            message = null;

            if (!_listenerTypes.TryGetValue(channel, out var types) || types.Count == 0)
                return false;

            if (types.ContainsKey(receivedType))
                return false;

            if (!_reportedMismatches.Add(MismatchKey(channel, receivedType)))
                return false;

            var received = FriendlyName(receivedType);
            var expected = string.Join(", ", types.Keys.Select(FriendlyName).OrderBy(name => name));
            var expectation = types.Count == 1
                ? $"the listener registered there expects {expected}"
                : $"the listeners registered there expect {expected}";
            // "send it as int" rather than "send a int" - the article cannot be picked correctly
            // for every supported type, and "a Vector3[]" reads no better than "a int".
            var alternative = types.Count == 1
                ? $"send it as {expected}"
                : $"send it as one of {expected}";

            message = $"Colibri: a {received} arrived on channel '{channel}', but {expectation}. The message was dropped, because Colibri matches messages on the channel *and* the type. "
                    + $"Either {alternative}, or listen for it with Sync.Receive<{received}>(\"{channel}\", MyHandler).";
            return true;
        }

        public static void Clear()
        {
            _listenerTypes.Clear();
            _reportedMismatches.Clear();
        }

        // Separated by \0, which no channel name can contain, so the two halves cannot run together.
        private static string MismatchKey(string channel, Type type) => channel + "\0" + type.FullName;

        /// <summary>C# keyword spellings, because code declares a "float", not a "Single".</summary>
        public static string FriendlyName(Type type)
        {
            if (type.IsArray)
                return FriendlyName(type.GetElementType()) + "[]";

            if (type == typeof(bool)) return "bool";
            if (type == typeof(int)) return "int";
            if (type == typeof(float)) return "float";
            if (type == typeof(string)) return "string";

            return type.Name;
        }
    }
}
