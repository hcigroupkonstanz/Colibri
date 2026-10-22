using System;
using System.Collections.Generic;
using System.Linq;

namespace HCIKonstanz.Colibri.Synchronization
{
    /// <summary>
    /// Tracks which value types each channel has listeners for, so a value of an unexpected type can be reported.
    /// </summary>
    // No UnityEngine dependency, so it can be unit-tested directly.
    public static class ChannelListenerRegistry
    {
        // channel -> listener type -> number of listeners
        private static readonly Dictionary<string, Dictionary<Type, int>> _listenerTypes = new Dictionary<string, Dictionary<Type, int>>();

        // (channel, received type) pairs already reported, so a channel that keeps receiving does not flood the console.
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

            // A listener for this type exists now, so forget its earlier mismatch; a recurrence is reported again.
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

        // For tests.
        internal static int ListenerCount(string channel, Type listenerType)
            => _listenerTypes.TryGetValue(channel, out var types) && types.TryGetValue(listenerType, out var count)
                ? count
                : 0;

        /// <summary>The types the channel has listeners for, as display names.</summary>
        public static IEnumerable<string> ListenerTypesFor(string channel)
        {
            if (!_listenerTypes.TryGetValue(channel, out var types))
                return Enumerable.Empty<string>();

            return types.Keys.Select(FriendlyName).OrderBy(name => name);
        }

        /// <summary>
        /// Describes a value whose type no listener on the channel expects. False if the channel has no
        /// listeners or this mismatch was already reported.
        /// </summary>
        public static bool TryDescribeMismatch(string channel, Type receivedType, out string message)
        {
            message = null;

            // Normal: other clients broadcast on channels this one does not listen on.
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
            // "send it as int", not "send a int": the article cannot be chosen for every type.
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

        // Joined with \0 so channel and type name cannot run together.
        private static string MismatchKey(string channel, Type type) => channel + "\0" + type.FullName;

        /// <summary>Type name for messages, with C# keywords for bool, int, float and string.</summary>
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
