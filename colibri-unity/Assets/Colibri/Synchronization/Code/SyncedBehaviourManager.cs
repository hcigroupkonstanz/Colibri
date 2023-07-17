using Newtonsoft.Json.Linq;
using System.Collections.Generic;
using System.Linq;
using UniRx;
using UnityEngine;

namespace HCIKonstanz.Colibri.Synchronization
{
    public abstract class SyncedBehaviourManager<T> : MonoBehaviour
        where T : SyncedBehaviour<T>
    {
        public T Template;

        private readonly List<T> _existingObjects = new List<T>();

        private void OnEnable()
        {
            var Channel = typeof(T).Name;
            var existingBehaviours = FindObjectsOfType<T>();
            _existingObjects.AddRange(existingBehaviours);

            Sync.AddModelUpdateListener(Channel, OnModelUpdate);
            SyncedBehaviour<T>.ModelCreated()
                .TakeUntilDisable(this)
                .Where(m => m is T)
                .Where(m => !_existingObjects.Any(e => e.Id == m.Id))
                .Subscribe(m =>
                {
                    _existingObjects.Add(m as T);
                    m.TriggerSync();
                });

            SyncedBehaviour<T>.ModelDestroyed()
                .TakeUntilDisable(this)
                .Where(m => m is T)
                .Subscribe(m => _existingObjects.Remove(m as T));
        }

        private void OnDisable()
        {
            var Channel = typeof(T).Name;
            Sync.RemoveModelUpdateListener(Channel, OnModelUpdate);
        }

        private void OnModelUpdate(JObject data)
        {
            var id = data["Id"].Value<string>();
            if (!_existingObjects.Any(t => t.Id == id))
            {
                Template.enabled = false;
                var go = Instantiate(Template);
                go.Id = id;
                _existingObjects.Add(go);
                go.enabled = true;
            }
        }

    }
}
