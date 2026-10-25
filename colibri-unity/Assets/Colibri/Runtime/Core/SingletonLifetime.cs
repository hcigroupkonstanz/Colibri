using UnityEngine;

namespace HCIKonstanz.Colibri.Core
{
    /// <summary>
    /// Shutdown state shared by every <see cref="SingletonBehaviour{T}"/>.
    /// </summary>
    // Non-generic because Unity only scans non-generic types for RuntimeInitializeOnLoadMethod.
    internal static class SingletonLifetime
    {
        /// <summary>
        /// True once the application is shutting down; singletons are no longer created then.
        /// </summary>
        // Set from Application.quitting, which fires whatever the state of any object
        // (OnApplicationQuit skips inactive GameObjects).
        // Settable so tests can simulate the end of Play mode.
        public static bool IsQuitting { get; internal set; }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        private static void ResetState()
        {
            IsQuitting = false;

            // Without domain reload the subscription survives Play mode; unsubscribe first so handlers do not stack.
            Application.quitting -= OnQuitting;
            Application.quitting += OnQuitting;
        }

        private static void OnQuitting() => IsQuitting = true;
    }
}
