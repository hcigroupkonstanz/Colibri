using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace HCIKonstanz.Colibri.Synchronization
{
    /// <summary>
    /// Compares and copies a [Sync] member's values as they go on the wire, to detect changes.
    /// </summary>
    // Arrays are compared element by element and JObjects with JToken.DeepEquals, against a copy: a
    // getter that builds its value (Points => _points.ToArray()) would differ in every poll.
    // Colors are compared as Color32, since the wire carries #RRGGBBAA at 8 bits a channel: an exact
    // comparison differs from the rounded color every other client applies, and echoes it back.
    // Comparers are chosen per supported type by name, so IL2CPP compiles each of them.
    internal static class SyncValues
    {
        internal static Func<TValue, TValue, bool> EqualityFor<TValue>()
        {
            var type = typeof(TValue);
            object equality =
                type == typeof(Color) ? (object)new Func<Color, Color, bool>(SameOnTheWire) :
                type == typeof(JObject) ? (object)new Func<JObject, JObject, bool>(JToken.DeepEquals) :
                type == typeof(bool[]) ? (object)new Func<bool[], bool[], bool>(SequenceEqual) :
                type == typeof(int[]) ? (object)new Func<int[], int[], bool>(SequenceEqual) :
                type == typeof(float[]) ? (object)new Func<float[], float[], bool>(SequenceEqual) :
                type == typeof(string[]) ? (object)new Func<string[], string[], bool>(SequenceEqual) :
                type == typeof(Vector2[]) ? (object)new Func<Vector2[], Vector2[], bool>(SequenceEqual) :
                type == typeof(Vector3[]) ? (object)new Func<Vector3[], Vector3[], bool>(SequenceEqual) :
                type == typeof(Quaternion[]) ? (object)new Func<Quaternion[], Quaternion[], bool>(SequenceEqual) :
                type == typeof(Color[]) ? (object)new Func<Color[], Color[], bool>(SameOnTheWire) :
                (object)null;
            return equality as Func<TValue, TValue, bool> ?? EqualityComparer<TValue>.Default.Equals;
        }

        internal static Func<TValue, TValue> CopyFor<TValue>()
        {
            if (typeof(TValue).IsArray)
                return value => value == null ? value : (TValue)((Array)(object)value).Clone();
            if (typeof(TValue) == typeof(JObject))
                return value => value == null ? value : (TValue)(object)((JObject)(object)value).DeepClone();
            return value => value;
        }

        internal static bool SameOnTheWire(Color a, Color b)
        {
            Color32 x = a;
            Color32 y = b;
            return x.r == y.r && x.g == y.g && x.b == y.b && x.a == y.a;
        }

        private static bool SameOnTheWire(Color[] a, Color[] b)
        {
            if (ReferenceEquals(a, b))
                return true;
            if (a == null || b == null || a.Length != b.Length)
                return false;
            for (var i = 0; i < a.Length; i++)
            {
                if (!SameOnTheWire(a[i], b[i]))
                    return false;
            }
            return true;
        }

        private static bool SequenceEqual<TElement>(TElement[] a, TElement[] b)
        {
            if (ReferenceEquals(a, b))
                return true;
            if (a == null || b == null || a.Length != b.Length)
                return false;
            var comparer = EqualityComparer<TElement>.Default;
            for (var i = 0; i < a.Length; i++)
            {
                if (!comparer.Equals(a[i], b[i]))
                    return false;
            }
            return true;
        }
    }
}
