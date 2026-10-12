using UnityEngine;

namespace HCIKonstanz.Colibri.Synchronization
{
    public abstract class GenericSyncTransform<T> : SyncBehaviour<T> where T : SyncBehaviour<T>
    {
        /// <summary>
        /// The object's own active flag (<c>activeSelf</c>). Switching the object off or on is
        /// sent like any other change - the poll keeps running while the object is inactive - and
        /// an update from another client switches it here. Disabling only this component, or
        /// deactivating a parent, leaves this flag alone, so neither hides the other copies.
        /// </summary>
        [Sync]
        public bool Active
        {
            get
            {
                if (SyncActive) return gameObject.activeSelf;
                return true;
            }
            set
            {
                if (SyncActive) gameObject.SetActive(value);
            }
        }

        public bool SyncActive = true;

        [Sync]
        public Vector3 Position
        {
            get
            {
                if (SyncPosition)
                {
                    if (UseLocalTransform) return transform.localPosition;
                    return transform.position;
                }
                return Vector3.zero;
            }
            set
            {
                if (SyncPosition)
                {
                    if (UseLocalTransform) { transform.localPosition = value; }
                    else { transform.position = value; }
                }
            }
        }

        public bool SyncPosition = true;

        [Sync]
        public Quaternion Rotation
        {
            get
            {
                if (SyncRotation)
                {
                    if (UseLocalTransform) return transform.localRotation;
                    return transform.rotation;
                }
                return Quaternion.identity;
            }
            set
            {
                if (SyncRotation)
                {
                    if (UseLocalTransform) { transform.localRotation = value; }
                    else { transform.rotation = value; }
                }
            }
        }

        public bool SyncRotation = true;

        [Sync]
        public Vector3 Scale
        {
            get
            {
                if (SyncScale) return transform.localScale;
                return Vector3.one;
            }
            set
            {
                if (SyncScale) transform.localScale = value;
            }
        }

        public bool SyncScale = true;

        public bool UseLocalTransform = false;

        /// <summary>
        /// The Sync* boxes. A member whose box is unticked reads a placeholder above (the origin,
        /// no rotation, scale one, active), which must never go on the wire: a client with that
        /// box ticked would apply it.
        /// </summary>
        private protected override bool IsSynced(string memberName)
        {
            switch (memberName)
            {
                case nameof(Active): return SyncActive;
                case nameof(Position): return SyncPosition;
                case nameof(Rotation): return SyncRotation;
                case nameof(Scale): return SyncScale;
                default: return true;
            }
        }


        private string clientPhysicsId = System.Guid.NewGuid().ToString();

        [Sync]
        public string PhysicsId
        {
            get
            {
                if (PhysicsAuthority) _physicsId = clientPhysicsId;
                return _physicsId;
            }
            set
            {
                _physicsId = value;
                PhysicsAuthority = _physicsId == clientPhysicsId;
            }
        }
        private string _physicsId;

        [Header("Physics")]
        public bool PhysicsAuthority = false;
        public bool isKinematic;

        // Component.rigidbody, long obsolete, is only gone from 6000.5 on: before that this hides it.
#if UNITY_6000_5_OR_NEWER
        private Rigidbody rigidbody;
#else
        private new Rigidbody rigidbody;
#endif

        // Simulated although the server's state is not known: no server was reached in time.
        private bool _isSimulatedWithoutServerState;

        void Start()
        {
            rigidbody = GetComponent<Rigidbody>();
        }

        void FixedUpdate() => HoldOrSimulate(Time.unscaledTimeAsDouble);

        /// <summary>
        /// FixedUpdate at <paramref name="now"/>, on SyncTicker's clock. Internal so the EditMode
        /// tests can run it on a clock of their own.
        /// </summary>
        internal void HoldOrSimulate(double now)
        {
            if (rigidbody)
            {
                // Simulated only once the server's state is known. A placed object whose
                // PhysicsAuthority is ticked has it on every client until the first answer, and on
                // a client that joined later it fell from its spot in the scene meanwhile. That
                // counted as a change made before the answer, and went out over the position the
                // other clients shared.
                //
                // Without a server, though, it stayed frozen for good. So once this client has
                // been without one for the connect timeout, the body is simulated anyway, and goes
                // on being simulated when the connection comes up, rather than stopping in mid-air
                // until its answer arrives.
                if (PhysicsAuthority && !KnowsServerState && !_isSimulatedWithoutServerState)
                    _isSimulatedWithoutServerState = Sync.StopsWaitingForServer(now);

                if (PhysicsAuthority && (KnowsServerState || _isSimulatedWithoutServerState))
                    rigidbody.isKinematic = isKinematic;
                else
                    rigidbody.isKinematic = true;
            }
        }
    }
}