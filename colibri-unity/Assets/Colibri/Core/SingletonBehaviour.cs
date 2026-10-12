using System;
using UnityEngine;

namespace HCIKonstanz.Colibri.Core
{
    /// <summary>
    /// Shutdown bookkeeping shared by every <see cref="SingletonBehaviour{T}"/>.
    /// </summary>
    /// <remarks>
    /// Deliberately a non-generic class: Unity only scans non-generic types for
    /// <see cref="RuntimeInitializeOnLoadMethodAttribute"/>, so the same hook written on
    /// <c>SingletonBehaviour&lt;T&gt;</c> would silently never run.
    /// </remarks>
    internal static class SingletonLifetime
    {
        /// <summary>
        /// True from the moment the application starts shutting down. Creating a singleton then
        /// would only leak a GameObject that nothing is left to tear down.
        /// </summary>
        /// <remarks>
        /// Raised by <see cref="Application.quitting"/>, which Unity sends when Play mode ends and
        /// when a player quits, before the scenes are torn down and whatever the state of any
        /// object - unlike OnApplicationQuit, which inactive GameObjects never receive. Settable
        /// within the assembly so that tests can stand in for the end of Play mode.
        /// </remarks>
        public static bool IsQuitting { get; internal set; }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        private static void ResetState()
        {
            IsQuitting = false;

            // Statics survive Play mode when domain reload is disabled, and so does this
            // subscription - hence the unsubscribe first, or the n-th session holds n handlers.
            Application.quitting -= OnQuitting;
            Application.quitting += OnQuitting;
        }

        private static void OnQuitting() => IsQuitting = true;
    }

    [DisallowMultipleComponent]
    public abstract class SingletonBehaviour<T> : MonoBehaviour
        where T : SingletonBehaviour<T>
    {
        private static T _instance;

        public static T Instance
        {
            get
            {
                // Unity's ==, not ReferenceEquals: with domain reload disabled this field still
                // holds the *previous* Play session's component. That object is destroyed, so it
                // compares equal to null - which is precisely the signal to build a new one.
                //
                // A plain "have I ever created this?" flag cannot see that difference. Latching
                // one made the second Play session hand back the destroyed connection: no
                // GameObject in the scene, no Update, no socket, and not one line in the console.
                if (_instance != null)
                    return _instance;

                if (SingletonLifetime.IsQuitting)
                    return null;

                try
                {
                    // An instance placed in the scene by hand wins over creating one.
                    _instance = FindAnyObjectByType<T>();

                    if (_instance == null)
                        _instance = new GameObject($"[{typeof(T).Name}]").AddComponent<T>();
                }
                catch (Exception e)
                {
                    Debug.LogError(e);
                }

                return _instance;
            }
        }

        protected virtual void Awake()
        {
            _instance = this as T;
        }
    }
}
