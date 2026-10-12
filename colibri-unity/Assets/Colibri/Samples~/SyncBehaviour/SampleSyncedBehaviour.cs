using HCIKonstanz.Colibri.Synchronization;
using UnityEngine;

namespace HCIKonstanz.Colibri.Samples
{
    public class SampleSyncedBehaviour : SyncBehaviour<SampleSyncedBehaviour>
    {
        [Sync, SerializeField]
        private int RandomValue;

        [Sync]
        public string EditorTestString = "123";

        [Sync]
        private Vector3 Position
        {
            get { return transform.localPosition; }
            set { transform.localPosition = value; }
        }

        [Sync]
        public Vector3 Scale
        {
            get { return transform.localScale; }
            set { transform.localScale = value; }
        }

        [Sync]
        public Quaternion Rotation
        {
            get { return transform.localRotation; }
            set { transform.localRotation = value; }
        }


        [Sync]
        public Color Color
        {
            get { return _renderer ? _renderer.material.color : Color.black; }
            set
            {
                if (_renderer)
                    _renderer.material.color = value;
                LocalColor = _appliedColor = value;
            }
        }

        public Color LocalColor;

        // The color last applied, so that Update applies LocalColor only once it is edited.
        private Color _appliedColor;

        private Renderer _renderer;
        protected override void Awake()
        {
            // Before base.Awake(), which reads every [Sync] member once: the server's first answer
            // replaces each member that still reads that value, and keeps each one that does not.
            _renderer = GetComponent<Renderer>();
            Color = LocalColor;
            base.Awake();
        }

        private void Update()
        {
            // apply updates from unity editor (for demo purposes)
            if (LocalColor != _appliedColor)
                Color = LocalColor;
        }
    }
}
