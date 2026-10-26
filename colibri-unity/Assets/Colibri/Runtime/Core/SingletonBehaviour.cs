using System;
using UnityEngine;

namespace HCIKonstanz.Colibri.Core
{
    [DisallowMultipleComponent]
    public abstract class SingletonBehaviour<T> : MonoBehaviour
        where T : SingletonBehaviour<T>
    {
        private static T _instance;

        public static T Instance
        {
            get
            {
                // No created latch: without domain reload this holds the previous Play session's
                // destroyed component, which must count as null.
                if (_instance != null)
                    return _instance;

                if (SingletonLifetime.IsQuitting)
                    return null;

                try
                {
                    // try searching scene for available instance
                    _instance = FindAnyObjectByType<T>();

                    // No singleton found in scene, create a new one
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
