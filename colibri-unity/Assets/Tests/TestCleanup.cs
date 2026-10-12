using System;
using System.Collections.Generic;
using HCIKonstanz.Colibri.Core;
using HCIKonstanz.Colibri.Synchronization;
using UnityEngine;
using Object = UnityEngine.Object;

namespace HCIKonstanz.Colibri.E2E
{
    /// <summary>
    /// What a test has to undo when it ends, run from its fixture's [UnityTearDown], so it runs
    /// whether the test passed, failed or timed out.
    ///
    /// A finally block in a [UnityTest] is not enough. When an assertion fails inside a coroutine
    /// the test yields, such as <see cref="TcpPeer.Expect"/> or <see cref="E2EServer.WaitUntil"/>,
    /// Unity's test runner ends the test without disposing the test's own iterator, so its finally
    /// blocks never run. What they should have undone stayed for the rest of the run: a raw peer
    /// still on the app kept the server from clearing the app's models, and a second manager on a
    /// channel built every model twice, which failed most of the tests after it.
    ///
    /// Code that yields no other coroutine can still use a finally block.
    /// </summary>
    public sealed class TestCleanup
    {
        private readonly List<Action> _undo = new List<Action>();

        /// <summary>Calls <paramref name="undo"/> when the test ends.</summary>
        public void Add(Action undo) => _undo.Add(undo);

        /// <summary>Disposes <paramref name="disposable"/> when the test ends.</summary>
        /// <returns><paramref name="disposable"/></returns>
        public T Add<T>(T disposable) where T : IDisposable
        {
            _undo.Add(disposable.Dispose);
            return disposable;
        }

        /// <summary>
        /// Destroys <paramref name="gameObject"/> when the test ends, at once rather than at the
        /// end of the frame, while the connection the test used is still there: a synced object
        /// sends model::delete as it goes, and a component left for the end of the frame could run
        /// an Update after the connection is destroyed, and build a new one.
        /// </summary>
        /// <returns><paramref name="gameObject"/></returns>
        public GameObject Add(GameObject gameObject)
        {
            _undo.Add(() =>
            {
                if (gameObject)
                    Object.DestroyImmediate(gameObject);
            });
            return gameObject;
        }

        /// <summary>
        /// Undoes everything added since the last call, the newest first. One that throws is
        /// logged, which fails the test, and the rest still run.
        /// </summary>
        public void Run()
        {
            for (var i = _undo.Count - 1; i >= 0; i--)
            {
                try
                {
                    _undo[i]();
                }
                catch (Exception e)
                {
                    Debug.LogException(e);
                }
            }

            _undo.Clear();
        }

        /// <summary>Every GameObject in the scene with a SyncBehaviour of any model type on it.</summary>
        public static HashSet<GameObject> SyncedObjects()
        {
            var found = new HashSet<GameObject>();
            foreach (var behaviour in UnityCompat.FindAll<MonoBehaviour>(FindObjectsInactive.Include))
            {
                for (var type = behaviour.GetType(); type != null; type = type.BaseType)
                {
                    if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(SyncBehaviour<>))
                    {
                        found.Add(behaviour.gameObject);
                        break;
                    }
                }
            }
            return found;
        }
    }
}
