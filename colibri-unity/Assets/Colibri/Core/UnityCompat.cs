using System;
using UnityEngine;
using Object = UnityEngine.Object;

namespace HCIKonstanz.Colibri.Core
{
    /// <summary>
    /// Scene queries that work on both 2022.3 and Unity 6000.4+. Unity 6000.4 deprecated the
    /// FindObjectsByType overloads that take a FindObjectsSortMode and added ones without it;
    /// 2022.3 has only the former, so the version check lives here.
    /// </summary>
    // No caller picks a result by position, so the unsorted order of the sort-free overloads does not matter.
    internal static class UnityCompat
    {
        public static T[] FindAll<T>(FindObjectsInactive inactive = FindObjectsInactive.Exclude) where T : Object
#if UNITY_6000_4_OR_NEWER
            => Object.FindObjectsByType<T>(inactive);
#else
            => Object.FindObjectsByType<T>(inactive, FindObjectsSortMode.None);
#endif

        public static Object[] FindAll(Type type, FindObjectsInactive inactive = FindObjectsInactive.Exclude)
#if UNITY_6000_4_OR_NEWER
            => Object.FindObjectsByType(type, inactive);
#else
            => Object.FindObjectsByType(type, inactive, FindObjectsSortMode.None);
#endif
    }
}
