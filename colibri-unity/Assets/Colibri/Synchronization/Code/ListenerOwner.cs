using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using Object = UnityEngine.Object;

namespace HCIKonstanz.Colibri.Synchronization
{
    /// <summary>
    /// Works out which Unity object a listener belongs to, so that Colibri can drop the listener
    /// by itself once that object is destroyed.
    ///
    /// Forgetting the matching Sync.Unregister used to be the most expensive mistake in the whole
    /// API: the delegate keeps the destroyed MonoBehaviour alive, calling it touches `transform`
    /// or `gameObject` and throws MissingReferenceException, and that exception comes out of
    /// WebServerConnection.Update - taking every message still queued behind it that frame with
    /// it. One missing line in OnDestroy, and the connection appears to drop messages at random.
    ///
    /// A delegate written the usual way already says who owns it:
    ///
    ///   Sync.Receive&lt;float&gt;("Temperature", OnTemperature)   -> Target is the MonoBehaviour
    ///   Sync.Receive&lt;float&gt;("Temperature", v =&gt; label.text = ...) -> Target is a closure
    ///
    /// A method group hands over the instance directly. A lambda does not: the compiler hoists the
    /// captured variables into a generated class, and the enclosing MonoBehaviour is one of its
    /// fields (`&lt;&gt;4__this`). Reading that field is what lets lambdas be cleaned up too, and it
    /// happens once per registration, never per message.
    ///
    /// A static method or a listener owned by a plain C# object has no Unity lifetime to follow;
    /// it stays registered until Sync.Unregister is called, which is the only thing that could be
    /// meant by it.
    /// </summary>
    internal static class ListenerOwner
    {
        // The field a lambda's closure uses for the instance it was written in.
        private const string EnclosingThisField = "<>4__this";

        // A lambda inside a lambda inside a loop nests display classes. Three or four levels is
        // already more than anything a listener is plausibly written as; the limit only exists so
        // a pathological case cannot walk forever.
        private const int MaxClosureDepth = 4;

        private static readonly Dictionary<Type, FieldInfo[]> _closureFields = new Dictionary<Type, FieldInfo[]>();

        /// <summary>
        /// The Unity object whose destruction should also end this listener, or null if there
        /// isn't one.
        /// </summary>
        public static Object Of(Delegate listener)
        {
            var target = listener?.Target;

            // A static method belongs to nothing that can be destroyed.
            if (target == null)
                return null;

            if (target is Object unityTarget)
                return unityTarget;

            return FromClosure(target, MaxClosureDepth);
        }

        private static Object FromClosure(object closure, int depth)
        {
            if (depth <= 0)
                return null;

            var type = closure.GetType();
            if (!IsCompilerGenerated(type))
                return null;

            foreach (var field in CandidateFields(type))
            {
                var value = field.GetValue(closure);
                if (value == null)
                    continue;

                if (value is Object owner)
                    return owner;

                var nested = FromClosure(value, depth - 1);
                // ReferenceEquals, not ==: a nested owner that has already been destroyed is still
                // the answer, and Unity's == would report it as null and send the search onwards.
                if (!ReferenceEquals(nested, null))
                    return nested;
            }

            return null;
        }

        private static FieldInfo[] CandidateFields(Type closureType)
        {
            if (_closureFields.TryGetValue(closureType, out var cached))
                return cached;

            var fields = closureType
                .GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
                .Where(f => typeof(Object).IsAssignableFrom(f.FieldType) || IsCompilerGenerated(f.FieldType))
                // The instance the lambda was written in is the owner that was meant. Anything
                // else it happens to have captured is only a fallback, for a lambda written
                // outside a MonoBehaviour that still drives one.
                .OrderByDescending(f => f.Name == EnclosingThisField)
                .ToArray();

            _closureFields.Add(closureType, fields);
            return fields;
        }

        private static bool IsCompilerGenerated(Type type)
            => type.IsDefined(typeof(CompilerGeneratedAttribute), false);
    }
}
