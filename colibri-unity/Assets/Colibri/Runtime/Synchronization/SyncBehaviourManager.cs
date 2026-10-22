using Newtonsoft.Json.Linq;
using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using HCIKonstanz.Colibri.Core;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace HCIKonstanz.Colibri.Synchronization
{
    public abstract class SyncBehaviourManager<T> : MonoBehaviour
        where T : SyncBehaviour<T>
    {
        private readonly string ChannelPrefix = WireName.Of(typeof(T).Name);
        internal string Channel { get => ChannelPrefix + (String.IsNullOrEmpty(Template?.ModelId) ? "" : $"_{Template.ModelId}"); }

        public T Template;

        private readonly List<T> _existingObjects = new List<T>();

        // Placed objects that have not run Awake yet (inactive since their scene loaded), by id.
        // Neither live nor in _existingObjects: an update for one would look like an unknown model and be built again.
        private readonly Dictionary<string, T> _dormantObjects = new Dictionary<string, T>();
        private bool _isCreatingObject;
        private bool _warnedNoTemplate;
        private bool _warnedUnknownPart;

        // Ids of remote objects that could not be built: the copy took another Id in Awake.
        private readonly HashSet<string> _unbuildable = new HashSet<string>();

        private bool _isListening;

        // Listens from Start (after Template is set) until OnDestroy. Override and call base, do not hide:
        // if Start does not run, OnEnable starts listening a frame later and warns.
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

            // Includes inactive objects: one that woke and was then hidden raised ModelCreated before
            // this manager listened. One that has not run Awake is skipped; it reaches OnModelCreated when it wakes.
            var existingBehaviours = UnityCompat.FindAll<T>(FindObjectsInactive.Include)
                .Where(o => o.HasAwoken)
                .Where(o => o.ModelId == Template?.ModelId || (Template == null && String.IsNullOrEmpty(o.ModelId)))
                .ToArray();
            _existingObjects.AddRange(existingBehaviours);
            AddDormantObjects();

            foreach (var existingBehaviour in existingBehaviours)
                existingBehaviour.TriggerSync();

            Sync.AddModelUpdateListener(Channel, OnModelUpdate);
            SceneManager.sceneLoaded += OnSceneLoaded;

            // Listen for newly instantiated objects and propagate initial state
            SyncBehaviour<T>.ModelCreated += OnModelCreated;
            SyncBehaviour<T>.ModelDestroyed += OnModelDestroyed;

            WarnOnModelIdOverlap();
        }

        private void AddDormantObjects()
        {
            foreach (var dormant in UnityCompat.FindAll<T>(FindObjectsInactive.Include))
            {
                if (!dormant.HasAwoken && dormant != Template && !String.IsNullOrEmpty(dormant.Id)
                    && (dormant.ModelId == Template?.ModelId || (Template == null && String.IsNullOrEmpty(dormant.ModelId))))
                    _dormantObjects[dormant.Id] = dormant;
            }
        }

        private void WarnOnModelIdOverlap()
        {
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
            SceneManager.sceneLoaded -= OnSceneLoaded;

            // Static events: with domain reload disabled, a handler survives into the next Play session.
            SyncBehaviour<T>.ModelCreated -= OnModelCreated;
            SyncBehaviour<T>.ModelDestroyed -= OnModelDestroyed;
        }

        // Copies built into the old scene are destroyed on a Single load without a delete, so a manager
        // that survives it (DontDestroyOnLoad) requests the channel's models again. Others do so in Start.
        private void OnSceneLoaded(Scene scene, LoadSceneMode mode)
        {
            if (StoppedListening())
                return;
            if (mode == LoadSceneMode.Single && gameObject.scene != scene)
                Sync.RequestModels(Channel);
        }

        // True for a destroyed manager whose OnDestroy was hidden, so it never unsubscribed; unsubscribes now.
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
            _dormantObjects.Remove(model.Id ?? "");
            if (_existingObjects.Any(e => e.Id == model.Id))
                return;

            _existingObjects.Add(model as T);

            // A part of a copy another manager built (e.g. the SyncTransform next to a Player) requests
            // its own state. A full state sent from here would overwrite the owner's newer values.
            if (((ISyncedObject)model).IsCopy)
                return;
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
            if (IsKnownOrSuppressed(id, out var anchorId))
                return;
            if (TryWakeDormant(id, data))
                return;
            if (!CanBuild(id, anchorId))
                return;
            BuildCopy(id, anchorId, data);
        }

        private bool IsKnownOrSuppressed(string id, out string anchorId)
        {
            anchorId = null;
            if (_existingObjects.Any(t => t.Id == id))
                return true;

            // A remote update sent before the server had this client's delete. Building from it would bring
            // the object back with template values for every member the update lacks.
            if (LocallyDeletedModels.Contains(Channel, id) || _unbuildable.Contains(id))
                return true;

            // Live already: placed in the scene, or built with the object it is part of (it requests its own state).
            if (SyncedIds.IsLive(id))
                return true;

            // A part below an object's anchor (an avatar's hand) builds the whole object, from the anchor's id.
            // Not if that object exists already, live or placed and inactive, even without this part.
            anchorId = SyncedIds.AnchorOfPart(id, prefix => SyncedIds.IsLive(prefix) || _dormantObjects.ContainsKey(prefix)
                || (Template && SyncedIds.TemplateHasPart(Template, typeof(T), prefix, id)));
            return anchorId != null && (SyncedIds.IsLive(anchorId) || _dormantObjects.ContainsKey(anchorId));
        }

        private bool TryWakeDormant(string id, JObject data)
        {
            // A placed object that is inactive here. A remote update with active: true (SyncTransform) switches it
            // on, if its parent is active, and applies. Any other update is dropped: it requests its state on waking.
            if (_dormantObjects.TryGetValue(id, out var dormant))
            {
                if (!dormant)
                {
                    _dormantObjects.Remove(id);
                }
                else
                {
                    var parent = dormant.transform.parent;
                    if (data.TryGetValue("active", out var active) && active.Type == JTokenType.Boolean && active.Value<bool>()
                        && (parent == null || parent.gameObject.activeInHierarchy))
                    {
                        // Woken under _isCreatingObject, so OnModelCreated does not TriggerSync: it requests
                        // its state as it wakes, and this update is applied as its first answer.
                        _dormantObjects.Remove(id);
                        _isCreatingObject = true;
                        try
                        {
                            dormant.gameObject.SetActive(true);
                        }
                        finally
                        {
                            _isCreatingObject = false;
                        }
                        if (!_existingObjects.Contains(dormant))
                            _existingObjects.Add(dormant);
                        dormant.OnModelUpdate(data);
                    }
                    return true;
                }
            }
            return false;
        }

        private bool CanBuild(string id, string anchorId)
        {
            // No Template is normal for a manager of placed objects: warn once, and only for a model it
            // would have to build.
            if (!Template)
            {
                if (!_warnedNoTemplate)
                {
                    _warnedNoTemplate = true;
                    Debug.LogWarning($"Colibri: '{GetType().FullName}' received model '{id}' on channel '{Channel}', "
                        + "which is not in this scene, and has no Template to build it from. Assign a Template to build "
                        + "the objects other clients create.");
                }
                return false;
            }

            // A part of another client's object that the Template lacks must not be built as an object of its own.
            if (anchorId == null && SyncedIds.LooksLikeRuntimePart(id))
            {
                if (!_warnedUnknownPart)
                {
                    _warnedUnknownPart = true;
                    Debug.LogWarning($"Colibri: '{GetType().FullName}' received model '{id}' on channel '{Channel}', a part of "
                        + $"another client's object that its Template '{Template.name}' does not have. Use the same prefab on "
                        + "every client.");
                }
                return false;
            }
            return true;
        }

        private void BuildCopy(string id, string anchorId, JObject data)
        {
            _isCreatingObject = true;
            SyncBehaviour<T>.RemoteModelBeingBuilt = id;
            var prevEnabled = Template.enabled;
            var baseId = anchorId ?? id;
            T go = null;
            GameObject holder = null;

            // Restored in finally: applying the update can throw (a [Sync] setter in application code), and
            // Sync's dispatch catches it, so nothing above would reset this state.
            try
            {
                Template.enabled = false;

                // Built below an inactive holder so that every part has its id and is marked as a copy before
                // any part wakes. One that woke first would take an id from its own Awake (a device id, say)
                // and sync as another object. A part without an Id gets what SyncedIds.Assign gave it on the creator.
                holder = new GameObject("[Colibri copy being built]");
                holder.SetActive(false);
                go = Instantiate(Template, holder.transform);
                AssignCopyIds(go, baseId);

                // Out of the holder, where it wakes. A clone of an inactive template never runs Awake (no listener,
                // no ticker), so it is switched on first. Awake latches the template's values; the update applied
                // next is latched too, so it is not echoed, and decides whether the object ends up active.
                go.transform.SetParent(null, false);
                if (!go.gameObject.activeSelf)
                    go.gameObject.SetActive(true);

                // Restores an Id changed after base.Awake() now rather than at the next poll, for the lookup below.
                foreach (var part in go.GetComponentsInChildren<ISyncedObject>(true))
                    part.KeepRegisteredId();

                // The copy took another Id in Awake: discard it without a delete. Kept, it would sync as
                // another object and every further update for this id would build another copy.
                var target = go.GetComponentsInChildren<T>(true).FirstOrDefault(p => p.Id == id);
                if (!target)
                {
                    DiscardCopy(go, id);
                    return;
                }

                // Known before the update is applied, so a throw there cannot build a second object. Includes
                // the clone's other parts of this type; they request their own state.
                RegisterCopyParts(go);
                target.OnModelUpdate(data);
            }
            finally
            {
                if (go)
                    go.enabled = true;

                if (holder)
                    Destroy(holder);
                Template.enabled = prevEnabled;
                _isCreatingObject = false;
                SyncBehaviour<T>.RemoteModelBeingBuilt = null;
            }
        }

        private static void AssignCopyIds(T go, string baseId)
        {
            var top = go.transform;
            foreach (var part in go.GetComponentsInChildren<ISyncedObject>(true))
            {
                var component = (Component)part;
                if (ReferenceEquals(component, go))
                    go.Id = baseId + SyncedIds.Suffix(top, component);
                else if (String.IsNullOrEmpty(part.Id))
                    part.TakeId(baseId + SyncedIds.Suffix(top, component), false);
                part.MarkAsCopy();
            }
        }

        private void DiscardCopy(T go, string id)
        {
            _unbuildable.Add(id);
            foreach (var part in go.GetComponentsInChildren<ISyncedObject>(true))
                part.MarkDiscarded();
            Destroy(go.gameObject);
            Debug.LogError($"Colibri: '{GetType().FullName}' cannot build '{id}', another client's {typeof(T).Name}: the copy "
                + "took another Id as it woke. A model script must not set Id in Awake when it has one already, "
                + "e.g. 'if (string.IsNullOrEmpty(Id)) Id = ...;'.");
        }

        private void RegisterCopyParts(T go)
        {
            foreach (var part in go.GetComponentsInChildren<T>(true))
            {
                if (part.ModelId == Template.ModelId && !_existingObjects.Contains(part))
                    _existingObjects.Add(part);
            }
        }

    }
}
