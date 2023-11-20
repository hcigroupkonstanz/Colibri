#if UNITY_EDITOR
using UnityEditor;
using UnityEngine;
using System.Linq;
using System;

namespace HCIKonstanz.Colibri.Synchronization
{
    [CustomEditor(typeof(SyncTransform))]
    public class SyncTransformEditor : Editor
    {
        [InitializeOnLoadMethod]
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
        static void CheckDuplicateIds()
        {
            var transforms = FindObjectsOfType<SyncTransform>();
            var uniqueIds = transforms.Select(t => t.Id).Distinct();

            if (transforms.Length > uniqueIds.Count())
                Debug.LogWarning("Scene contains multiple overlapping SyncTransform IDs!");
        }

        public override void OnInspectorGUI()
        {
            base.OnInspectorGUI();
            SyncTransform synctransform = (SyncTransform)target;

            if (synctransform)
            {
                if (GUILayout.Button("Generate ID"))
                {
                    synctransform.Id = Guid.NewGuid().ToString();
                    EditorUtility.SetDirty(synctransform);
                }
            }
        }
    }
}
#endif
