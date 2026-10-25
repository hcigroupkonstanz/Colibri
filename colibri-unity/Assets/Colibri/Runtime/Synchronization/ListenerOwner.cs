using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using Object = UnityEngine.Object;

namespace HCIKonstanz.Colibri.Synchronization
{
    /// <summary>
    /// Finds the Unity object a listener belongs to, so it can be dropped once that object is destroyed.
    /// </summary>
    // A method group's Target is the instance. A lambda that captures locals has a compiler-generated
    // closure as Target, whose `<>4__this` field holds the enclosing instance; read once per registration.
    // A listener with no Unity object behind it (static method, plain C# object, lambda over plain locals)
    // has no owner and stays registered until Sync.Unregister.
    internal static class ListenerOwner
    {
        private const string EnclosingThisField = "<>4__this";

        // Closures of nested scopes reference each other; bounds the recursion.
        private const int MaxClosureDepth = 4;

        private static readonly Dictionary<Type, FieldInfo[]> _closureFields = new Dictionary<Type, FieldInfo[]>();

        /// <summary>The Unity object whose destruction ends this listener, or null.</summary>
        public static Object Of(Delegate listener)
        {
            var target = listener?.Target;

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
                // ReferenceEquals: a destroyed nested owner is still the answer.
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
                // The enclosing instance first; any other captured Unity object is a fallback (lambda written outside a MonoBehaviour).
                .OrderByDescending(f => f.Name == EnclosingThisField)
                .ToArray();

            _closureFields.Add(closureType, fields);
            return fields;
        }

        private static bool IsCompilerGenerated(Type type)
            => type.IsDefined(typeof(CompilerGeneratedAttribute), false);
    }
}
