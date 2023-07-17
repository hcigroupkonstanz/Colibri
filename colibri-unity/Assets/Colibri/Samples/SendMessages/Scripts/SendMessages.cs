using HCIKonstanz.Colibri.Synchronization;
using UnityEngine;

namespace HCIKonstanz.Colibri.Samples
{
    public class SendMessages : MonoBehaviour
    {
        public static readonly string Channel = "SendTestMessages";

        public bool SyncedBool;
        public int SyncedInt;
        public float SyncedFloat;
        public string SyncedString;
        public Vector2 SyncedVector2;
        public Vector3 SyncedVector3;
        public Quaternion SyncedQuaternion;
        public Color SyncedColor;

        public bool[] SyncedBoolArray;
        public int[] SyncedIntArray;
        public float[] SyncedFloatArray;
        public string[] SyncedStringArray;
        public Vector2[] SyncedVector2Array;
        public Vector3[] SyncedVector3Array;
        public Quaternion[] SyncedQuaternionArray;
        public Color[] SyncedColorArray;


        private void OnEnable()
        {
            Sync.AddBoolListener(Channel, OnBoolMessage);
            Sync.AddIntListener(Channel, OnIntMessage);
            Sync.AddFloatListener(Channel, OnFloatMessage);
            Sync.AddStringListener(Channel, OnStringMessage);
            Sync.AddVector2Listener(Channel, OnVector2Message);
            Sync.AddVector3Listener(Channel, OnVector3Message);
            Sync.AddQuaternionListener(Channel, OnQuaternionMessage);
            Sync.AddColorListener(Channel, OnColorMessage);

            Sync.AddBoolArrayListener(Channel, OnBoolArrayMessage);
            Sync.AddIntArrayListener(Channel, OnIntArrayMessage);
            Sync.AddFloatArrayListener(Channel, OnFloatArrayMessage);
            Sync.AddStringArrayListener(Channel, OnStringArrayMessage);
            Sync.AddVector2ArrayListener(Channel, OnVector2ArrayMessage);
            Sync.AddVector3ArrayListener(Channel, OnVector3ArrayMessage);
            Sync.AddQuaternionArrayListener(Channel, OnQuaternionArrayMessage);
            Sync.AddColorArrayListener(Channel, OnColorArrayMessage);
        }

        private void OnDisable()
        {
            Sync.RemoveBoolListener(Channel, OnBoolMessage);
            Sync.RemoveIntListener(Channel, OnIntMessage);
            Sync.RemoveFloatListener(Channel, OnFloatMessage);
            Sync.RemoveStringListener(Channel, OnStringMessage);
            Sync.RemoveVector2Listener(Channel, OnVector2Message);
            Sync.RemoveVector3Listener(Channel, OnVector3Message);
            Sync.RemoveQuaternionListener(Channel, OnQuaternionMessage);
            Sync.RemoveColorListener(Channel, OnColorMessage);

            Sync.RemoveBoolArrayListener(Channel, OnBoolArrayMessage);
            Sync.RemoveIntArrayListener(Channel, OnIntArrayMessage);
            Sync.RemoveFloatArrayListener(Channel, OnFloatArrayMessage);
            Sync.RemoveStringArrayListener(Channel, OnStringArrayMessage);
            Sync.RemoveVector2ArrayListener(Channel, OnVector2ArrayMessage);
            Sync.RemoveVector3ArrayListener(Channel, OnVector3ArrayMessage);
            Sync.RemoveQuaternionArrayListener(Channel, OnQuaternionArrayMessage);
            Sync.RemoveColorArrayListener(Channel, OnColorArrayMessage);
        }


        private void OnBoolMessage(bool val)
        {
            Debug.Log($"Received message with value '{val}'");
            SyncedBool = val;
        }

        private void OnIntMessage(int val)
        {
            Debug.Log($"Received message with value '{val}'");
            SyncedInt = val;
        }

        private void OnFloatMessage(float val)
        {
            Debug.Log($"Received message with value '{val}'");
            SyncedFloat = val;
        }

        private void OnStringMessage(string val)
        {
            Debug.Log($"Received message with value '{val}'");
            SyncedString = val;
        }

        private void OnVector2Message(Vector2 val)
        {
            Debug.Log($"Received message with value '{val}'");
            SyncedVector2 = val;
        }

        private void OnVector3Message(Vector3 val)
        {
            Debug.Log($"Received message with value '{val}'");
            SyncedVector3 = val;
        }

        private void OnQuaternionMessage(Quaternion val)
        {
            Debug.Log($"Received message with value '{val}'");
            SyncedQuaternion = val;
        }

        private void OnColorMessage(Color val)
        {
            Debug.Log($"Received message with value '{val}'");
            SyncedColor = val;
        }



        private void OnBoolArrayMessage(bool[] val)
        {
            Debug.Log($"Received message with value '{val}'");
            SyncedBoolArray = val;
        }

        private void OnIntArrayMessage(int[] val)
        {
            Debug.Log($"Received message with value '{val}'");
            SyncedIntArray = val;
        }

        private void OnFloatArrayMessage(float[] val)
        {
            Debug.Log($"Received message with value '{val}'");
            SyncedFloatArray = val;
        }

        private void OnStringArrayMessage(string[] val)
        {
            Debug.Log($"Received message with value '{val}'");
            SyncedStringArray = val;
        }

        private void OnVector2ArrayMessage(Vector2[] val)
        {
            Debug.Log($"Received message with value '{val}'");
            SyncedVector2Array = val;
        }

        private void OnVector3ArrayMessage(Vector3[] val)
        {
            Debug.Log($"Received message with value '{val}'");
            SyncedVector3Array = val;
        }

        private void OnQuaternionArrayMessage(Quaternion[] val)
        {
            Debug.Log($"Received message with value '{val}'");
            SyncedQuaternionArray = val;
        }

        private void OnColorArrayMessage(Color[] val)
        {
            Debug.Log($"Received message with value '{val}'");
            SyncedColorArray = val;
        }
    }
}
