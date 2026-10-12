using System;
using UnityEngine;
using Object = UnityEngine.Object;

namespace HCIKonstanz.Colibri.Core
{
    /// <summary>
    /// Scene queries whose only warning-free form depends on the editor version.
    ///
    /// Unity 6000.4 deprecated every FindObjectsByType overload that takes a FindObjectsSortMode
    /// and added overloads without one, which 2022.3 does not have. Either form called directly
    /// warns at one end of the supported range and does not compile at the other, so the switch
    /// lives here once rather than at every call site.
    ///
    /// None of Colibri's callers depends on the order of the result: they filter it, count it, or
    /// ask whether anything matches. The sort-free overloads make no promise about order, which is
    /// what FindObjectsSortMode.None already meant.
    /// </summary>
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
