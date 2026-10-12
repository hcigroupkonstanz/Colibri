using HCIKonstanz.Colibri.Synchronization;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace HCIKonstanz.Colibri.Samples
{
    public class SendMessages : MonoBehaviour
    {
        public static readonly string Channel = "myChannel";

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

        // Naming the type - Sync.Receive<float> - is what makes this unambiguous. Without it the
        // compiler has to pick between one Receive overload per supported type, and some of these
        // handlers would need an explicit (Action<float>)-style cast.
        private void OnEnable()
        {
            Sync.Receive<bool>(Channel, OnBoolMessage);
            Sync.Receive<int>(Channel, OnIntMessage);
            Sync.Receive<float>(Channel, OnFloatMessage);
            Sync.Receive<string>(Channel, OnStringMessage);
            Sync.Receive<Vector2>(Channel, OnVector2Message);
            Sync.Receive<Vector3>(Channel, OnVector3Message);
            Sync.Receive<Quaternion>(Channel, OnQuaternionMessage);
            Sync.Receive<Color>(Channel, OnColorMessage);

            Sync.Receive<bool[]>(Channel, OnBoolArrayMessage);
            Sync.Receive<int[]>(Channel, OnIntArrayMessage);
            Sync.Receive<float[]>(Channel, OnFloatArrayMessage);
            Sync.Receive<string[]>(Channel, OnStringArrayMessage);
            Sync.Receive<Vector2[]>(Channel, OnVector2ArrayMessage);
            Sync.Receive<Vector3[]>(Channel, OnVector3ArrayMessage);
            Sync.Receive<Quaternion[]>(Channel, OnQuaternionArrayMessage);
            Sync.Receive<Color[]>(Channel, OnColorArrayMessage);

            Sync.Receive<JToken>(Channel, OnJsonMessage);
        }

        // Destroying this object would drop these listeners on its own - Colibri knows they belong
        // to it. Disabling it does not, because the object is still very much alive, so the pairing
        // with OnEnable is what stops a disabled component from going on receiving.
        private void OnDisable()
        {
            Sync.Unregister<bool>(Channel, OnBoolMessage);
            Sync.Unregister<int>(Channel, OnIntMessage);
            Sync.Unregister<float>(Channel, OnFloatMessage);
            Sync.Unregister<string>(Channel, OnStringMessage);
            Sync.Unregister<Vector2>(Channel, OnVector2Message);
            Sync.Unregister<Vector3>(Channel, OnVector3Message);
            Sync.Unregister<Quaternion>(Channel, OnQuaternionMessage);
            Sync.Unregister<Color>(Channel, OnColorMessage);

            Sync.Unregister<bool[]>(Channel, OnBoolArrayMessage);
            Sync.Unregister<int[]>(Channel, OnIntArrayMessage);
            Sync.Unregister<float[]>(Channel, OnFloatArrayMessage);
            Sync.Unregister<string[]>(Channel, OnStringArrayMessage);
            Sync.Unregister<Vector2[]>(Channel, OnVector2ArrayMessage);
            Sync.Unregister<Vector3[]>(Channel, OnVector3ArrayMessage);
            Sync.Unregister<Quaternion[]>(Channel, OnQuaternionArrayMessage);
            Sync.Unregister<Color[]>(Channel, OnColorArrayMessage);

            Sync.Unregister<JToken>(Channel, OnJsonMessage);
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

                // Same channel as everything else above: the JToken listener registered in
                // OnEnable listens on Channel, so sending this anywhere else would make the
                // sample's own JSON round trip unobservable from the sample.
                Sync.Send(Channel, new JObject
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
