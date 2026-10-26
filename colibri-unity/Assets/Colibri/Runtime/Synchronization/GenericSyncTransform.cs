using Newtonsoft.Json.Linq;
using UnityEngine;

namespace HCIKonstanz.Colibri.Synchronization
{
    public abstract class GenericSyncTransform<T> : SyncBehaviour<T> where T : SyncBehaviour<T>
    {
        /// <summary>
        /// The object's own active flag (<c>activeSelf</c>), synced like any other member. A remote
        /// update switches it, and the poll keeps running while the object is inactive. Disabling
        /// only this component or deactivating a parent leaves it unchanged, so neither hides the
        /// other copies.
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

        // World pose of the last remote update; see LatchMovedWithParent.
        private bool _hasReceivedPose;
        private Vector3 _receivedPosition;
        private Quaternion _receivedRotation;

        // Synced children that sync their world pose (an avatar's hands below its body) move with this
        // object and would send that as a change of their own, so they latch the new pose.
        private protected override void AfterUpdateApplied(JObject update)
        {
            // Hot path: every remote update of every SyncTransform passes here.
            if (!(update.ContainsKey("position") || update.ContainsKey("rotation")))
                return;

            if (!UseLocalTransform)
            {
                _hasReceivedPose = true;
                _receivedPosition = transform.position;
                _receivedRotation = transform.rotation;
            }

            if (transform.childCount == 0)
                return;
            foreach (var part in GetComponentsInChildren<ISyncedObject>(true))
            {
                if (!ReferenceEquals(part, this))
                    part.LatchMovedWithParent();
            }
        }

        // Moved by a synced parent's remote update. Its own last remote update may have come first in the
        // same batch, so that pose is restored (with none yet it follows the parent). Latched either way.
        private protected override void LatchMovedWithParent()
        {
            // A local pose does not change when the parent moves.
            if (UseLocalTransform)
                return;
            if (_hasReceivedPose)
            {
                if (SyncPosition)
                    transform.position = _receivedPosition;
                if (SyncRotation)
                    transform.rotation = _receivedRotation;
            }
            Latch(nameof(Position));
            Latch(nameof(Rotation));
        }

        // An unticked member's getter returns a placeholder (origin, identity, one, active). Never send
        // it: clients that sync the member would apply it.
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


        [Sync]
        public string PhysicsId
        {
            get
            {
                if (PhysicsAuthority) _physicsId = PhysicsClient.Id;
                return _physicsId;
            }
            set
            {
                _physicsId = value;
                PhysicsAuthority = _physicsId == PhysicsClient.Id;

                // The server holds this client's previous run as owner, and that run has ended. Take the
                // physics back on the next FixedUpdate so the poll sends this run's id.
                if (!PhysicsAuthority && PhysicsClient.WasPreviousRun(_physicsId))
                    _takesPhysicsBack = true;
            }
        }
        private string _physicsId;
        private bool _takesPhysicsBack;

        [Header("Physics")]
        public bool PhysicsAuthority = false;
        public bool isKinematic;

        private Rigidbody _rigidbody;

        private bool _isSimulatedWithoutServerState;

        private void Start()
        {
            _rigidbody = GetComponent<Rigidbody>();
        }

        private void FixedUpdate() => HoldOrSimulate(Time.unscaledTimeAsDouble);

        // now is on SyncTicker's clock. Internal so the EditMode tests can pass a clock of their own.
        internal void HoldOrSimulate(double now)
        {
            if (_takesPhysicsBack)
            {
                _takesPhysicsBack = false;
                PhysicsAuthority = true;
            }

            if (_rigidbody)
            {
                // Kinematic until the server's state is known: a placed body with PhysicsAuthority ticked
                // holds it on every client until the first answer, so on a late joiner it would fall and
                // send that over the shared position. Without a server for the connect timeout it is
                // simulated anyway, and stays so once connected.
                if (PhysicsAuthority && !KnowsServerState && !_isSimulatedWithoutServerState)
                    _isSimulatedWithoutServerState = Sync.StopsWaitingForServer(now);

                if (PhysicsAuthority && (KnowsServerState || _isSimulatedWithoutServerState))
                    _rigidbody.isKinematic = isKinematic;
                else
                    _rigidbody.isKinematic = true;
            }
        }
    }
}
