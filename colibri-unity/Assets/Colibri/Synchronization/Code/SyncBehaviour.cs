using UnityEngine;
using System.Reflection;
using System.Collections.Generic;
using System;
#if !ENABLE_IL2CPP
using System.Linq.Expressions;
#endif
using Newtonsoft.Json.Linq;
using System.Linq;
using System.Threading.Tasks;
using HCIKonstanz.Colibri.Core;

namespace HCIKonstanz.Colibri.Synchronization
{
    public abstract class SyncBehaviour<T> : MonoBehaviour, SyncTicker.ITickable
        where T : SyncBehaviour<T>
    {
        private const string SupportedTypes = "bool, int, float, string, Vector2, Vector3, Quaternion, Color, JObject and arrays of those";

        /*
         *  Synced attribute metadata. Built once per model type, never per instance, and typed
         *  all the way down: the change comparison never sees `object`, so an idle synced object
         *  allocates nothing at all.
         */

        private interface IChangeTracker
        {
            /// <summary>
            /// Latches the attribute's current value and reports whether it differs from the
            /// previously latched one.
            /// </summary>
            bool CaptureChange(T target);

            /// <summary>
            /// Latches the attribute's current value without reporting it - for a value that came
            /// from the server, which must not be sent straight back as if it were a local change.
            /// </summary>
            void Latch(T target);
        }

        private abstract class SyncedAttribute
        {
            public string Name;

            /// <summary>The C# name, which <see cref="IsSynced"/> is asked about.</summary>
            public string MemberName;

            public int Index;
            public Type PropertyType;

            /// <summary>Boxes, so it is only called once a change has actually been detected.</summary>
            public abstract object GetBoxed(T target);
            public abstract void SetBoxed(T target, object value);
            public abstract IChangeTracker CreateTracker(T target);
        }

        private sealed class SyncedAttribute<TValue> : SyncedAttribute
        {
            public Func<T, TValue> Getter;
            public Action<T, TValue> Setter;

            public override object GetBoxed(T target) => Getter(target);
            public override void SetBoxed(T target, object value) => Setter(target, (TValue)value);
            public override IChangeTracker CreateTracker(T target) => new ChangeTracker<TValue>(Getter, target);
        }

        private sealed class ChangeTracker<TValue> : IChangeTracker
        {
            private readonly Func<T, TValue> _getter;
            private TValue _lastValue;

            public ChangeTracker(Func<T, TValue> getter, T target)
            {
                _getter = getter;
                _lastValue = getter(target);
            }

            public bool CaptureChange(T target)
            {
                var current = _getter(target);

                // EqualityComparer<TValue>.Default resolves to the IEquatable<> implementation
                // for Vector3/Quaternion/..., so comparing costs nothing and boxes nothing.
                if (EqualityComparer<TValue>.Default.Equals(current, _lastValue))
                    return false;

                _lastValue = current;
                return true;
            }

            public void Latch(T target)
            {
                _lastValue = _getter(target);
            }
        }


        public static event Action<SyncBehaviour<T>> ModelCreated;
        public static event Action<SyncBehaviour<T>> ModelDestroyed;

        /// <summary>
        /// The id of the model a <see cref="SyncBehaviourManager{T}"/> is building an object for,
        /// from an update another client sent, while it does so; null otherwise. Read in Awake,
        /// which runs during the build.
        /// </summary>
        internal static string RemoteModelBeingBuilt;


        private static readonly Dictionary<string, SyncedAttribute> _syncedAttributes = new Dictionary<string, SyncedAttribute>();
        private static readonly List<SyncedAttribute> _attributeList = new List<SyncedAttribute>();
        private static bool _isInitialized = false;

        private static void Initialize()
        {
            if (_isInitialized)
                return;

            _isInitialized = true;

            const BindingFlags memberFlags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;

            foreach (var prop in typeof(T).GetProperties(memberFlags))
                if (prop.IsDefined(typeof(SyncAttribute), true))
                    RegisterAttribute(prop.Name, prop.PropertyType, prop);

            foreach (var field in typeof(T).GetFields(memberFlags))
                if (field.IsDefined(typeof(SyncAttribute), true))
                    RegisterAttribute(field.Name, field.FieldType, field);
        }

        /// <summary>
        /// How a C# name - a model type or a [Sync] member - becomes its name on the wire.
        /// </summary>
        /// <remarks>
        /// Invariant on purpose. Culture-sensitive <c>ToLower()</c> turns 'I' into a dotless i
        /// (U+0131) on Turkish and Azerbaijani systems, so on such a machine "PhysicsId" went out
        /// with a character in it that neither colibri-web's <c>toLowerCase()</c> nor any other
        /// client produces, and the member silently stopped syncing.
        /// </remarks>
        internal static string ToWireName(string name) => name.ToLowerInvariant();

        /// <summary>The wire names of this model type's [Sync] members. Exists for the test suite.</summary>
        internal static IEnumerable<string> SyncedNames
        {
            get
            {
                Initialize();
                return _syncedAttributes.Keys;
            }
        }

        private static void RegisterAttribute(string memberName, Type valueType, MemberInfo member)
        {
            var name = ToWireName(memberName);
            if (_syncedAttributes.ContainsKey(name))
            {
                Debug.LogError($"Colibri: '{typeof(T).Name}' has more than one [Sync] member named '{memberName}' (names are matched case-insensitively). Rename one of them.");
                return;
            }

            var attribute = BuildAttribute(name, valueType, member);
            if (attribute == null)
                return;

            attribute.Index = _attributeList.Count;
            _attributeList.Add(attribute);
            _syncedAttributes.Add(name, attribute);
        }

        // Explicit per-type dispatch rather than MakeGenericMethod: every BuildAttribute<TValue>,
        // and with it SyncedAttribute<TValue>, ChangeTracker<TValue> and the Func/Action delegate
        // types, is a closed instantiation IL2CPP can see and compile ahead of time. It is also the
        // one place that can report up front that a [Sync] member has a type Colibri cannot put on
        // the wire.
        private static SyncedAttribute BuildAttribute(string name, Type valueType, MemberInfo member)
        {
            if (valueType == typeof(bool)) return BuildAttribute<bool>(name, member);
            if (valueType == typeof(int)) return BuildAttribute<int>(name, member);
            if (valueType == typeof(float)) return BuildAttribute<float>(name, member);
            if (valueType == typeof(string)) return BuildAttribute<string>(name, member);
            if (valueType == typeof(Vector2)) return BuildAttribute<Vector2>(name, member);
            if (valueType == typeof(Vector3)) return BuildAttribute<Vector3>(name, member);
            if (valueType == typeof(Quaternion)) return BuildAttribute<Quaternion>(name, member);
            if (valueType == typeof(Color)) return BuildAttribute<Color>(name, member);
            if (valueType == typeof(bool[])) return BuildAttribute<bool[]>(name, member);
            if (valueType == typeof(int[])) return BuildAttribute<int[]>(name, member);
            if (valueType == typeof(float[])) return BuildAttribute<float[]>(name, member);
            if (valueType == typeof(string[])) return BuildAttribute<string[]>(name, member);
            if (valueType == typeof(Vector2[])) return BuildAttribute<Vector2[]>(name, member);
            if (valueType == typeof(Vector3[])) return BuildAttribute<Vector3[]>(name, member);
            if (valueType == typeof(Quaternion[])) return BuildAttribute<Quaternion[]>(name, member);
            if (valueType == typeof(Color[])) return BuildAttribute<Color[]>(name, member);
            if (valueType == typeof(JObject)) return BuildAttribute<JObject>(name, member);

            Debug.LogError($"Colibri: cannot synchronize '{typeof(T).Name}.{member.Name}' - [Sync] does not support {valueType.Name}. Supported types are {SupportedTypes}. "
                + $"For your own classes, sync a JObject: JObject.FromObject(value, ColibriJson.Serializer), and read it back with ToObject<{valueType.Name}>(ColibriJson.Serializer) - "
                + "ColibriJson can convert the Vector3, Quaternion and Color members that Newtonsoft on its own cannot.");
            return null;
        }

        private static SyncedAttribute BuildAttribute<TValue>(string name, MemberInfo member)
        {
            if (member is PropertyInfo property)
            {
                if (property.GetGetMethod(true) == null || property.GetSetMethod(true) == null)
                {
                    Debug.LogError($"Colibri: cannot synchronize '{typeof(T).Name}.{member.Name}' - a [Sync] property needs both a getter and a setter.");
                    return null;
                }
            }
            else if (((FieldInfo)member).IsInitOnly)
            {
                Debug.LogError($"Colibri: cannot synchronize '{typeof(T).Name}.{member.Name}' - a [Sync] field cannot be readonly.");
                return null;
            }

            Func<T, TValue> getter;
            Action<T, TValue> setter;
            try
            {
#if ENABLE_IL2CPP
                CreateReflectionAccessors<TValue>(member, out getter, out setter);
#else
                CreateCompiledAccessors<TValue>(member, out getter, out setter);
#endif
            }
            catch (Exception e)
            {
                // Once per member and type, at startup - but an exception here would escape from
                // the first Awake and leave that object half set up, so it is reported instead.
                Debug.LogError($"Colibri: cannot synchronize '{typeof(T).Name}.{member.Name}' - {e.GetType().Name}: {e.Message}");
                return null;
            }

            return new SyncedAttribute<TValue>
            {
                Name = name,
                MemberName = member.Name,
                PropertyType = typeof(TValue),
                Getter = getter,
                Setter = setter
            };
        }

        /// <summary>
        /// Accessors for IL2CPP, which has no JIT: no expression trees, nothing compiled at runtime.
        /// </summary>
        /// <remarks>
        /// <para>
        /// Under IL2CPP, <c>LambdaExpression.Compile()</c> does not fail - it quietly falls back to
        /// the System.Linq.Expressions interpreter, which builds its delegate through
        /// <c>MakeGenericMethod</c> at runtime. That is slow on every call, and for value types it
        /// depends on generic code IL2CPP may not have generated. So under ENABLE_IL2CPP:
        /// </para>
        /// <para>
        /// A property gets open-instance delegates bound straight to its get and set methods - the
        /// same typed call a compiled lambda makes, so the per-frame poll stays free of allocation.
        /// </para>
        /// <para>
        /// A field goes through <c>FieldInfo.GetValue</c>/<c>SetValue</c>, as it did in 1.x. That
        /// boxes a value-type field on every poll; there is no allocation-free way to read a field
        /// through reflection without a JIT. A hot value-type member is cheaper as a property.
        /// </para>
        /// <para>
        /// Compiled on every backend so the test suite can run it in the Editor, which is always
        /// Mono. The member must already have been validated by <see cref="BuildAttribute{TValue}"/>.
        /// </para>
        /// </remarks>
        internal static void CreateReflectionAccessors<TValue>(MemberInfo member, out Func<T, TValue> getter, out Action<T, TValue> setter)
        {
            if (member is PropertyInfo property)
            {
                getter = (Func<T, TValue>)Delegate.CreateDelegate(typeof(Func<T, TValue>), property.GetGetMethod(true));
                setter = (Action<T, TValue>)Delegate.CreateDelegate(typeof(Action<T, TValue>), property.GetSetMethod(true));
                return;
            }

            var field = (FieldInfo)member;
            getter = target => (TValue)field.GetValue(target);
            setter = (target, value) => field.SetValue(target, value);
        }

#if !ENABLE_IL2CPP
        /// <summary>
        /// Accessors for Mono, compiled from expression trees: typed for properties and fields
        /// alike, so nothing boxes.
        /// </summary>
        private static void CreateCompiledAccessors<TValue>(MemberInfo member, out Func<T, TValue> getter, out Action<T, TValue> setter)
        {
            var exTarget = Expression.Parameter(typeof(T), "target");
            var exValue = Expression.Parameter(typeof(TValue), "value");

            Expression exGet;
            Expression exSet;

            if (member is PropertyInfo property)
            {
                // see: https://stackoverflow.com/a/17669142/4090817
                exGet = Expression.Call(exTarget, property.GetGetMethod(true));
                exSet = Expression.Call(exTarget, property.GetSetMethod(true), exValue);
            }
            else
            {
                var field = (FieldInfo)member;
                exGet = Expression.Field(exTarget, field);
                exSet = Expression.Assign(Expression.Field(exTarget, field), exValue);
            }

            getter = Expression.Lambda<Func<T, TValue>>(exGet, exTarget).Compile();
            setter = Expression.Lambda<Action<T, TValue>>(exSet, exTarget, exValue).Compile();
        }
#endif


        public string Id;

        public string ModelId = "";
        private readonly string ChannelPrefix = ToWireName(typeof(T).Name);
        internal string Channel { get => ChannelPrefix + (String.IsNullOrEmpty(ModelId) ? "" : $"_{ModelId}"); }

        // Parallel to _attributeList.
        private IChangeTracker[] _trackers;

        // Parallel to _attributeList: whether IsSynced said yes at the last poll.
        private bool[] _wasSynced;

        private JObject _nextUpdate;

        // The send-rate limit (SyncSettings.MaxSendRate): when this object may send next, on
        // SyncTicker's clock, and when it last did. Changes before then wait in _nextUpdate.
        private double _nextSendTime = double.NegativeInfinity;
        private double _lastSendTime = double.NegativeInfinity;

        // The object's own active flag as the last poll saw it, and whether that poll saw it
        // switched - which goes out at once, past the limit.
        private bool _wasActive;
        private bool _sendAtOnce;

        // Parallel to _attributeList, each made when its member is first sent or first takes a value
        // from elsewhere: the values the member sent around the time the connection last worked,
        // and the one it held before them. Null for an object that has done neither.
        private SentValues[] _sentValues;

        // The round of answers to the requests made again after the last reconnect, while they are
        // still coming in (see Sync.ReconnectRound), or the one this object opened at its first
        // answer to keep changes made before it (see "Changes made before the first answer");
        // null otherwise.
        private Sync.ReconnectRound _round;

        // Parallel to _attributeList: the members whose last change the round showed to have been
        // lost with the connection, or to be read by the server after what arrived. Each keeps its
        // value, which goes out again, and takes nothing more from the round.
        private bool[] _keptInRound;

        // Parallel to _attributeList: the members that sent after the requests of the round went
        // out. The server reads what they sent after everything that arrives in the round.
        private bool[] _sentInRound;

        private bool _isQuitting;
        private bool _hasReceivedDestroyCommand;
        private bool _hasReceivedFirstUpdate;

        // Built by a manager from another client's update, which is its first update: nothing of
        // this client's is kept over it.
        private bool _isBuiltFromUpdate;

        // Given its id in Awake, a fresh one: the server holds nothing for the object.
        private bool _hasMadeItsId;

        private readonly TaskCompletionSource<bool> _isReady = new TaskCompletionSource<bool>();

        private int _tickIndex = -1;
        int SyncTicker.ITickable.TickIndex { get => _tickIndex; set => _tickIndex = value; }

        /// <summary>
        /// Whether Awake has run, which is where the object registers: false for one that has been
        /// switched off since its scene loaded. The change trackers are made there.
        /// </summary>
        internal bool HasAwoken => _trackers != null;

        /// <summary>
        /// Whether this client knows what the server holds for the object: its first answer has
        /// arrived, or the object made its id in Awake, so the server holds nothing for it yet.
        /// </summary>
        private protected bool KnowsServerState => _hasReceivedFirstUpdate || _hasMadeItsId;

        /// <summary>The id whose answer ends the round this object is in; null when it is in none. For the EditMode tests.</summary>
        internal string RoundEndMarker => _round == null || _round.IsOver ? null : _round.EndMarkerId;


        /// <summary>
        /// Whether the [Sync] member named <paramref name="memberName"/> (its C# name) is switched
        /// on. One that is off is never sent: not as a change, not in the full state that
        /// <see cref="TriggerSync"/> sends.
        /// </summary>
        /// <remarks>
        /// A switched-off member still has a getter, and the value it reads is no value of the
        /// object's - SyncTransform's Position reads Vector3.zero while SyncPosition is off. Sent,
        /// that placeholder is applied by every client that has the member switched on: the
        /// object jumps to the origin there.
        ///
        /// Asked for every member in every poll, so it must be cheap and must not allocate.
        /// Switched on again, the member is sent whatever it reads.
        /// </remarks>
        private protected virtual bool IsSynced(string memberName) => true;


        protected virtual void Awake()
        {
            Initialize();

            // Awake only ever runs on an object in a scene - a placed or an instantiated one,
            // never a prefab asset - so there is no prefab case to exclude here.
            if (String.IsNullOrEmpty(Id))
            {
                Id = Guid.NewGuid().ToString();
                _hasMadeItsId = true;
            }

            var self = this as T;
            _trackers = new IChangeTracker[_attributeList.Count];
            _wasSynced = new bool[_attributeList.Count];
            for (var i = 0; i < _attributeList.Count; i++)
            {
                _trackers[i] = _attributeList[i].CreateTracker(self);
                _wasSynced[i] = IsSynced(_attributeList[i].MemberName);
            }
            _wasActive = gameObject.activeSelf;

            SyncTicker.Register(this);

            // A model::request { id } is a fresh request: it tells the server that this client has
            // the object in its scene now, or is creating it, and the server lifts the tombstone of
            // a model of that id deleted a moment ago. Right for an object placed in a scene or
            // created here. Not for one a manager builds from another client's update, which
            // carries the model's state already: the model may have been deleted since the server
            // relayed that update. Asked for, it lost its tombstone, and an update another client
            // had sent before the delete then created it afresh on the server and on every client.
            if (RemoteModelBeingBuilt != null && RemoteModelBeingBuilt == Id)
            {
                _isBuiltFromUpdate = true;
                Sync.AddModelUpdateListenerWithoutRequest(Channel, OnModelUpdate, Id, OnRequestedAgain);
            }
            else
            {
                // In this client's scene again, so updates for it are no longer ones that were on
                // their way when this client deleted it.
                LocallyDeletedModels.Forget(Channel, Id);
                Sync.AddModelUpdateListener(Channel, OnModelUpdate, Id, OnRequestedAgain);
            }
            Sync.AddModelDeleteListener(Channel, OnModelDelete);

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
            // An update the send-rate limit still holds is dropped with the object, and the
            // delete below goes out at once: sent after the delete, the update would bring the
            // object back to life on the server.
            SyncTicker.Deregister(this);

            Sync.RemoveModelUpdateListener(Channel, OnModelUpdate);
            Sync.RemoveModelDeleteListener(Channel, OnModelDelete);

            ModelDestroyed?.Invoke(this);

            // Shutting down is not deleting: the object is meant to outlive this client on the
            // server. _isQuitting alone cannot tell, because Unity sends OnApplicationQuit only
            // to active GameObjects - and a synced object is inactive whenever this client or
            // another one has hidden it. Such an object deleted itself, and with it every other
            // client's copy, on the way out of Play mode or the app. Application.quitting
            // (SingletonLifetime.IsQuitting) is raised before teardown whatever the object's state.
            if (_isQuitting || SingletonLifetime.IsQuitting || _hasReceivedDestroyCommand)
                return;

            // So that an update another client sent before the server had this delete does not
            // make a manager build the object again - see LocallyDeletedModels.
            LocallyDeletedModels.Remember(Channel, Id);
            Sync.SendModelDelete(Channel, Id);
            _isReady.TrySetCanceled();
        }


        /*
         *  Driven by SyncTicker - one Update and one LateUpdate for the whole application.
         */

        void SyncTicker.ITickable.PollChanges()
        {
            // Gated on the component alone. An inactive GameObject is still polled, because its
            // being inactive is itself synced state: SyncTransform's Active reads activeSelf, and
            // gated on isActiveAndEnabled the poll stopped the moment the object was switched
            // off - so `false` was never seen, and other clients' copies never disappeared.
            //
            // Teardown sends nothing through here. Destroy, unloading a scene and leaving Play
            // mode do not touch activeSelf, and the object leaves the ticker in OnDestroy, before
            // any further poll could run. No OnDisable hook is involved either, so none of those
            // can be mistaken for a deactivation.
            //
            // A component that is switched off on its own (enabled = false) neither latches nor
            // sends, so whatever changed meanwhile is picked up as a normal change once it is
            // back on.
            if (!enabled)
                return;

            var self = this as T;
            for (var i = 0; i < _trackers.Length; i++)
            {
                var attribute = _attributeList[i];
                var isSynced = IsSynced(attribute.MemberName);
                var switchedOn = isSynced && !_wasSynced[i];
                _wasSynced[i] = isSynced;

                // A member that is switched off reads a placeholder, which is no value to send -
                // and no value to compare with either, so it is not latched.
                if (!isSynced)
                    continue;

                // Switched on again, the member goes out whatever it reads: the other clients
                // still have the value from before it was switched off, and what it reads now
                // may differ from that while being equal to anything latched here meanwhile -
                // SyncTransform's scale set back to one while SyncScale was off is just what its
                // placeholder reads. Compared, that change was never sent.
                if (switchedOn)
                {
                    _trackers[i].Latch(self);
                    if (_hasReceivedFirstUpdate)
                        AddUpdate(attribute, attribute.GetBoxed(self));
                    continue;
                }

                // Until the server's first answer for this object, nothing is compared or latched:
                // the answer compares each member with the value it had when the object
                // registered (see "Changes made before the first answer" below).
                if (!_hasReceivedFirstUpdate)
                    continue;

                if (_trackers[i].CaptureChange(self))
                    AddUpdate(attribute, attribute.GetBoxed(self));
            }

            // Switching the object off or on is not held back by the send-rate limit: it is a
            // one-off event rather than motion, and hiding an object is often the last thing that
            // happens to it. Whatever is waiting goes out with it, in this frame.
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
        /// The update to send in this frame, if one is due, applying the send-rate limit. The
        /// deciding half of FlushUpdate; internal so the tests can run it on a clock of their own.
        /// </summary>
        /// <remarks>
        /// Leading edge first: a change after a quiet spell goes out at once, so a one-off change
        /// is exactly as quick as without a limit. Changes in the interval after that are held,
        /// merged into one update, and sent as soon as the interval is up - by the ticker, which
        /// flushes every object in every frame, so the last values of a burst go out whether or
        /// not anything changes after them.
        /// </remarks>
        internal JObject TakeDueUpdate(double now, double interval, double heardAt)
        {
            var sendAtOnce = _sendAtOnce;
            _sendAtOnce = false;

            if (_nextUpdate == null)
                return null;

            // The slot was set with the interval of the last send. A limit raised since then -
            // SyncSettings.MaxSendRate set from code - shortens the wait for what is held now:
            // otherwise a change held under 1 per second still waited out the full second after
            // the limit had become 30. A lowered limit takes effect from the next slot on.
            var due = Math.Min(_nextSendTime, _lastSendTime + interval);

            if (interval > 0 && now < due && !sendAtOnce)
                return null;

            // The next slot is one interval after the previous slot, not after now. Frames rarely
            // land on the interval: at 72 fps a 30 Hz limit is passed 8 ms late, and counting from
            // now would round every interval up to three frames - 24 Hz. Carried over, the lateness
            // is made up in the next interval. Only while the object keeps sending, though: after a
            // pause, or a send forced early, it starts afresh, so no backlog of sends builds up.
            var late = now - due;
            _nextSendTime = late >= 0 && late < interval ? due + interval : now + interval;
            _lastSendTime = now;

            var update = _nextUpdate;
            _nextUpdate = null;
            RememberSent(update, now, heardAt);
            return update;
        }

        /// <summary>
        /// Keeps the values of an update that is going out, for the answers to the request made
        /// again after a reconnect. See <see cref="KeepsLocalValue"/>.
        /// </summary>
        private void RememberSent(JObject update, double now, double heardAt)
        {
            var answersPending = _round != null && !_round.IsOver;

            // Walked by hand: Properties() would allocate an enumerator for every update sent.
            for (var token = update.First; token != null; token = token.Next)
            {
                var property = (JProperty)token;
                if (!_syncedAttributes.TryGetValue(property.Name, out var attribute))
                    continue;

                SentValuesOf(attribute).Remember(ToKeep(attribute, property.Value), now, heardAt, answersPending);

                if (answersPending)
                    (_sentInRound ??= new bool[_attributeList.Count])[attribute.Index] = true;
            }
        }

        private SentValues SentValuesOf(SyncedAttribute attribute)
        {
            _sentValues ??= new SentValues[_attributeList.Count];
            return _sentValues[attribute.Index] ??= new SentValues();
        }

        /// <summary>
        /// A value as SentValues keeps it. Every other value is made afresh for each update, but a
        /// JObject member's is the application's own object, which it may change in place later.
        /// </summary>
        private static JToken ToKeep(SyncedAttribute attribute, JToken value)
            => attribute.PropertyType == typeof(JObject) ? value.DeepClone() : value;


        public void OnModelUpdate(JObject data)
        {
            // The member table is per type and was only ever built in Awake, so an update reaching
            // an object of a type no instance of which had woken yet found no members, and every
            // value in it was dropped with an "Unable to sync attribute" warning.
            Initialize();

            var id = data["id"].Value<string>();
            if (id == Id)
            {
                var isFirstUpdate = !_hasReceivedFirstUpdate;
                _hasReceivedFirstUpdate = true;

                // While the answers to the requests made again after the last reconnect are
                // coming in, everything received is judged against what this object sent before
                // the outage: see "The answers to the requests made again after a reconnect" below.
                // So is everything received after a first answer over which this object kept
                // changes of its own, until the answers still on their way then are in: see
                // "Changes made before the first answer".
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

                _isReady.TrySetResult(true);

                // A bare { id } is the server's answer to a model::request for a model it holds
                // nothing of; a SyncBehaviour never sends one as an update. The first such answer
                // is the usual start of a new object, and what follows it is unchanged: a
                // manager's TriggerSync sends the full state. A later one answers the request made
                // again after a reconnect, and is taken to mean the server has lost this object -
                // it clears an app's models when its last client leaves, which is what a lone
                // client's Wi-Fi blip looks like from the server, and all of them when it restarts.
                // Nothing used to put the state back, so every client that joined afterwards was
                // missing the object. The full state carries members, so a client receiving it
                // applies it and sends nothing in return.
                //
                // That reading relies on the server telling a lost model from a deleted one. Another
                // client may have deleted this object while this client was offline, and the delete
                // it relayed never arrived here. The server remembers such a delete for
                // MODEL_TOMBSTONE_SECONDS and answers the request with model::delete, which
                // OnModelDelete handles: this copy goes too, and nothing is sent. Answered with a
                // bare { id } instead - by a server that does not remember deletes, or after that
                // time is up - this sends the deleted object's state, and every client builds it
                // again.
                if (!isFirstUpdate && data.Count == 1 && !_hasReceivedDestroyCommand)
                    AddFullState();
            }
        }

        public async void TriggerSync()
        {
            try
            {
                await _isReady.Task;
            }
            catch (OperationCanceledException)
            {
                // destroyed before the server ever sent its state - nothing left to sync
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
            foreach (var attribute in _attributeList)
            {
                if (IsSynced(attribute.MemberName))
                    AddUpdate(attribute, attribute.GetBoxed(self));
            }
        }


        /*
         *  Changes made before the first answer.
         *
         *  An object asks the server for its state when it registers, in Awake, and the answer
         *  arrives a round trip later, or once the connection is up. A member changed in between,
         *  in a script's Start or OnConnected handler or by a user right after Play, used to be
         *  latched by the poll without being sent, and the answer then put the server's value over
         *  it: the change was undone on this client and never reached any other.
         *
         *  So the poll compares nothing until the first answer, and the answer compares each member
         *  with the value it had when the object registered. A member that differs keeps its value,
         *  which goes out as an ordinary update; the server reads it after the answer, and every
         *  other client takes it from there. Every other member takes the answer's value, so a
         *  value from the scene or the prefab, or one set in Awake before base.Awake(), never goes
         *  out over the server's. That needs a getter to read the object's value in base.Awake()
         *  already: one that reads a field set up after it, a cached component say, reads its
         *  fallback there and the real value at the answer, which counts as a change.
         *
         *  The answer is not the last message that can hold the server's older values. A manager
         *  asks for every model on its channel, usually in the same frame as the object asks for
         *  its own, and the answer to that holds this object too; an update another client sent
         *  before the server read the change is relayed here as well. Applied, either undid the
         *  change on this client alone. So a member kept takes nothing more until the answer to
         *  one more request, sent now, ahead of the change: the server has answered every request
         *  made before by then (see Sync.AskForEndOfAnswers). It is kept as a member is in the
         *  round after a reconnect, and an object whose first answer arrives in that round, one
         *  registered during the outage, keeps it in that round instead.
         *
         *  An object a manager builds from another client's update takes that update as it is:
         *  what its own Awake set is no change of this client's.
         */

        /// <summary>
        /// At the server's first answer for this object: keeps every member changed since the
        /// object registered, and sends it. <paramref name="round"/> is the round the object is
        /// in, or null, and is opened when a member is kept outside one.
        /// </summary>
        private void KeepChangesMadeBeforeTheAnswer(JObject answer, ref Sync.ReconnectRound round)
        {
            // A component that is switched off sends nothing, and takes what arrives.
            if (_trackers == null || _isBuiltFromUpdate || _hasReceivedDestroyCommand || !enabled)
                return;

            var self = this as T;
            for (var i = 0; i < _trackers.Length; i++)
            {
                var attribute = _attributeList[i];

                // A member that is switched off reads a placeholder, and one switched on since the
                // last poll was compared with one: neither is a change. The next poll sends the
                // latter, as it sends every member switched on.
                if (!IsSynced(attribute.MemberName) || !_wasSynced[i] || !_trackers[i].CaptureChange(self))
                    continue;

                if (round == null)
                    round = _round = Sync.AskForEndOfAnswers();

                // The value the server holds, which the one sent now goes out after. Should that be
                // lost in a link that drops before the server has read it, the round after the
                // reconnect tells it by this value.
                if (answer.TryGetValue(attribute.Name, out var shown))
                    SentValuesOf(attribute).ServerShowed(ToKeep(attribute, shown));

                KeepAndSendAgain(attribute);
            }
        }


        /*
         *  The answers to the requests made again after a reconnect.
         *
         *  A change made the moment the connection dropped was written into a dead link and lost,
         *  and the server answers with what it held before that change. Applied like any other
         *  update, the answer put the object back on the very client that had changed it, and
         *  every other client kept the old value too. So each member of what arrives in the round
         *  (see Sync.ReconnectRound) is compared with the values that member sent recently, and
         *  with the one it held before them (SentValues):
         *
         *  - the value sent last: it arrived, and there is nothing to do;
         *  - a value sent before that, or the one held before them: what followed it was lost. The
         *    local value stays and goes out again, as an ordinary update under the send-rate
         *    limit, and the member takes nothing more from the round: whatever else the round
         *    brings for it, the server had before it read the value sent again, which then
         *    replaces it there and on every other client. The answer's value is kept as the one
         *    held before the value sent again, so if that is lost as well, at a drop soon after,
         *    the next round still tells;
         *  - any other value: another client set it while this one was away, and it is applied,
         *    as it always was. So is a member that was not sent recently at all.
         *
         *  The value held before them is what an object that sat still before the drop has to go
         *  by: switched off at the drop after a minute switched on, it sent nothing but the lost
         *  `false` in the window. Another client that sets a member back during the outage, to one
         *  of those values, is undone in turn: that looks the same, and is accepted.
         *
         *  A member missing from what arrives is left alone. An update from another client
         *  carries only what that client changed, so a missing member says nothing about what
         *  the server holds for it. Read as "the server has no value", it would send this
         *  client's value over one that another client set during the outage. So a member whose
         *  very first value was the one lost stays unsent, as it did before.
         *
         *  An object that has never sent anything - one a manager built from another client's
         *  update, say - applies its answers exactly as before, and so does every object once the
         *  round is over: an update from another client is applied as it arrives.
         *
         *  Until then, each member keeps the values it had sent when the requests went out
         *  (SentValues.KeepUntilAnswered): what it sends after them cannot be in an answer, and an
         *  object moved on right after the reconnect would push out the values sent into the dead
         *  link, so that the answer holding one was applied.
         *
         *  What a member sends after the requests reaches the server after everything that arrives
         *  in the round, and replaces it there and on every other client. So such a member keeps
         *  its value whatever arrives, even a value it never held: applied here, that stayed on
         *  this client alone, and a one-off change such as a switch never mended it. It is treated
         *  as a lost change, and sent again, so that what arrived is kept as the value held before
         *  it: if the link drops again before the server has read it, the next round tells.
         */

        /// <summary>Told by Sync that the model has just been asked for again after a reconnect.</summary>
        private void OnRequestedAgain(Sync.ReconnectRound round)
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
        /// Judges one member of what arrived in the round. True when the server's value is not to
        /// be applied: the value this object sent last arrived, or what it sent after the server's
        /// value was lost or went out after the requests, and goes out again now.
        /// </summary>
        private bool KeepsLocalValue(string name, JToken serverValue, Sync.ReconnectRound round)
        {
            if (!_syncedAttributes.TryGetValue(name, out var attribute))
                return false;

            // A member that is switched off reads a placeholder, which is no value to keep or send.
            if (!IsSynced(attribute.MemberName))
                return false;

            // Kept before it has sent anything, too: a member changed before the first answer.
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

            // The server holds this value, and the one sent again goes out after it. Should that be
            // lost too, in a link that drops again soon after, the next round tells it by this value.
            sent.ServerShowed(ToKeep(attribute, serverValue));
            KeepAndSendAgain(attribute);
            return true;
        }

        /// <summary>Keeps the member's local value for the rest of the round, and sends it.</summary>
        private void KeepAndSendAgain(SyncedAttribute attribute)
        {
            _keptInRound ??= new bool[_attributeList.Count];
            _keptInRound[attribute.Index] = true;

            if (_hasReceivedDestroyCommand)
                return;

            // Latched, as the poll would have: what goes out now is not a change to report again.
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

                // Destroyed a moment from now rather than at once, and until OnDestroy the ticker
                // went on driving the object: an update it sent in that moment - one the send-rate
                // limit was holding, or a change polled meanwhile - reached the server after the
                // delete and created the model there afresh. Every other client's manager then
                // built a ghost of it, and nobody was left to delete it again. Nothing about this
                // object goes out any more.
                _nextUpdate = null;
                SyncTicker.Deregister(this);

                Destroy(gameObject, 0.001f);
            }
        }

        private void AddUpdate(SyncedAttribute attribute, object value)
        {
            if (_nextUpdate == null)
                _nextUpdate = new JObject { { "id", Id } };

            if (_nextUpdate.ContainsKey(attribute.Name))
                _nextUpdate[attribute.Name] = value.ToJson();
            else
                _nextUpdate.Add(attribute.Name, value.ToJson());

            // The message itself goes out in FlushUpdate(), so all of this frame's changes
            // travel together in one message - together with the next frames' too, while the
            // send-rate limit holds it back.
        }

        private void UpdateAttribute(string name, JToken value)
        {
            if (!_syncedAttributes.ContainsKey(name))
            {
                Debug.LogWarning($"Unable to sync attribute {name}");
                return;
            }

            var self = this as T;
            var attribute = _syncedAttributes[name];

            if (attribute.PropertyType == typeof(bool))
                attribute.SetBoxed(self, value.Value<bool>());
            else if (attribute.PropertyType == typeof(int))
                attribute.SetBoxed(self, value.Value<int>());
            else if (attribute.PropertyType == typeof(float))
                attribute.SetBoxed(self, value.Value<float>());
            else if (attribute.PropertyType == typeof(string))
                attribute.SetBoxed(self, value.Value<string>());
            else if (attribute.PropertyType == typeof(Vector2))
                attribute.SetBoxed(self, value.ToVector2());
            else if (attribute.PropertyType == typeof(Vector3))
                attribute.SetBoxed(self, value.ToVector3());
            else if (attribute.PropertyType == typeof(Quaternion))
                attribute.SetBoxed(self, value.ToQuaternion());
            else if (attribute.PropertyType == typeof(Color))
                attribute.SetBoxed(self, value.ToColor());
            else if (attribute.PropertyType == typeof(bool[]))
                attribute.SetBoxed(self, value.Select(x => (bool)x).ToArray());
            else if (attribute.PropertyType == typeof(int[]))
                attribute.SetBoxed(self, value.Select(x => (int)x).ToArray());
            else if (attribute.PropertyType == typeof(float[]))
                attribute.SetBoxed(self, value.Select(x => (float)x).ToArray());
            else if (attribute.PropertyType == typeof(string[]))
                attribute.SetBoxed(self, value.Select(x => (string)x).ToArray());
            else if (attribute.PropertyType == typeof(Vector2[]))
                attribute.SetBoxed(self, value.Select(x => x.ToVector2()).ToArray());
            else if (attribute.PropertyType == typeof(Vector3[]))
                attribute.SetBoxed(self, value.Select(x => x.ToVector3()).ToArray());
            else if (attribute.PropertyType == typeof(Quaternion[]))
                attribute.SetBoxed(self, value.Select(x => x.ToQuaternion()).ToArray());
            else if (attribute.PropertyType == typeof(Color[]))
                attribute.SetBoxed(self, value.Select(x => x.ToColor()).ToArray());
            else if (attribute.PropertyType == typeof(JObject))
                attribute.SetBoxed(self, value);
            else
                Debug.LogError($"Unable to update attribute {name}: Unsupported type {attribute.PropertyType}");

            // What the server sent is now the known state, not a change for the poll to report.
            // This used to be a per-attribute "received, swallow the next change" flag instead,
            // which went stale whenever the poll saw no change afterwards - two updates between
            // polls that ended where they started, or any update while the component was off -
            // and then silently swallowed the next genuine local change.
            //
            // Null only before Awake, when OnModelUpdate reaches an object that was instantiated
            // inactive; Awake then latches every current value anyway.
            if (_trackers != null)
                _trackers[attribute.Index].Latch(self);

            // The member holds another client's value now, and what it sent before that says
            // nothing about the server any more: an answer after the next reconnect holding one of
            // those values again was set back to it by someone else. The value it holds now does:
            // the server holds it too, so an answer holding it after this member's next change
            // says that change was lost. A JObject is the application's own object from here on,
            // and is copied.
            SentValuesOf(attribute).ServerShowed(ToKeep(attribute, value));

            // A local change of the same member that is still waiting to be sent - polled earlier
            // this frame, or held by the send-rate limit - has just been overwritten here by the
            // server's value. Sent anyway, it would overwrite that value on the server and every
            // other client too, while this client goes on showing the server's: the copies would
            // disagree for good. Dropped, they all agree on the value this client now shows.
            if (_nextUpdate != null && _nextUpdate.Remove(attribute.Name) && _nextUpdate.Count == 1)
                _nextUpdate = null;
        }
    }
}
