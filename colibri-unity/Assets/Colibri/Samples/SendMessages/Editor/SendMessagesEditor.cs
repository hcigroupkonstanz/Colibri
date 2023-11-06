#if UNITY_EDITOR
using HCIKonstanz.Colibri.Synchronization;
using UnityEditor;
using UnityEngine;

namespace HCIKonstanz.Colibri.Samples
{
    [CustomEditor(typeof(SendMessages))]
    public class SendMessagesEditor : Editor
    {
        public override void OnInspectorGUI()
        {
            base.OnInspectorGUI();
            SendMessages s = (SendMessages)target;

            if (s && Application.isPlaying)
            {
                if (GUILayout.Button("Sync Bool"))
                    Sync.Send(SendMessages.Channel, s.SyncedBool);
                if (GUILayout.Button("Sync Int"))
                    Sync.Send(SendMessages.Channel, s.SyncedInt);
                if (GUILayout.Button("Sync Float"))
                    Sync.Send(SendMessages.Channel, s.SyncedFloat);
                if (GUILayout.Button("Sync String"))
                    Sync.Send(SendMessages.Channel, s.SyncedString);
                if (GUILayout.Button("Sync Vector2"))
                    Sync.Send(SendMessages.Channel, s.SyncedVector2);
                if (GUILayout.Button("Sync Vector3"))
                    Sync.Send(SendMessages.Channel, s.SyncedVector3);
                if (GUILayout.Button("Sync Quaternion"))
                    Sync.Send(SendMessages.Channel, s.SyncedQuaternion);
                if (GUILayout.Button("Sync Color"))
                    Sync.Send(SendMessages.Channel, s.SyncedColor);

                if (GUILayout.Button("Sync BoolArray"))
                    Sync.Send(SendMessages.Channel, s.SyncedBoolArray);
                if (GUILayout.Button("Sync IntArray"))
                    Sync.Send(SendMessages.Channel, s.SyncedIntArray);
                if (GUILayout.Button("Sync FloatArray"))
                    Sync.Send(SendMessages.Channel, s.SyncedFloatArray);
                if (GUILayout.Button("Sync StringArray"))
                    Sync.Send(SendMessages.Channel, s.SyncedStringArray);
                if (GUILayout.Button("Sync Vector2Array"))
                    Sync.Send(SendMessages.Channel, s.SyncedVector2Array);
                if (GUILayout.Button("Sync Vector3Array"))
                    Sync.Send(SendMessages.Channel, s.SyncedVector3Array);
                if (GUILayout.Button("Sync QuaternionArray"))
                    Sync.Send(SendMessages.Channel, s.SyncedQuaternionArray);
                if (GUILayout.Button("Sync ColorArray"))
                    Sync.Send(SendMessages.Channel, s.SyncedColorArray);
            }
        }
    }
}
#endif
