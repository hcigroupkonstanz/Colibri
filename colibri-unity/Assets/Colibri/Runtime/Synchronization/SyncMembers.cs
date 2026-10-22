using System;
using System.Collections.Generic;
#if !ENABLE_IL2CPP
using System.Linq.Expressions;
#endif
using System.Reflection;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace HCIKonstanz.Colibri.Synchronization
{
    internal static class SyncMembers<T>
        where T : SyncBehaviour<T>
    {
        private const string SupportedTypes = "bool, int, float, string, Vector2, Vector3, Quaternion, Color, JObject and arrays of those";

        // Attribute metadata, built once per type. Typed throughout, so the change comparison never boxes.

        internal interface IChangeTracker
        {
            /// <summary>Latches the current value; true if it differs from the one latched before.</summary>
            bool CaptureChange(T target);

            /// <summary>Latches the current value without reporting it as a change.</summary>
            void Latch(T target);
        }

        internal abstract class SyncedAttribute
        {
            public string Name;

            /// <summary>The C# name, which <see cref="SyncBehaviour{T}.IsSynced"/> is asked about.</summary>
            public string MemberName;

            public int Index;
            public Type PropertyType;

            /// <summary>Boxes, so only call it for a value that is about to be sent.</summary>
            public abstract object GetBoxed(T target);
            public abstract void SetBoxed(T target, object value);
            public abstract IChangeTracker CreateTracker(T target);
        }

        private sealed class SyncedAttribute<TValue> : SyncedAttribute
        {
            public Func<T, TValue> Getter;
            public Action<T, TValue> Setter;

            public override object GetBoxed(T target) => Getter(target);
            public override void SetBoxed(T target, object value) => Setter(target, (TValue)value);
            public override IChangeTracker CreateTracker(T target) => new ChangeTracker<TValue>(Getter, target);
        }

        private sealed class ChangeTracker<TValue> : IChangeTracker
        {
            private static readonly Func<TValue, TValue, bool> AreEqual = SyncValues.EqualityFor<TValue>();
            private static readonly Func<TValue, TValue> Keep = SyncValues.CopyFor<TValue>();

            private readonly Func<T, TValue> _getter;
            private TValue _lastValue;

            public ChangeTracker(Func<T, TValue> getter, T target)
            {
                _getter = getter;
                _lastValue = Keep(getter(target));
            }

            public bool CaptureChange(T target)
            {
                var current = _getter(target);

                // Compared as on the wire (see SyncValues). Value types use EqualityComparer<TValue>.Default,
                // which does not box.
                if (AreEqual(current, _lastValue))
                    return false;

                _lastValue = Keep(current);
                return true;
            }

            public void Latch(T target)
            {
                _lastValue = Keep(_getter(target));
            }
        }


        internal static readonly Dictionary<string, SyncedAttribute> SyncedAttributes = new Dictionary<string, SyncedAttribute>();
        internal static readonly List<SyncedAttribute> AttributeList = new List<SyncedAttribute>();
        private static bool _isInitialized = false;

        internal static void Initialize()
        {
            if (_isInitialized)
                return;

            _isInitialized = true;

            const BindingFlags memberFlags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;

            foreach (var prop in typeof(T).GetProperties(memberFlags))
                if (prop.IsDefined(typeof(SyncAttribute), true))
                    RegisterAttribute(prop.Name, prop.PropertyType, prop);

            foreach (var field in typeof(T).GetFields(memberFlags))
                if (field.IsDefined(typeof(SyncAttribute), true))
                    RegisterAttribute(field.Name, field.FieldType, field);
        }

        /// <summary>The wire names of this model type's [Sync] members. Exists for the test suite.</summary>
        internal static IEnumerable<string> SyncedNames
        {
            get
            {
                Initialize();
                return SyncedAttributes.Keys;
            }
        }

        private static void RegisterAttribute(string memberName, Type valueType, MemberInfo member)
        {
            var name = WireName.Of(memberName);

            // "id" is the model's id on the wire; a member of that name would be sent as the id of every update.
            if (name == "id")
            {
                Debug.LogError($"Colibri: cannot synchronize '{typeof(T).Name}.{memberName}': 'id' is the name of the model's own Id. Rename the member.");
                return;
            }

            if (SyncedAttributes.ContainsKey(name))
            {
                Debug.LogError($"Colibri: '{typeof(T).Name}' has more than one [Sync] member named '{memberName}' (names are matched case-insensitively). Rename one of them.");
                return;
            }

            var attribute = BuildAttribute(name, valueType, member);
            if (attribute == null)
                return;

            attribute.Index = AttributeList.Count;
            AttributeList.Add(attribute);
            SyncedAttributes.Add(name, attribute);
        }

        // Dispatch by type instead of MakeGenericMethod, so IL2CPP sees every closed instantiation and
        // compiles it ahead of time.
        private static SyncedAttribute BuildAttribute(string name, Type valueType, MemberInfo member)
        {
            if (valueType == typeof(bool)) return BuildAttribute<bool>(name, member);
            if (valueType == typeof(int)) return BuildAttribute<int>(name, member);
            if (valueType == typeof(float)) return BuildAttribute<float>(name, member);
            if (valueType == typeof(string)) return BuildAttribute<string>(name, member);
            if (valueType == typeof(Vector2)) return BuildAttribute<Vector2>(name, member);
            if (valueType == typeof(Vector3)) return BuildAttribute<Vector3>(name, member);
            if (valueType == typeof(Quaternion)) return BuildAttribute<Quaternion>(name, member);
            if (valueType == typeof(Color)) return BuildAttribute<Color>(name, member);
            if (valueType == typeof(bool[])) return BuildAttribute<bool[]>(name, member);
            if (valueType == typeof(int[])) return BuildAttribute<int[]>(name, member);
            if (valueType == typeof(float[])) return BuildAttribute<float[]>(name, member);
            if (valueType == typeof(string[])) return BuildAttribute<string[]>(name, member);
            if (valueType == typeof(Vector2[])) return BuildAttribute<Vector2[]>(name, member);
            if (valueType == typeof(Vector3[])) return BuildAttribute<Vector3[]>(name, member);
            if (valueType == typeof(Quaternion[])) return BuildAttribute<Quaternion[]>(name, member);
            if (valueType == typeof(Color[])) return BuildAttribute<Color[]>(name, member);
            if (valueType == typeof(JObject)) return BuildAttribute<JObject>(name, member);

            Debug.LogError($"Colibri: cannot synchronize '{typeof(T).Name}.{member.Name}' - [Sync] does not support {valueType.Name}. Supported types are {SupportedTypes}. "
                + $"For your own classes, sync a JObject: JObject.FromObject(value, ColibriJson.Serializer), and read it back with ToObject<{valueType.Name}>(ColibriJson.Serializer) - "
                + "ColibriJson can convert the Vector3, Quaternion and Color members that Newtonsoft on its own cannot.");
            return null;
        }

        private static SyncedAttribute BuildAttribute<TValue>(string name, MemberInfo member)
        {
            if (member is PropertyInfo property)
            {
                if (property.GetGetMethod(true) == null || property.GetSetMethod(true) == null)
                {
                    Debug.LogError($"Colibri: cannot synchronize '{typeof(T).Name}.{member.Name}' - a [Sync] property needs both a getter and a setter.");
                    return null;
                }
            }
            else if (((FieldInfo)member).IsInitOnly)
            {
                Debug.LogError($"Colibri: cannot synchronize '{typeof(T).Name}.{member.Name}' - a [Sync] field cannot be readonly.");
                return null;
            }

            Func<T, TValue> getter;
            Action<T, TValue> setter;
            try
            {
#if ENABLE_IL2CPP
                CreateReflectionAccessors<TValue>(member, out getter, out setter);
#else
                CreateCompiledAccessors<TValue>(member, out getter, out setter);
#endif
            }
            catch (Exception e)
            {
                // Reported instead of thrown: it would escape the first Awake and leave the object half set up.
                Debug.LogError($"Colibri: cannot synchronize '{typeof(T).Name}.{member.Name}' - {e.GetType().Name}: {e.Message}");
                return null;
            }

            return new SyncedAttribute<TValue>
            {
                Name = name,
                MemberName = member.Name,
                PropertyType = typeof(TValue),
                Getter = getter,
                Setter = setter
            };
        }

        /// <summary>Accessors for IL2CPP, which has no JIT.</summary>
        // Compile() does not fail there but falls back to the expression interpreter, which is slow and, for
        // value types, depends on generic code IL2CPP may not have generated.
        // FieldInfo boxes a value-type field on every poll; a hot value-type member is cheaper as a property.
        // Not behind #if so the Editor tests can run it (the Editor is always Mono). The member must have
        // passed BuildAttribute<TValue>.
        internal static void CreateReflectionAccessors<TValue>(MemberInfo member, out Func<T, TValue> getter, out Action<T, TValue> setter)
        {
            if (member is PropertyInfo property)
            {
                getter = (Func<T, TValue>)Delegate.CreateDelegate(typeof(Func<T, TValue>), property.GetGetMethod(true));
                setter = (Action<T, TValue>)Delegate.CreateDelegate(typeof(Action<T, TValue>), property.GetSetMethod(true));
                return;
            }

            var field = (FieldInfo)member;
            getter = target => (TValue)field.GetValue(target);
            setter = (target, value) => field.SetValue(target, value);
        }

#if !ENABLE_IL2CPP
        /// <summary>Accessors for Mono, compiled from expression trees, so nothing boxes.</summary>
        private static void CreateCompiledAccessors<TValue>(MemberInfo member, out Func<T, TValue> getter, out Action<T, TValue> setter)
        {
            var exTarget = Expression.Parameter(typeof(T), "target");
            var exValue = Expression.Parameter(typeof(TValue), "value");

            Expression exGet;
            Expression exSet;

            if (member is PropertyInfo property)
            {
                // see: https://stackoverflow.com/a/17669142/4090817
                exGet = Expression.Call(exTarget, property.GetGetMethod(true));
                exSet = Expression.Call(exTarget, property.GetSetMethod(true), exValue);
            }
            else
            {
                var field = (FieldInfo)member;
                exGet = Expression.Field(exTarget, field);
                exSet = Expression.Assign(Expression.Field(exTarget, field), exValue);
            }

            getter = Expression.Lambda<Func<T, TValue>>(exGet, exTarget).Compile();
            setter = Expression.Lambda<Action<T, TValue>>(exSet, exTarget, exValue).Compile();
        }
#endif
    }
}
