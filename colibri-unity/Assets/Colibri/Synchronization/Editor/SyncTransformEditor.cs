#if UNITY_EDITOR
using UnityEditor;
using UnityEngine;
using System.Linq;
using System;
using HCIKonstanz.Colibri.Core;

namespace HCIKonstanz.Colibri.Synchronization
{
    [CustomEditor(typeof(SyncTransform))]
    public class SyncTransformEditor : Editor
    {
        [InitializeOnLoadMethod]
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
        static void CheckDuplicateIds()
        {
            var transforms = UnityCompat.FindAll<SyncTransform>();
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
                    // Through SerializedObject, which records an override on a prefab instance, and
                    // undo. Set on the component and marked dirty, the id of a prefab instance was
                    // not saved: it was back to the prefab's on Play or when the scene was reloaded,
                    // so placed copies of one prefab shared an empty id. One id per selected object.
                    foreach (var selected in targets)
                    {
                        var serialized = new SerializedObject(selected);
                        serialized.FindProperty(nameof(SyncTransform.Id)).stringValue = Guid.NewGuid().ToString();
                        serialized.ApplyModifiedProperties();
                    }
                }
            }
        }
    }
}
#endif
