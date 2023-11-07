using HCIKonstanz.Colibri.Synchronization;
using Newtonsoft.Json.Linq;
using System;
using UnityEngine;

namespace HCIKonstanz.Colibri.Samples
{
    public class SendMessages : MonoBehaviour
    {
        public static readonly string Channel = "SendTestMessages";

        // See Update Method
        public bool SendProperties;

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
            Sync.Receive(Channel, OnBoolMessage);
            Sync.Receive(Channel, OnIntMessage);
            Sync.Receive(Channel, (Action<float>)OnFloatMessage);
            Sync.Receive(Channel, OnStringMessage);
            Sync.Receive(Channel, (Action<Vector2>)OnVector2Message);
            Sync.Receive(Channel, (Action<Vector3>)OnVector3Message);
            Sync.Receive(Channel, OnQuaternionMessage);
            Sync.Receive(Channel, OnColorMessage);

            Sync.Receive(Channel, OnBoolArrayMessage);
            Sync.Receive(Channel, OnIntArrayMessage);
            Sync.Receive(Channel, OnFloatArrayMessage);
            Sync.Receive(Channel, OnStringArrayMessage);
            Sync.Receive(Channel, OnVector2ArrayMessage);
            Sync.Receive(Channel, OnVector3ArrayMessage);
            Sync.Receive(Channel, OnQuaternionArrayMessage);
            Sync.Receive(Channel, OnColorArrayMessage);

            Sync.Receive(Channel, (Action<JToken>)OnJsonMessage);
        }

        private void OnDisable()
        {
            Sync.Unregister(Channel, OnBoolMessage);
            Sync.Unregister(Channel, OnIntMessage);
            Sync.Unregister(Channel, (Action<float>)OnFloatMessage);
            Sync.Unregister(Channel, OnStringMessage);
            Sync.Unregister(Channel, (Action<Vector2>)OnVector2Message);
            Sync.Unregister(Channel, (Action<Vector3>)OnVector3Message);
            Sync.Unregister(Channel, OnQuaternionMessage);
            Sync.Unregister(Channel, OnColorMessage);

            Sync.Unregister(Channel, OnBoolArrayMessage);
            Sync.Unregister(Channel, OnIntArrayMessage);
            Sync.Unregister(Channel, OnFloatArrayMessage);
            Sync.Unregister(Channel, OnStringArrayMessage);
            Sync.Unregister(Channel, OnVector2ArrayMessage);
            Sync.Unregister(Channel, OnVector3ArrayMessage);
            Sync.Unregister(Channel, OnQuaternionArrayMessage);
            Sync.Unregister(Channel, OnColorArrayMessage);

            Sync.Unregister(Channel, (Action<JToken>)OnJsonMessage);
        }



        private void Update()
        {
            if (SendProperties)
            {
                SendProperties = false;

                Sync.Send(Channel, SyncedBool);
                Sync.Send(Channel, SyncedInt);
                Sync.Send(Channel, SyncedFloat);
                Sync.Send(Channel, SyncedString);
                Sync.Send(Channel, SyncedVector2);
                Sync.Send(Channel, SyncedVector3);
                Sync.Send(Channel, SyncedQuaternion);
                Sync.Send(Channel, SyncedColor);

                Sync.Send(Channel, SyncedBoolArray);
                Sync.Send(Channel, SyncedIntArray);
                Sync.Send(Channel, SyncedFloatArray);
                Sync.Send(Channel, SyncedStringArray);
                Sync.Send(Channel, SyncedVector2Array);
                Sync.Send(Channel, SyncedVector3Array);
                Sync.Send(Channel, SyncedQuaternionArray);
                Sync.Send(Channel, SyncedColorArray);

                Sync.Send("myJson", new JObject
                {
                    { "attribute1", "example" },
                    { "attribute2", 5 }
                });
            }
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

        private void OnJsonMessage(JToken jToken)
        {
            Debug.Log($"Received JSON object: {jToken}");
        }
    }
}
