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

        // Last value set through Color. A LocalColor that differs from it was edited in the Inspector.
        private Color _appliedColor;

        private Renderer _renderer;
        protected override void Awake()
        {
            // Set before base.Awake(), which latches every [Sync] member: the Color getter reads _renderer,
            // and a member changed after that latch is kept over the server's first answer.
            _renderer = GetComponent<Renderer>();
            Color = LocalColor;
            base.Awake();
        }

        private void Update()
        {
            // Applies edits to LocalColor made in the Inspector.
            if (LocalColor != _appliedColor)
                Color = LocalColor;
        }
    }
}
