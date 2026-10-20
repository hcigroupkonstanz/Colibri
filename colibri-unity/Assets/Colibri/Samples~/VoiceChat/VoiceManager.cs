using System.Collections.Generic;
using HCIKonstanz.Colibri.Communication;
using HCIKonstanz.Colibri.Synchronization;
using UnityEngine;

public class VoiceManager : MonoBehaviour
{
    public static readonly string CHANNEL = "VoiceChatSample";
    public short Id;
    public float DisconnectUserAfterSeconds = 2f;
    public VoiceBroadcast VoiceBroadcast;
    public GameObject VoiceReceiverPrefab;

    
    private float timeSinceLastSended = 1f;
    private Dictionary<int, GameObject> clients;
    private Dictionary<int, float> clientsLastHeartbeat;

    void OnEnable()
    {
        Id = (short)UnityEngine.Random.Range(1, 32000);

        Sync.Receive<int>(CHANNEL, OnIdArrived);

        VoiceBroadcast.StartBroadcast(Id);
    }

    void OnDisable()
    {
        Sync.Unregister<int>(CHANNEL, OnIdArrived);

        VoiceBroadcast.StopBroadcast();
    }

    void Update()
    {
        // The id doubles as a heartbeat: receivers drop a client that sends none for
        // DisconnectUserAfterSeconds.
        timeSinceLastSended += Time.deltaTime;
        if (timeSinceLastSended > 1f)
        {
            Sync.Send(CHANNEL, Id);
            timeSinceLastSended = 0f;
        }

        if (clientsLastHeartbeat != null)
        {
            List<int> removeIds = new List<int>();
            foreach (int id in clientsLastHeartbeat.Keys)
            {
                if (clientsLastHeartbeat[id] + DisconnectUserAfterSeconds < Time.time)
                {
                    removeIds.Add(id);
                }
            }
            foreach (int id in removeIds)
            {
                Destroy(clients[id]);
                clients.Remove(id);
                clientsLastHeartbeat.Remove(id);
            }
        }
    }

    private void OnIdArrived(int id)
    {
        if (clients == null)
        {
            clients = new Dictionary<int, GameObject>();
            clientsLastHeartbeat = new Dictionary<int, float>();
        }

        if (!clients.ContainsKey(id))
        {
            GameObject voiceReceiverPrefab = Instantiate(VoiceReceiverPrefab);
            clients.Add(id, voiceReceiverPrefab);
            clientsLastHeartbeat.Add(id, Time.time);
            // Play back the voice of the client with this id.
            voiceReceiverPrefab.GetComponent<VoiceReceiver>().StartPlayback((short)id);
        }
        else
        {
            clientsLastHeartbeat[id] = Time.time;
        }

    }

}
