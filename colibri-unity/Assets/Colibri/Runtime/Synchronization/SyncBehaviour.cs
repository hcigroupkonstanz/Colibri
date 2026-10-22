using UnityEngine;
using System.Collections.Generic;
using System;
using Newtonsoft.Json.Linq;
using System.Linq;
using System.Threading.Tasks;
using HCIKonstanz.Colibri.Core;

namespace HCIKonstanz.Colibri.Synchronization
{
    /// <summary>
    /// Base class for a component whose [Sync] fields and properties are synchronized between
    /// clients. <typeparamref name="T"/> is the deriving class.
    /// </summary>
    public abstract class SyncBehaviour<T> : MonoBehaviour, SyncTicker.ITickable, ISyncedObject
        where T : SyncBehaviour<T>
    {
        /// <summary>Raised when an instance registers its model: in Awake, and when it follows an Id change.</summary>
        public static event Action<SyncBehaviour<T>> ModelCreated;
        /// <summary>Raised when an instance leaves its model: in OnDestroy, and when it follows an Id change.</summary>
        public static event Action<SyncBehaviour<T>> ModelDestroyed;

        // The id of the model a SyncBehaviourManager is building from a remote update, while it does; read in Awake.
        internal static string RemoteModelBeingBuilt;


        /// <summary>The model's id, unique per channel. Generated in Awake when empty.</summary>
        public string Id;

        /// <summary>
        /// Tells models of one type apart: the channel is the type name plus ModelId. A manager handles
        /// the objects whose ModelId matches its Template's.
        /// </summary>
        public string ModelId = "";
        private readonly string ChannelPrefix = WireName.Of(typeof(T).Name);
        internal string Channel { get => ChannelOf(ModelId); }
        private string ChannelOf(string modelId) => ChannelPrefix + (String.IsNullOrEmpty(modelId) ? "" : $"_{modelId}");

        // Parallel to SyncMembers<T>.AttributeList.
        private SyncMembers<T>.IChangeTracker[] _trackers;
        private bool[] _wasSynced; // IsSynced at the last poll

        private JObject _nextUpdate;

        // Rate limit (SyncSettings.MaxSendRate), on SyncTicker's clock: when the object may send next, and
        // when it last did. Changes before then wait in _nextUpdate.
        private double _nextSendTime = double.NegativeInfinity;
        private double _lastSendTime = double.NegativeInfinity;

        private bool _wasActive;  // activeSelf at the last poll
        private bool _sendAtOnce; // activeSelf changed: goes out past the rate limit

        // Parallel to SyncMembers<T>.AttributeList, made lazily: when a member first sends or takes the server's value.
        private SentValues[] _sentValues;

        // The ReconnectRound the object is in: after a reconnect, or opened at its first answer to
        // keep changes made before it. Null otherwise.
        private ReconnectRound _round;

        // Parallel to SyncMembers<T>.AttributeList: members that keep their local value for the rest of the round, and
        // send it again.
        private bool[] _keptInRound;

        // Parallel to SyncMembers<T>.AttributeList: members that sent after the round's requests went out; the server
        // reads what they sent after everything in the round.
        private bool[] _sentInRound;

        private bool _isQuitting;
        private bool _hasReceivedDestroyCommand;
        private bool _hasReceivedFirstUpdate;

        // Built by a manager from a remote update, which is its first: nothing local is kept over it.
        private bool _isBuiltFromUpdate;

        // Id generated in Awake: the server holds nothing for the object.
        private bool _hasMadeItsId;

        // A part of a copy that a manager built from a remote update.
        private bool _isCopy;

        // The Id and ModelId the object is registered under (see FollowIdChange, KeepRegisteredId).
        private string _registeredId;
        private string _registeredModelId;

        // Completes at the first update for the object; a new one after an Id change.
        private TaskCompletionSource<bool> _isReady = new TaskCompletionSource<bool>();

        // Moved to another Id after being created here: sends its full state if the server holds nothing
        // for the new Id.
        private bool _announceAtFirstAnswer;

        string ISyncedObject.Id => Id;
        bool ISyncedObject.MadeItsId => _hasMadeItsId;

        void ISyncedObject.TakeId(string id, bool madeHere)
        {
            if (!String.IsNullOrEmpty(Id))
                return;
            Id = id;
            _hasMadeItsId = madeHere;
        }

        void ISyncedObject.MarkAsCopy() => _isCopy = true;

        bool ISyncedObject.IsCopy => _isCopy;

        string ISyncedObject.RegisteredId => _registeredId;

        void ISyncedObject.KeepRegisteredId() => KeepRegisteredId();

        void ISyncedObject.LatchMovedWithParent() => LatchMovedWithParent();

        /// <summary>See <see cref="ISyncedObject.LatchMovedWithParent"/>; GenericSyncTransform latches its world pose.</summary>
        private protected virtual void LatchMovedWithParent()
        {
        }

        /// <summary>Called once <paramref name="update"/>, from the server, has been applied to this object.</summary>
        private protected virtual void AfterUpdateApplied(JObject update)
        {
        }

        /// <summary>Latches the member's current value, so the next poll does not report it as a change.</summary>
        private protected void Latch(string memberName)
        {
            if (_trackers == null)
                return;
            var self = this as T;
            foreach (var attribute in SyncMembers<T>.AttributeList)
            {
                if (attribute.MemberName == memberName)
                    _trackers[attribute.Index].Latch(self);
            }
        }

        void ISyncedObject.MarkDiscarded()
        {
            _hasReceivedDestroyCommand = true;
            _nextUpdate = null;
        }

        /// <summary>
        /// Follows an Id or ModelId changed after Awake (right after Instantiate, say), at the next poll:
        /// leaves the old model and channel, requests the new one, and sends its own state if the server
        /// has none and the object was created here. The parts below the object keep their Ids.
        /// </summary>
        // A copy that a manager built of another client's object keeps its Id (see KeepRegisteredId).
        private void FollowIdChange()
        {
            if (_registeredId == null || (Id == _registeredId && ModelId == _registeredModelId))
                return;
            if (_isCopy)
            {
                KeepRegisteredId();
                return;
            }

            var oldId = _registeredId;
            var oldChannel = ChannelOf(_registeredModelId);
            var madeHere = _hasMadeItsId;

            Sync.RemoveModelUpdateListener(oldChannel, OnModelUpdate);
            Sync.RemoveModelDeleteListener(oldChannel, OnModelDelete);
            SyncedIds.Deregister(oldId);
            ModelDestroyed?.Invoke(this);
            // Made here: nobody else would delete it, and other clients' copies would stay for good.
            if (madeHere)
            {
                LocallyDeletedModels.Remember(oldChannel, oldId);
                Sync.SendModelDelete(oldChannel, oldId);
            }

            // Starts afresh under the new Id: nothing sent or received under the old one applies, and the
            // values latched below are what the first answer is compared with.
            _nextUpdate = null;
            _hasMadeItsId = false;
            _hasReceivedFirstUpdate = false;
            _isBuiltFromUpdate = false;
            _round = null;
            _keptInRound = null;
            _sentInRound = null;
            _sentValues = null;
            _announceAtFirstAnswer = madeHere;
            var wasReady = _isReady;
            _isReady = new TaskCompletionSource<bool>();
            wasReady.TrySetCanceled();
            var self = this as T;
            for (var i = 0; i < _trackers.Length; i++)
                _trackers[i].Latch(self);

            _registeredId = Id;
            _registeredModelId = ModelId;
            SyncedIds.Register(Id);
            LocallyDeletedModels.Forget(Channel, Id);
            Sync.AddModelUpdateListener(Channel, OnModelUpdate, Id, OnRequestedAgain);
            Sync.AddModelDeleteListener(Channel, OnModelDelete);
            ModelCreated?.Invoke(this);
        }

        /// <summary>
        /// Restores the Id and ModelId a copy of another client's object registered with, and logs an
        /// error: a model script that sets Id on a copy would give it another object's Id.
        /// </summary>
        private void KeepRegisteredId()
        {
            if (_registeredId == null || (Id == _registeredId && ModelId == _registeredModelId))
                return;

            Debug.LogError($"Colibri: the Id or ModelId of '{name}' ({typeof(T).Name}), a copy of another client's object, was "
                + $"changed to '{Id}' and '{ModelId}'. It keeps '{_registeredId}' and '{_registeredModelId}'. A model script must not "
                + "set Id in Awake when it has one already, e.g. 'if (string.IsNullOrEmpty(Id)) Id = ...;'.", this);
            Id = _registeredId;
            ModelId = _registeredModelId;
        }

        private int _tickIndex = -1;
        int SyncTicker.ITickable.TickIndex { get => _tickIndex; set => _tickIndex = value; }

        /// <summary>
        /// Whether Awake has run, which makes the change trackers: false for an object that has not been
        /// active yet.
        /// </summary>
        internal bool HasAwoken => _trackers != null;

        /// <summary>
        /// Whether the server's state for the object is known: its first answer has arrived, or the
        /// object made its id in Awake and the server holds nothing for it.
        /// </summary>
        private protected bool KnowsServerState => _hasReceivedFirstUpdate || _hasMadeItsId;

        /// <summary>The id whose answer ends the round this object is in; null when it is in none. For the EditMode tests.</summary>
        internal string RoundEndMarker => _round == null || _round.IsOver ? null : _round.EndMarkerId;


        /// <summary>
        /// Whether the [Sync] member named <paramref name="memberName"/> (its C# name) is switched on.
        /// One that is off is never sent, neither as a change nor in the full state of
        /// <see cref="TriggerSync"/>.
        /// </summary>
        // A switched-off member's getter reads a placeholder (SyncTransform's Position is Vector3.zero
        // while SyncPosition is off) that would move the object to the origin on every client that has
        // it on.
        // Asked for every member in every poll: keep it cheap and allocation-free.
        private protected virtual bool IsSynced(string memberName) => true;


        protected virtual void Awake()
        {
            SyncMembers<T>.Initialize();

            // Another synced component of the object may have given this one its id already (see SyncedIds).
            if (String.IsNullOrEmpty(Id))
                SyncedIds.Assign(this, this);
            SyncedIds.Register(Id);

            var self = this as T;
            _trackers = new SyncMembers<T>.IChangeTracker[SyncMembers<T>.AttributeList.Count];
            _wasSynced = new bool[SyncMembers<T>.AttributeList.Count];
            for (var i = 0; i < SyncMembers<T>.AttributeList.Count; i++)
            {
                _trackers[i] = SyncMembers<T>.AttributeList[i].CreateTracker(self);
                _wasSynced[i] = IsSynced(SyncMembers<T>.AttributeList[i].MemberName);
            }
            _wasActive = gameObject.activeSelf;

            SyncTicker.Register(this);

            // AddModelUpdateListener sends a model::request, which lifts the server's tombstone for this id. Not
            // for an object a manager builds from a remote update: the model may have been deleted since, and
            // an update sent before the delete would recreate it on the server and every client.
            if (RemoteModelBeingBuilt != null && RemoteModelBeingBuilt == Id)
            {
                _isBuiltFromUpdate = true;
                Sync.AddModelUpdateListenerWithoutRequest(Channel, OnModelUpdate, Id, OnRequestedAgain);
            }
            else
            {
                // In this client's scene again: forget a local delete of this id.
                LocallyDeletedModels.Forget(Channel, Id);
                Sync.AddModelUpdateListener(Channel, OnModelUpdate, Id, OnRequestedAgain);
            }
            Sync.AddModelDeleteListener(Channel, OnModelDelete);
            _registeredId = Id;
            _registeredModelId = ModelId;

            ModelCreated?.Invoke(this);

            // check if the scene contains a matching manager
            var hasManager = UnityCompat.FindAll<SyncBehaviourManager<T>>()
                .Where(m => m.Template?.ModelId == ModelId || (String.IsNullOrEmpty(m.Template?.ModelId) && String.IsNullOrEmpty(ModelId)))
                .Any();

            if (!hasManager)
            {
                if (String.IsNullOrEmpty(ModelId))
                    Debug.LogWarning("No generic Colibri SyncManager found (without ModelId) - synchronization of newly created objects may be restricted");
                else
                    Debug.LogWarning($"No Colibri SyncManager found (ModelID '{ModelId}') - synchronization of newly created objects may be restricted");
            }
        }

        protected virtual void OnApplicationQuit()
        {
            _isQuitting = true;
        }

        protected virtual void OnDestroy()
        {
            // Tear down under the Id and ModelId it registered with: if they changed and FollowIdChange has
            // not run yet, the listeners and bookkeeping are still under those.
            if (_registeredId != null)
            {
                Id = _registeredId;
                ModelId = _registeredModelId;
            }

            // A held update is dropped with the object: sent after the delete below, it would recreate the
            // model on the server.
            SyncTicker.Deregister(this);
            if (HasAwoken)
                SyncedIds.Deregister(Id);

            Sync.RemoveModelUpdateListener(Channel, OnModelUpdate);
            Sync.RemoveModelDeleteListener(Channel, OnModelDelete);

            ModelDestroyed?.Invoke(this);

            // Quitting is not deleting: the model outlives this client. OnApplicationQuit reaches only active
            // GameObjects and a hidden synced object is inactive, so _isQuitting is not enough;
            // SingletonLifetime.IsQuitting (Application.quitting) is raised whatever the object's state.
            if (_isQuitting || SingletonLifetime.IsQuitting || _hasReceivedDestroyCommand)
                return;

            // A copy goes with its scene without a delete: the manager builds it again when the scene loads
            // again, and a delete would remove it for its owner and every other client.
            if (_isCopy && !gameObject.scene.isLoaded)
            {
                _isReady.TrySetCanceled();
                return;
            }

            // A remote update sent before the server saw this delete must not make a manager build the object
            // again (see LocallyDeletedModels).
            LocallyDeletedModels.Remember(Channel, Id);
            Sync.SendModelDelete(Channel, Id);
            _isReady.TrySetCanceled();
        }


        // Driven by SyncTicker: one Update and one LateUpdate for the whole application.

        void SyncTicker.ITickable.PollChanges()
        {
            FollowIdChange();

            // Gated on the component alone: an inactive GameObject is still polled, since being inactive is synced
            // state (SyncTransform's Active reads activeSelf) and `false` must be seen. Teardown leaves activeSelf alone.
            // A component with enabled = false neither latches nor sends; what changed meanwhile is picked up once
            // it is back on.
            if (!enabled)
                return;

            var self = this as T;
            for (var i = 0; i < _trackers.Length; i++)
            {
                var attribute = SyncMembers<T>.AttributeList[i];
                var isSynced = IsSynced(attribute.MemberName);
                var switchedOn = isSynced && !_wasSynced[i];
                _wasSynced[i] = isSynced;

                // A switched-off member reads a placeholder: not sent, and not latched either.
                if (!isSynced)
                    continue;

                // Switched on again, the member is sent without a comparison: other clients still hold the value
                // from before, and a comparison can miss the change (SyncTransform's scale set back to one while
                // SyncScale was off is what its placeholder reads).
                if (switchedOn)
                {
                    _trackers[i].Latch(self);
                    if (_hasReceivedFirstUpdate)
                        AddUpdate(attribute, attribute.GetBoxed(self));
                    continue;
                }

                // Nothing is compared or latched until the first answer, which compares each member with its value
                // from registration (see "Changes made before the first answer").
                if (!_hasReceivedFirstUpdate)
                    continue;

                if (_trackers[i].CaptureChange(self))
                    AddUpdate(attribute, attribute.GetBoxed(self));
            }

            // Switching the object off or on bypasses the rate limit: it is a one-off, often the last thing
            // that happens to an object. Whatever is waiting goes out with it, in this frame.
            var active = gameObject.activeSelf;
            if (active != _wasActive)
            {
                _wasActive = active;
                _sendAtOnce = true;
            }
        }

        void SyncTicker.ITickable.FlushUpdate(double now, double interval, double heardAt)
        {
            var update = TakeDueUpdate(now, interval, heardAt);
            if (update != null)
                Sync.SendModelUpdate(Channel, update);
        }

        /// <summary>
        /// The update to send in this frame under the rate limit, or null. The deciding half of
        /// FlushUpdate; internal so the tests can run it on a clock of their own.
        /// </summary>
        // Leading edge first: a change after a quiet spell goes out at once. Later changes are merged and
        // held until the interval is up; the ticker flushes every object in every frame, so the last
        // values of a burst go out without another change.
        internal JObject TakeDueUpdate(double now, double interval, double heardAt)
        {
            var sendAtOnce = _sendAtOnce;
            _sendAtOnce = false;

            if (_nextUpdate == null)
                return null;

            // _nextSendTime was set with the previous interval. A raised MaxSendRate (set from code) shortens
            // the wait for what is held now; a lowered one applies from the next slot.
            var due = Math.Min(_nextSendTime, _lastSendTime + interval);

            if (interval > 0 && now < due && !sendAtOnce)
                return null;

            // The next slot is one interval after the previous slot, not after now: counting from now rounds every
            // interval up to whole frames (30 Hz at 72 fps becomes 24 Hz). The lateness is carried over only while
            // the object keeps sending; after a pause or an early send it starts afresh, so no backlog builds up.
            var late = now - due;
            _nextSendTime = late >= 0 && late < interval ? due + interval : now + interval;
            _lastSendTime = now;

            var update = _nextUpdate;
            _nextUpdate = null;
            RememberSent(update, now, heardAt);
            return update;
        }

        /// <summary>
        /// Keeps the values of an outgoing update, for judging the server's answers after a reconnect
        /// (see <see cref="KeepsLocalValue"/>).
        /// </summary>
        private void RememberSent(JObject update, double now, double heardAt)
        {
            var answersPending = _round != null && !_round.IsOver;

            // By hand: Properties() would allocate an enumerator per update.
            for (var token = update.First; token != null; token = token.Next)
            {
                var property = (JProperty)token;
                if (!SyncMembers<T>.SyncedAttributes.TryGetValue(property.Name, out var attribute))
                    continue;

                SentValuesOf(attribute).Remember(ToKeep(attribute, property.Value), now, heardAt, answersPending);

                if (answersPending)
                    (_sentInRound ??= new bool[SyncMembers<T>.AttributeList.Count])[attribute.Index] = true;
            }
        }

        private SentValues SentValuesOf(SyncMembers<T>.SyncedAttribute attribute)
        {
            _sentValues ??= new SentValues[SyncMembers<T>.AttributeList.Count];
            return _sentValues[attribute.Index] ??= new SentValues();
        }

        /// <summary>
        /// A value as SentValues keeps it. A JObject member's value is the application's own object,
        /// which it may change in place later, so it is cloned.
        /// </summary>
        private static JToken ToKeep(SyncMembers<T>.SyncedAttribute attribute, JToken value)
            => attribute.PropertyType == typeof(JObject) ? value.DeepClone() : value;


        /// <summary>Applies a remote update for this object; one for another Id is ignored.</summary>
        public void OnModelUpdate(JObject data)
        {
            // The member table is per type and built in Awake, which may not have run for any instance yet.
            SyncMembers<T>.Initialize();

            var id = data["id"].Value<string>();
            if (id == Id)
            {
                var isFirstUpdate = !_hasReceivedFirstUpdate;
                _hasReceivedFirstUpdate = true;

                // While a round is open (after a reconnect, or after a first answer that kept local changes), what
                // arrives is judged by KeepsLocalValue.
                var round = _round;
                if (round != null && round.IsOver)
                    round = _round = null;

                if (isFirstUpdate)
                    KeepChangesMadeBeforeTheAnswer(data, ref round);

                foreach (var prop in data)
                {
                    if (prop.Key == "id")
                        continue;

                    if (round != null && KeepsLocalValue(prop.Key, prop.Value, round))
                        continue;

                    UpdateAttribute(prop.Key, prop.Value);
                }

                AfterUpdateApplied(data);

                _isReady.TrySetResult(true);

                // A bare { id } answers a model::request for a model the server holds nothing of; a SyncBehaviour
                // never sends one as an update. A first one is a new object, whose state a manager's TriggerSync
                // sends. A later one, after a reconnect, means the server lost the model (it clears an app's models
                // when the last client leaves, as a lone client's Wi-Fi blip looks to it, and all of them on restart),
                // so the full state goes out again. A client receiving it applies it and sends nothing back.
                //
                // That assumes the server tells a lost model from a deleted one: for MODEL_TOMBSTONE_SECONDS it answers
                // a request made again for a deleted model with model::delete (see OnModelDelete). After that the
                // answer is a bare { id }, and sending the state recreates the deleted object on every client.
                if (!isFirstUpdate && data.Count == 1 && !_hasReceivedDestroyCommand)
                    AddFullState();
                else if (isFirstUpdate && _announceAtFirstAnswer && data.Count == 1 && !_hasReceivedDestroyCommand)
                    AddFullState();
                if (isFirstUpdate)
                    _announceAtFirstAnswer = false;
            }
        }

        /// <summary>Sends the object's full state, once the server's first answer for it is in.</summary>
        public async void TriggerSync()
        {
            try
            {
                await _isReady.Task;
            }
            catch (OperationCanceledException)
            {
                // Cancelled: destroyed, or moved to another Id, before the server answered.
                return;
            }

            if (!this)
                return;

            AddFullState();
        }

        /// <summary>Every member that is switched on, as one update.</summary>
        private void AddFullState()
        {
            var self = this as T;
            foreach (var attribute in SyncMembers<T>.AttributeList)
            {
                if (IsSynced(attribute.MemberName))
                    AddUpdate(attribute, attribute.GetBoxed(self));
            }
        }


        // Changes made before the first answer.
        //
        // An object requests its state in Awake and the answer arrives a round trip later, or once connected. A
        // member changed meanwhile (in Start, an OnConnected handler, by a user right after Play) must not lose
        // to the server's older value. So the poll compares nothing until the answer, which compares each member
        // with its value from registration: a changed member keeps its value and is sent as an ordinary update,
        // the others take the answer's value. That needs getters that read the real value in base.Awake(); one
        // that reads something set up later (a cached component) reads a fallback there, and the real value
        // counts as a change at the answer.
        //
        // The answer is not the last message holding the server's older values: a manager's request for its whole
        // channel and remote updates sent before the server read the change follow. So a kept member takes
        // nothing more until the answer to one more request, sent now ahead of the change (see
        // Sync.AskForEndOfAnswers), or until the end of the reconnect round the object is in.
        // An object a manager builds from a remote update takes it as is.

        /// <summary>
        /// At the server's first answer: keeps every member changed since the object registered, and
        /// sends it. <paramref name="round"/> is the round the object is in, or null, and is opened when
        /// a member is kept outside one.
        /// </summary>
        private void KeepChangesMadeBeforeTheAnswer(JObject answer, ref ReconnectRound round)
        {
            // A disabled component sends nothing and takes what arrives.
            if (_trackers == null || _isBuiltFromUpdate || _hasReceivedDestroyCommand || !enabled)
                return;

            var self = this as T;
            for (var i = 0; i < _trackers.Length; i++)
            {
                var attribute = SyncMembers<T>.AttributeList[i];

                // A switched-off member reads a placeholder, and the latched value of one switched on since the
                // last poll may be a placeholder: neither is a change. The next poll sends the latter.
                if (!IsSynced(attribute.MemberName) || !_wasSynced[i] || !_trackers[i].CaptureChange(self))
                    continue;

                if (round == null)
                    round = _round = Sync.AskForEndOfAnswers();

                // The value the server holds, which the one sent now goes out after; if that send is lost, the
                // round after the next reconnect recognises it by this value.
                if (answer.TryGetValue(attribute.Name, out var shown))
                    SentValuesOf(attribute).ServerShowed(ToKeep(attribute, shown));

                KeepAndSendAgain(attribute);
            }
        }


        // The answers to the requests made again after a reconnect.
        //
        // A change made as the link dropped is lost and the server answers with the value from before it.
        // Applied, that undoes the change here while every other client keeps the old value. So each member of
        // what arrives in the round (see ReconnectRound) is judged against the values it sent recently and
        // the one it held before them (SentValues):
        //
        // 1. The value sent last: it arrived, nothing to do.
        // 2. A value sent before that, or the one held before them (all an object that sat still has: switched
        //    off at the drop after a minute on, it sent only the lost `false`): what followed was lost. The local
        //    value goes out again as an ordinary update under the rate limit, and the member takes nothing more
        //    from the round. The answer's value becomes the value held before the resend, so a second loss is
        //    recognised too. A remote reset to one of these values during the outage looks the same and is undone.
        // 3. Any other value, or a member that did not send recently: another client set it, and it is applied.
        //
        // A member missing from what arrives is left alone: a remote update carries only what changed.
        // Until the answers are in, a member keeps the values it had sent when the requests went out
        // (SentValues.KeepUntilAnswered). What it sends after the requests reaches the server after everything
        // in the round, so it keeps its value whatever arrives and is sent again, with what arrived as the
        // value held before it.

        /// <summary>Told by Sync that the model has just been asked for again after a reconnect.</summary>
        private void OnRequestedAgain(ReconnectRound round)
        {
            _round = round;

            if (_keptInRound != null)
                Array.Clear(_keptInRound, 0, _keptInRound.Length);
            if (_sentInRound != null)
                Array.Clear(_sentInRound, 0, _sentInRound.Length);

            if (_sentValues != null)
            {
                foreach (var sent in _sentValues)
                    sent?.KeepUntilAnswered();
            }
        }

        /// <summary>
        /// Judges one member of what arrived in the round. True when the server's value is not applied:
        /// the value sent last arrived, or the local value is kept and goes out again.
        /// </summary>
        private bool KeepsLocalValue(string name, JToken serverValue, ReconnectRound round)
        {
            if (!SyncMembers<T>.SyncedAttributes.TryGetValue(name, out var attribute))
                return false;

            // A switched-off member reads a placeholder: nothing to keep or send.
            if (!IsSynced(attribute.MemberName))
                return false;

            // Includes a member kept at the first answer, which may not have sent yet.
            if (_keptInRound != null && _keptInRound[attribute.Index])
                return true;

            var sent = _sentValues?[attribute.Index];
            if (sent == null)
                return false;

            switch (sent.Judge(serverValue, round.DisconnectedAt - SentValues.WindowSeconds))
            {
                case SentValues.Verdict.Arrived:
                    return true;

                case SentValues.Verdict.Lost:
                    break;

                default:
                    // Sent after the requests, and read by the server after this value.
                    if (_sentInRound == null || !_sentInRound[attribute.Index])
                        return false;
                    break;
            }

            // The server holds this value; if the resend is lost too, the next round recognises it by this value.
            sent.ServerShowed(ToKeep(attribute, serverValue));
            KeepAndSendAgain(attribute);
            return true;
        }

        /// <summary>Keeps the member's local value for the rest of the round, and sends it.</summary>
        private void KeepAndSendAgain(SyncMembers<T>.SyncedAttribute attribute)
        {
            _keptInRound ??= new bool[SyncMembers<T>.AttributeList.Count];
            _keptInRound[attribute.Index] = true;

            if (_hasReceivedDestroyCommand)
                return;

            // Latched as the poll would: what goes out now is not a new change.
            var self = this as T;
            _trackers?[attribute.Index].Latch(self);
            AddUpdate(attribute, attribute.GetBoxed(self));
        }


        private void OnModelDelete(JObject data)
        {
            var id = data["id"].Value<string>();
            if (id == Id)
            {
                _hasReceivedDestroyCommand = true;

                // Destroy is delayed and the ticker drives the object until OnDestroy: an update sent meanwhile (a
                // held one, or a change polled) would reach the server after the delete and recreate the model.
                _nextUpdate = null;
                SyncTicker.Deregister(this);

                Destroy(gameObject, 0.001f);
            }
        }

        private void AddUpdate(SyncMembers<T>.SyncedAttribute attribute, object value)
        {
            if (_nextUpdate == null)
                _nextUpdate = new JObject { { "id", Id } };

            if (_nextUpdate.ContainsKey(attribute.Name))
                _nextUpdate[attribute.Name] = value.ToJson();
            else
                _nextUpdate.Add(attribute.Name, value.ToJson());

            // Sent by FlushUpdate, so a frame's changes travel in one message, together with later frames'
            // while the rate limit holds it back.
        }

        // Members whose unreadable value was reported; each is reported once.
        private HashSet<string> _warnedUnreadable;

        private void WarnUnreadable(SyncMembers<T>.SyncedAttribute attribute, JToken value, Exception exception)
        {
            if (!(_warnedUnreadable ??= new HashSet<string>()).Add(attribute.Name))
                return;
            var text = value.ToString(Newtonsoft.Json.Formatting.None);
            if (text.Length > 100)
                text = text.Substring(0, 100) + "...";
            Debug.LogWarning($"Colibri: '{name}' ({Id}) received {text} for [Sync] {attribute.MemberName}, which is a "
                + $"{attribute.PropertyType.Name}: {exception.Message} Ignoring it. This is logged once per member.");
        }

        private void UpdateAttribute(string name, JToken value)
        {
            if (!SyncMembers<T>.SyncedAttributes.ContainsKey(name))
            {
                Debug.LogWarning($"Unable to sync attribute {name}");
                return;
            }

            var self = this as T;
            var attribute = SyncMembers<T>.SyncedAttributes[name];

            // Read first and set after, so only an unreadable value is caught here: an exception from a [Sync]
            // setter in application code goes on to Sync's dispatch, which reports it. A bad value must not
            // lose the rest of the update.
            object read;
            try
            {
                read = SyncValueReader.ReadValue(attribute.PropertyType, value);
            }
            catch (Exception e) when (e is InvalidCastException || e is FormatException || e is OverflowException
                || e is ArgumentException || e is InvalidOperationException)
            {
                WarnUnreadable(attribute, value, e);
                return;
            }

            if (read == SyncValueReader.UnsupportedValue)
            {
                Debug.LogError($"Unable to update attribute {name}: Unsupported type {attribute.PropertyType}");
                return;
            }
            attribute.SetBoxed(self, read);

            // What the server sent is the known state, not a change for the poll to report.
            // _trackers is null before Awake, e.g. for an object instantiated inactive; Awake latches the
            // then-current values.
            if (_trackers != null)
                _trackers[attribute.Index].Latch(self);

            // The member holds the server's value now, so what it sent before says nothing about the server.
            // If an answer after a reconnect holds this value following the member's next change, that change
            // was lost.
            SentValuesOf(attribute).ServerShowed(ToKeep(attribute, value));

            // A pending local change of this member (polled this frame, or held by the rate limit) was just
            // overwritten by the server's value. Sent anyway, it would replace that value on the server and
            // every other client while this client shows the server's, and the copies would disagree for good.
            if (_nextUpdate != null && _nextUpdate.Remove(attribute.Name) && _nextUpdate.Count == 1)
                _nextUpdate = null;
        }
    }
}
