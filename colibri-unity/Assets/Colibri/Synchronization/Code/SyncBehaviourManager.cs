using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.Linq;
using UniRx;
using UnityEngine;

namespace HCIKonstanz.Colibri.Synchronization
{
    public abstract class SyncBehaviourManager<T> : MonoBehaviour
        where T : SyncBehaviour<T>
    {
        private readonly string ChannelPrefix = typeof(T).Name.ToLower();
        private string Channel { get => ChannelPrefix + (String.IsNullOrEmpty(Template?.ModelId) ? "" : $"_{Template.ModelId}"); }

        public T Template;

        private readonly List<T> _existingObjects = new List<T>();
        private bool _isCreatingObject;

        private void Start()
        {
            var existingBehaviours = FindObjectsOfType<T>()
                .Where(o => o.ModelId == Template?.ModelId);
            _existingObjects.AddRange(existingBehaviours);

            foreach (var existingBehaviour in existingBehaviours)
                existingBehaviour.TriggerSync();

            Sync.AddModelUpdateListener(Channel, OnModelUpdate);

            // Listen for newly instantiated objects and propagate initial state
            SyncBehaviour<T>.ModelCreated()
                .TakeUntilDisable(this)
                .Where(m => m is T && m.ModelId == Template?.ModelId)
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
                Debug.LogWarning($"No template provided for Colibri manager '{GetType().FullName}' { (String.IsNullOrEmpty(Template?.ModelId) ? "" : $"(ModelID: {Template?.ModelId})") }, unable to instantiate new objects!");

            // Avoid potential ModelId overlaps
            var hasConflict = FindObjectsOfType(GetType())
                .Where(o => o != this)
                .Any(o => (o as SyncBehaviourManager<T>)?.Template?.ModelId == Template?.ModelId);
            if (hasConflict)
                Debug.LogWarning($"Warning: Multiple instances of '{GetType().FullName}' detected with overlapping ModelID. Please only use one manager for each synced model or specify unique ModelID!");
        }
        private void OnDestroy()
        {
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
