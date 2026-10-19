using Newtonsoft.Json.Linq;
using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using HCIKonstanz.Colibri.Core;
using UnityEngine;

namespace HCIKonstanz.Colibri.Synchronization
{
    public abstract class SyncBehaviourManager<T> : MonoBehaviour
        where T : SyncBehaviour<T>
    {
        private readonly string ChannelPrefix = SyncBehaviour<T>.ToWireName(typeof(T).Name);
        internal string Channel { get => ChannelPrefix + (String.IsNullOrEmpty(Template?.ModelId) ? "" : $"_{Template.ModelId}"); }

        public T Template;

        private readonly List<T> _existingObjects = new List<T>();
        private bool _isCreatingObject;
        private bool _warnedNoTemplate;
        private bool _warnedUnknownPart;

        private bool _isListening;

        // The manager starts listening in Start, after its Template is set, and stops in
        // OnDestroy. Both used to be private: a manager script with a Start of its own hid the
        // manager's, which then never ran, and the manager synced nothing, without a word. Now
        // hiding one warns (CS0114), and should Start not run anyway, the manager starts a frame
        // later and says why. Override them and call the base method.
        protected virtual void OnEnable()
        {
            if (!_isListening)
                StartCoroutine(StartListeningIfStartDidNot());
        }

        protected virtual void Start() => StartListening();

        protected virtual void OnDestroy() => StopListening();

        private IEnumerator StartListeningIfStartDidNot()
        {
            yield return null;
            if (_isListening || !isActiveAndEnabled)
                yield break;

            Debug.LogWarning($"Colibri: '{GetType().FullName}' has a Start method of its own, which hides the manager's. "
                + "Write it as 'protected override void Start()' and call base.Start() in it.");
            StartListening();
        }

        private void StartListening()
        {
            if (_isListening)
                return;
            _isListening = true;

            // Switched-off objects too. Each one raised ModelCreated in its Awake, before this
            // manager listened, and a script that hides an object in its own Awake or Start may
            // run before this Start. Left out, such an object never sent its state, so no other
            // client knew it, and they built it at the template's values once it was shown; and if
            // the server held its model already, the answer to this manager's request below built
            // a second object of its id here. Only objects that have woken, though: one switched off
            // since its scene loaded runs Awake once it is switched on, and comes to OnModelCreated
            // then, like any new object.
            var existingBehaviours = UnityCompat.FindAll<T>(FindObjectsInactive.Include)
                .Where(o => o.HasAwoken)
                .Where(o => o.ModelId == Template?.ModelId || (Template == null && String.IsNullOrEmpty(o.ModelId)))
                .ToArray();
            _existingObjects.AddRange(existingBehaviours);

            foreach (var existingBehaviour in existingBehaviours)
                existingBehaviour.TriggerSync();

            Sync.AddModelUpdateListener(Channel, OnModelUpdate);

            // Listen for newly instantiated objects and propagate initial state
            SyncBehaviour<T>.ModelCreated += OnModelCreated;
            SyncBehaviour<T>.ModelDestroyed += OnModelDestroyed;

            // Avoid potential ModelId overlaps
            var hasConflict = UnityCompat.FindAll(GetType())
                .Where(o => o != this)
                .Any(o => (o as SyncBehaviourManager<T>)?.Template?.ModelId == Template?.ModelId);
            if (hasConflict)
                Debug.LogWarning($"Warning: Multiple instances of '{GetType().FullName}' detected with overlapping ModelID. Please only use one manager for each synced model or specify unique ModelID!");
        }
        private void StopListening()
        {
            if (!_isListening)
                return;
            _isListening = false;

            Sync.RemoveModelUpdateListener(Channel, OnModelUpdate);

            // Static events do not unsubscribe themselves. Missing this leaks a handler - and its
            // destroyed manager - into the next Play session whenever domain reload is disabled.
            SyncBehaviour<T>.ModelCreated -= OnModelCreated;
            SyncBehaviour<T>.ModelDestroyed -= OnModelDestroyed;
        }

        // A destroyed manager whose OnDestroy did not run, hidden by one of the manager script's
        // own, would still be called.
        private bool StoppedListening()
        {
            if (this)
                return false;
            StopListening();
            return true;
        }

        private void OnModelCreated(SyncBehaviour<T> model)
        {
            if (StoppedListening())
                return;
            if (!(model is T))
                return;
            if (model.ModelId != Template?.ModelId && !(Template == null && String.IsNullOrEmpty(model.ModelId)))
                return;
            if (_isCreatingObject)
                return;
            if (_existingObjects.Any(e => e.Id == model.Id))
                return;

            _existingObjects.Add(model as T);
            model.TriggerSync();
        }

        private void OnModelDestroyed(SyncBehaviour<T> model)
        {
            if (StoppedListening())
                return;
            if (model is T typed)
                _existingObjects.Remove(typed);
        }

        private void OnModelUpdate(JObject data)
        {
            if (StoppedListening())
                return;
            var id = data["id"].Value<string>();
            if (_existingObjects.Any(t => t.Id == id))
                return;

            // This client deleted the object a moment ago, and the update is one another client
            // sent before the server had the delete. Built from it, the deleted object was back on
            // this client, with the template's values for every member the update did not carry,
            // and nothing was going to delete it again.
            if (LocallyDeletedModels.Contains(Channel, id))
                return;

            // In this scene already, built with the object it is part of (it asks for its own
            // state then) or placed in it.
            if (SyncedIds.IsLive(id))
                return;

            // A part below the top of an object, such as an avatar's hand: the whole object is
            // built, from its top's id, unless it is here already without this part.
            var anchorId = SyncedIds.AnchorOfPart(id);
            if (anchorId != null && SyncedIds.IsLive(anchorId))
                return;

            // A manager without a template is how objects placed in the scene are synced, so it is
            // only worth a word once a model arrives that it would have to build - and then once,
            // not for every update of every such model.
            if (!Template)
            {
                if (!_warnedNoTemplate)
                {
                    _warnedNoTemplate = true;
                    Debug.LogWarning($"Colibri: '{GetType().FullName}' received model '{id}' on channel '{Channel}', "
                        + "which is not in this scene, and has no Template to build it from. Assign a Template to build "
                        + "the objects other clients create.");
                }
                return;
            }

            if (anchorId != null && !SyncedIds.TemplateHasPart(Template, typeof(T), anchorId, id))
            {
                if (!_warnedUnknownPart)
                {
                    _warnedUnknownPart = true;
                    Debug.LogWarning($"Colibri: '{GetType().FullName}' received model '{id}' on channel '{Channel}', a part of "
                        + $"another client's object '{anchorId}' that its Template '{Template.name}' does not have. Use the same "
                        + "prefab on every client.");
                }
                return;
            }

            _isCreatingObject = true;
            SyncBehaviour<T>.RemoteModelBeingBuilt = id;
            var prevEnabled = Template.enabled;
            var prevId = Template.Id;
            T go = null;

            // Restored in finally: applying the state can throw - a [Sync] setter in
            // application code, a value that cannot be read - and the exception leaves through
            // Sync's dispatch, which reports it. Left behind, _isCreatingObject stayed true,
            // so no object created on this client afterwards ever sent its state, and the
            // template kept the remote model's id.
            try
            {
                Template.enabled = false;
                Template.Id = anchorId ?? id;
                go = Instantiate(Template);

                // Templates are often kept switched off in the scene, and a clone starts out
                // as its template is. A clone that is off never runs Awake: it never registers
                // for its own updates or with the ticker, so it stayed exactly as this first
                // update left it - and an object hidden elsewhere (active: false) could never
                // be shown again. Switched on first, Awake runs and latches the template's
                // values; the state applied next is then latched too, so none of it is echoed
                // back, and it decides whether the object ends up visible.
                if (!go.gameObject.activeSelf)
                    go.gameObject.SetActive(true);

                // Not deleted when its scene unloads, see SyncBehaviour.OnDestroy.
                foreach (var part in go.GetComponentsInChildren<ISyncedObject>(true))
                    part.MarkAsCopy();

                // Known before its state is applied, so that a throw there cannot make the
                // next update for this id build a second object. The clone's other parts of this
                // manager's type too: each asks for its own state, and none is built again.
                foreach (var part in go.GetComponentsInChildren<T>(true))
                {
                    if (part.ModelId == Template.ModelId && !_existingObjects.Contains(part))
                        _existingObjects.Add(part);
                }
                var target = anchorId == null ? go : go.GetComponentsInChildren<T>(true).FirstOrDefault(p => p.Id == id);
                if (target)
                    target.OnModelUpdate(data);
            }
            finally
            {
                if (go)
                    go.enabled = true;

                Template.enabled = prevEnabled;
                Template.Id = prevId;
                _isCreatingObject = false;
                SyncBehaviour<T>.RemoteModelBeingBuilt = null;
            }
        }

    }
}
