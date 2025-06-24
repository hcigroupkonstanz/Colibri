using System;
using System.Collections;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using HCIKonstanz.Colibri.Core;
using HCIKonstanz.Colibri.Setup;
using UnityEngine;

namespace HCIKonstanz.Colibri.Networking
{
    public class VoiceServerConnection : SingletonBehaviour<VoiceServerConnection>
    {
        private UdpClient udpClient;
        private IPEndPoint sendIPEndPoint;
        private IPEndPoint receiveIPEndPoint;
        private IPEndPoint inEndPoint = new IPEndPoint(IPAddress.Any, 0);
        private List<Byte> receivedBytes;
        private Thread udpThread;
        private static LockFreeQueue<VoicePacket> queuedVoicePackets = new LockFreeQueue<VoicePacket>();
        private readonly Dictionary<int, List<Action<VoicePacket>>> voicePacketListeners = new Dictionary<int, List<Action<VoicePacket>>>();
        private bool isConnected = false;


        private void OnEnable()
        {
            DontDestroyOnLoad(this);
            if (!String.IsNullOrEmpty(ColibriConfig.Load().ServerAddress))
                Connect();
        }

        private void OnDisable()
        {
            if (udpClient != null)
                udpClient.Dispose();
            udpThread.Abort();
        }

        private void Update()
        {
            if (isConnected)
            {
                while (queuedVoicePackets.Dequeue(out var packet))
                {
                    Invoke(packet);
                }
            }
        }

        private void Connect()
        {
            var ip = Dns.GetHostEntry(ColibriConfig.Load().ServerAddress);
            if (ip.AddressList.Length > 0)
            {
                sendIPEndPoint = new IPEndPoint(ip.AddressList[0], ColibriConfig.Load().VoiceServerPort);
                receiveIPEndPoint = new IPEndPoint(IPAddress.Any, 9014);

                udpClient = new UdpClient();
                udpClient.ExclusiveAddressUse = false;
                udpClient.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
                udpClient.Client.Bind(receiveIPEndPoint);
                udpThread = new Thread(new ThreadStart(Receive));
                udpThread.Name = "Voice UDP Thread";
                udpThread.Start();

                isConnected = true;
            }
            else
            {
                Debug.LogError($"Could not resolve {ColibriConfig.Load().ServerAddress}");
                enabled = false;
            }
        }

        private void Receive()
        {
            while (true)
            {
                try
                {
                    byte[] bytes = udpClient.Receive(ref inEndPoint);
                    // Debug.Log(bytes.Length + " bytes recieved");
                    VoicePacket voicePacket = GetVoicePacket(bytes);
                    if (voicePacket.Id != 0)
                    {
                        queuedVoicePackets.Enqueue(voicePacket);
                    }
                }
                catch (Exception e)
                {
                    Debug.Log(e.ToString());
                }
            }
        }

        public void SendByteData(short id, short sequence, short frameSize, Codec codec, byte[] data)
        {
            byte[] bytes = AddMetadataBytes(id, sequence, frameSize, codec, data);
            udpClient.Send(bytes, bytes.Length, sendIPEndPoint);
        }

        public void AddVoicePacketListener(short id, Action<VoicePacket> listener)
        {
            if (!voicePacketListeners.ContainsKey(id))
                voicePacketListeners.Add(id, new List<Action<VoicePacket>>());
            voicePacketListeners[id].Add(listener);
        }

        public void RemoveVoicePacketListener(short id, Action<VoicePacket> listener)
        {
            if (voicePacketListeners.ContainsKey(id))
        {
            var list = voicePacketListeners[id];
            list.Remove(listener);
            if (list.Count == 0)
                voicePacketListeners.Remove(id);
        }
        }

        private void Invoke(VoicePacket voicePacket)
        {
            if (voicePacketListeners.ContainsKey(voicePacket.Id))
            {
                foreach (var voicePacketListener in voicePacketListeners[voicePacket.Id].ToArray())
                    voicePacketListener.Invoke(voicePacket);
            }
        }

        private VoicePacket GetVoicePacket(byte[] data)
        {
            short id = BitConverter.ToInt16(data, 0);
            short sequence = BitConverter.ToInt16(data, 2);
            short frameSize = BitConverter.ToInt16(data, 4);
            Codec codec = (Codec)data[6];
            byte[] sampleData = new byte[data.Length - 7];
            Array.Copy(data, 7, sampleData, 0, sampleData.Length);
            return new VoicePacket() { Id = id, Sequence = sequence, FrameSize = frameSize, Codec = codec, Data = sampleData };
        }

        private byte[] AddMetadataBytes(short id, short sequence, short frameSize, Codec codec, byte[] data)
        {
            byte[] bytes = new byte[data.Length + 7];
            byte[] idBytes = BitConverter.GetBytes(id);
            byte[] sequenceBytes = BitConverter.GetBytes(sequence);
            byte[] frameSizeBytes = BitConverter.GetBytes(frameSize);
            byte codecByte = (byte)codec;
            Array.Copy(idBytes, bytes, 2);
            Array.Copy(sequenceBytes, 0, bytes, 2, 2);
            Array.Copy(frameSizeBytes, 0, bytes, 4, 2);
            bytes[6] = codecByte;
            Array.Copy(data, 0, bytes, 7, data.Length);
            return bytes;
        }
    }
}
