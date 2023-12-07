using Newtonsoft.Json.Linq;
using System.Collections.Generic;
using System.Linq;
using UniRx;
using UnityEngine;

namespace HCIKonstanz.Colibri.Synchronization
{
    public abstract class SyncBehaviourManager<T> : MonoBehaviour
        where T : SyncBehaviour<T>
    {
        public T Template;

        private static SyncBehaviourManager<T> _instance; // currently only used to check for duplicate scripts
        private readonly List<T> _existingObjects = new List<T>();
        private bool _isCreatingObject;

        private void Start()
        {
            var Channel = typeof(T).Name.ToLower();
            var existingBehaviours = FindObjectsOfType<T>();
            _existingObjects.AddRange(existingBehaviours);

            foreach (var existingBehaviour in existingBehaviours)
                existingBehaviour.TriggerSync();

            Sync.AddModelUpdateListener(Channel, OnModelUpdate);
            SyncBehaviour<T>.ModelCreated()
                .TakeUntilDisable(this)
                .Where(m => m is T)
                .Where(_ => !_isCreatingObject)
                .Where(m => !_existingObjects.Any(e => e.Id == m.Id))
                .Subscribe(m =>
                {
                    _existingObjects.Add(m as T);
                    m.TriggerSync();
                });

            SyncBehaviour<T>.ModelDestroyed()
                .TakeUntilDisable(this)
                .Where(m => m is T)
                .Subscribe(m => _existingObjects.Remove(m as T));

            // Help developers debug potential Colibri issues
            if (!Template)
                Debug.LogWarning($"No template provided for Colibri manager '{GetType().Name}', unable to instantiate new objects!");

            if (_instance != null)
                Debug.LogWarning($"Warning: Multiple instances of '{GetType().Name}' detected. Please only use one manager for each synced model!");
            _instance = this;
        }

        private void OnDestroy()
        {
            var Channel = typeof(T).Name;
            Sync.RemoveModelUpdateListener(Channel, OnModelUpdate);
        }

        private void OnModelUpdate(JObject data)
        {
            var id = data["id"].Value<string>();
            if (!_existingObjects.Any(t => t.Id == id) && Template)
            {
                _isCreatingObject = true;
                var prevEnabled = Template.enabled;
                var prevId = Template.Id;

                Template.enabled = false;
                Template.Id = id;
                var go = Instantiate(Template);
                go.OnModelUpdate(data);
                _existingObjects.Add(go);
                go.enabled = true;

                Template.enabled = prevEnabled;
                Template.Id = prevId;
                _isCreatingObject = false;
            }
        }

    }
}
