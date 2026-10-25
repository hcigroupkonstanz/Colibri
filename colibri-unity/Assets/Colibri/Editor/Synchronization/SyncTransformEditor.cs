using UnityEditor;
using UnityEngine;
using System.Linq;
using System;
using HCIKonstanz.Colibri.Core;

namespace HCIKonstanz.Colibri.Synchronization
{
    [CustomEditor(typeof(SyncTransform))]
    // Without this attribute, Unity shows no Inspector when several objects are selected.
    [CanEditMultipleObjects]
    public class SyncTransformEditor : Editor
    {
        [InitializeOnLoadMethod]
        private static void WatchDuplicateIds()
        {
            // Entering Play mode with a domain reload runs this again; OnPlayModeStateChanged checks then.
            if (!EditorApplication.isPlayingOrWillChangePlaymode)
                CheckDuplicateIds();
            EditorApplication.playModeStateChanged += OnPlayModeStateChanged;
        }

        // Not RuntimeInitializeOnLoadMethod(BeforeSceneLoad), which runs before the scene's objects exist.
        // EnteredPlayMode comes after the scene is loaded, with or without a domain reload.
        private static void OnPlayModeStateChanged(PlayModeStateChange state)
        {
            if (state == PlayModeStateChange.EnteredPlayMode)
                CheckDuplicateIds();
        }

        private static void CheckDuplicateIds()
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
                    // Through SerializedObject, which records the id as a prefab override and as an undo step.
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
