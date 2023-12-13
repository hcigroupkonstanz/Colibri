using Colibri.Networking;
using Google.FlatBuffers;
using HCIKonstanz.Colibri.Core;
using HCIKonstanz.Colibri.Setup;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UniRx;
using UnityEngine;

namespace HCIKonstanz.Colibri.Networking
{
    public enum ConnectionStatus { Connected, Disconnected, Connecting, Reconnecting };

    [DefaultExecutionOrder(-100)]
    public class WebServerConnection : SingletonBehaviour<WebServerConnection>
    {
        const int UNITY_SERVER_PORT = 9012;
        const int BUFFER_SIZE = 10 * 1024 * 1024;
        const long HEARTBEAT_TIMEOUT_THRESHOLD_MS = 2000;
        const int SOCKET_TIMEOUT_MS = 500;
        const int RECONNECT_DELAY_MS = 5 * 1000;
        const int VERSION = 1;

        private static Socket _socket;
        private static AsyncCallback _receiveCallback = new AsyncCallback(ReceiveData);
        private static byte[] _receiveBuffer = new byte[BUFFER_SIZE];
        private static int _receiveBufferOffset = 0;
        private static int _expectedPacketSize = -1;

        private static UTF8Encoding _encoding = new UTF8Encoding();
        private static LockFreeQueue<InPacket> _queuedCommands = new LockFreeQueue<InPacket>();

        public delegate void MessageAction(string channel, string command, JToken payload);
        public event MessageAction OnMessageReceived;
        public event Action OnConnected;
        public event Action OnDisconnected;

        private Task _connectionTask;
        private static long LastHeartbeatTime;
        private readonly List<byte[]> _msgQueue = new List<byte[]>();

        private BehaviorSubject<bool> _isConnected = new BehaviorSubject<bool>(false);
        public IObservable<bool> Connected => _isConnected.Where(x => x).First();


        // workaround to execute events in main unity thread
        private bool fireOnConnected;
        private bool fireOnDisconnected;
        private ConnectionStatus _status = ConnectionStatus.Disconnected;
        public ConnectionStatus Status
        {
            get { return _status; }
            private set
            {
                if (_status != value)
                {
                    _status = value;
                    if (_status == ConnectionStatus.Connected)
                    {
                        fireOnConnected = true;
                        _isConnected.OnNext(true);
                    }
                    else
                    {
                        _isConnected.OnNext(false);
                    }

                    if (_status == ConnectionStatus.Disconnected)
                        fireOnDisconnected = true;
                }
            }
        }


        private struct PacketHeader
        {
            public int PacketSize;
            public int PacketStartOffset;
            public bool IsHeartbeat;
        }

        private struct InPacket
        {
            public string channel;
            public string command;
            public JToken payload;
        }



        private void OnEnable()
        {
            DontDestroyOnLoad(this);

            if (!String.IsNullOrEmpty(ColibriConfig.Load().ServerAddress))
                Connect();

            // to get rid of unity warning
            var ignoreUnityCompilerWarning = new InPacket
            {
                channel = "",
                command = "",
                payload = null
            };
        }

        private void OnDisable()
        {
            if (_socket != null)
                _socket.Dispose();
            _socket = null;
        }

        private void Reconnect()
        {
            if (_socket != null)
            {
                try
                {
                    _socket.Disconnect(false);
                }
                catch (Exception e)
                {
                    Debug.LogWarning(e.Message);
                }

                _socket.Dispose();
                _socket = null;
            }

            Status = ConnectionStatus.Disconnected;

            Connect();
        }

        private void Connect()
        {
            Status = ConnectionStatus.Connecting;
            bool isReconnect = _socket != null;

            if (_socket != null)
                _socket.Dispose();

            _socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
            _socket.NoDelay = true;
            _socket.ReceiveTimeout = SOCKET_TIMEOUT_MS;
            _socket.SendTimeout = SOCKET_TIMEOUT_MS;

            // avoid multithreading problems due to variable changes...
            var ip = ColibriConfig.Load().ServerAddress;
            var app = ColibriConfig.Load().AppName;
            var socket = _socket;
            // Can only be called from main thread
            var hostname = SystemInfo.deviceName;


            Task.Run(async () =>
            {
                Debug.Log("Connecting to " + ip);
                if (isReconnect)
                {
                    Status = ConnectionStatus.Reconnecting;
                    await Task.Delay(RECONNECT_DELAY_MS);
                }

                try
                {
                    _receiveBufferOffset = 0;
                    _expectedPacketSize = -1;

                    socket.Connect(ip, UNITY_SERVER_PORT);
                    socket.BeginReceive(_receiveBuffer, _receiveBufferOffset, _receiveBuffer.Length - _receiveBufferOffset, SocketFlags.None, _receiveCallback, null);
                    await SendHandshake(VERSION, app, hostname);
                    Debug.Log("Connection to web server established");
                    LastHeartbeatTime = DateTimeOffset.Now.ToUnixTimeMilliseconds();
                    Status = ConnectionStatus.Connected;

                    while (_msgQueue.Count > 0)
                    {
                        var isSent = await SendDataAsync(_msgQueue[0]);
                        if (isSent)
                            _msgQueue.RemoveAt(0);
                        else
                            // something went wrong, abort and retry later!
                            break;
                    }
                }
                catch (SocketException ex)
                {
                    Debug.LogError(ex.Message);
                    Debug.Log($"Unable to connect to server {ip}, trying again in a few seconds...");
                    Status = ConnectionStatus.Disconnected;
                }
            });

        }

        private void Update()
        {
            if (fireOnConnected)
            {
                OnConnected?.Invoke();
                fireOnConnected = false;
            }

            if (fireOnDisconnected)
            {
                OnDisconnected?.Invoke();
                fireOnDisconnected = false;
            }

            if (Status == ConnectionStatus.Connected)
            {
                while (_queuedCommands.Dequeue(out var packet))
                {
                    OnMessageReceived?.Invoke(packet.channel, packet.command, packet.payload);
                }

                if (Math.Abs(LastHeartbeatTime - DateTimeOffset.Now.ToUnixTimeMilliseconds()) > HEARTBEAT_TIMEOUT_THRESHOLD_MS)
                {
                    Status = ConnectionStatus.Disconnected;
                    Debug.Log("Connection lost, trying to reconnect...");
                }
            }

            if (Status == ConnectionStatus.Disconnected && !String.IsNullOrEmpty(ColibriConfig.Load().AppName))
            {
                Connect();
            }
        }


        private static void ReceiveData(IAsyncResult asyncResult)
        {
            try
            {
                int numReceived = _socket.EndReceive(asyncResult);
                Debug.Assert(numReceived >= 0, "Received negative amount of bytes from surface connection");

                var processingOffset = 0;
                var bufferEnd = _receiveBufferOffset + numReceived;
                LastHeartbeatTime = DateTimeOffset.Now.ToUnixTimeMilliseconds();

                while (processingOffset < bufferEnd)
                {
                    if (_expectedPacketSize <= 0)
                    {
                        if (HasPacketHeader(processingOffset))
                        {
                            var header = GetPacketHeader(processingOffset);

                            if (header.IsHeartbeat)
                                processingOffset += header.PacketSize;
                            else
                            {
                                processingOffset = header.PacketStartOffset;
                                _expectedPacketSize = header.PacketSize;
                            }
                        }
                        else
                        {
                            Debug.LogWarning("Invalid packet received, skipping ahead!");
                            while (processingOffset < bufferEnd && !HasPacketHeader(processingOffset))
                                processingOffset++;

                        }
                    }
                    else if (processingOffset + _expectedPacketSize <= bufferEnd)
                    {
                        byte[] rawPacket = new byte[_expectedPacketSize];
                        Buffer.BlockCopy(_receiveBuffer, processingOffset, rawPacket, 0, rawPacket.Length);

                        var message = Message.GetRootAsMessage(new ByteBuffer(rawPacket));

                        try
                        {
                            JToken payload;
                            if (message.Payload.StartsWith("{") || message.Payload.StartsWith("["))
                                payload = JToken.Parse(message.Payload);
                            else
                                payload = new JValue(message.Payload);

                            // messages have to be handled in main update() thread, to avoid possible threading issues in handlers
                            _queuedCommands.Enqueue(new InPacket
                            {
                                channel = message.Channel,
                                command = message.Command,
                                payload = payload
                            });
                        }
                        catch (Exception e)
                        {
                            Debug.LogError(e.Message);
                            Debug.LogError(message.Payload);
                        }

                        processingOffset += _expectedPacketSize;
                        _expectedPacketSize = -1;
                    }
                    else
                    {
                        // neither header nor complete package
                        // -> currently incomplete packet in buffer, wait for rest
                        break;
                    }
                }

                if (processingOffset == bufferEnd)
                {
                    // cleared buffer entirely, no need to rearrange memory due to incomplete packet
                    _receiveBufferOffset = 0;
                }
                else
                {
                    // incomplete packet in buffer, move to front
                    _receiveBufferOffset = bufferEnd - processingOffset;
                    Buffer.BlockCopy(_receiveBuffer, processingOffset, _receiveBuffer, 0, _receiveBufferOffset);
                }


                if (_receiveBuffer.Length - _receiveBufferOffset < 100)
                {
                    var error = "Receive buffer getting too small, aborting receive";
                    Debug.LogError(error);
                    throw new OverflowException(error);
                }

                _socket.BeginReceive(_receiveBuffer, _receiveBufferOffset, _receiveBuffer.Length - _receiveBufferOffset, SocketFlags.None, _receiveCallback, null);
            }
            catch (Exception)
            {
                // ignore.
            }
        }


        /*
         *  Message format:
         *  \0\0\0 (Packet header as string) \0 (Actual packet json string)
         */

        private static bool HasPacketHeader(int offset)
        {
            if (offset + 2 >= _receiveBuffer.Length)
            {
                return false;
            }

            if (_receiveBuffer[offset] == '\0' &&
                _receiveBuffer[offset + 1] == '\0' &&
                _receiveBuffer[offset + 2] == '\0')
            {
                return true;
            }

            return false;
        }

        private static PacketHeader GetPacketHeader(int offset)
        {
            var start = offset + 3;
            var end = start;

            if (_receiveBuffer[start] == 'h')
            {
                return new PacketHeader
                {
                    PacketSize = 5,
                    IsHeartbeat = true
                };
            }

            while (end < _receiveBuffer.Length && _receiveBuffer[end] != '\0')
            {
                // searching ...
                end++;
            }

            if (end >= _receiveBuffer.Length)
            {
                throw new OverflowException("Receive buffer overflow");
            }

            // don't want to deal with integer formatting, so it's transmitted as text instead
            byte[] packetSizeRaw = new byte[end - start + 1];
            Buffer.BlockCopy(_receiveBuffer, start, packetSizeRaw, 0, packetSizeRaw.Length);
            var packetSizeText = _encoding.GetString(packetSizeRaw);

            return new PacketHeader
            {
                PacketSize = int.Parse(packetSizeText),
                PacketStartOffset = end + 1,
                IsHeartbeat = false
            };
        }


        private async Task<bool> SendHandshake(int version, string app, string hostname)
        {
            if (_socket != null)
            {
                try
                {
                    SocketAsyncEventArgs socketAsyncData = new SocketAsyncEventArgs();
                    var encoding = new UTF8Encoding();
                    var buffer = encoding.GetBytes($"\0\0\0h\0{version}::{app}::{hostname}\0");

                    socketAsyncData.SetBuffer(buffer, 0, buffer.Length);
                    _socket.SendAsync(socketAsyncData);
                    var signal = new SemaphoreSlim(0, 1);

                    socketAsyncData.Completed += (sender, e) => signal.Release();

                    await signal.WaitAsync();
                    return true;
                }
                catch (Exception e)
                {
                    Debug.LogError(e);
                }
            }

            return false;
        }


        private async Task<bool> SendDataAsync(byte[] data)
        {
            if (_socket != null)
            {
                try
                {
                    SocketAsyncEventArgs socketAsyncData = new SocketAsyncEventArgs();
                    var encoding = new UTF8Encoding();
                    // TODO: could reuse byte buffer to avoid unnecessary memory allocation
                    var header = encoding.GetBytes($"\0\0\0{data.Length}\0");
                    // TODO: could be more efficient!
                    var buffer = new byte[header.Length + data.Length];
                    header.CopyTo(buffer, 0);
                    data.CopyTo(buffer, header.Length);

                    socketAsyncData.SetBuffer(buffer, 0, buffer.Length);
                    _socket.SendAsync(socketAsyncData);
                    var signal = new SemaphoreSlim(0, 1);

                    var success = false;
                    // TODO: could be more efficient! (i.e., don't rebuild a lambda every time this is called)
                    socketAsyncData.Completed += (sender, e) =>
                    {
                        success = e.SocketError == SocketError.Success;
                        signal.Release();
                    };

                    await signal.WaitAsync();
                    return success;
                }
                catch (Exception e)
                {
                    Debug.LogError(e);
                }
            }

            return false;
        }

        public async Task<bool> SendCommandAsync(string channel, string command, JToken payload)
        {
            await Connected;
            var builder = new FlatBufferBuilder(512);

            try
            {
                // order is important because "calls cannot be nested"
                var fbChannel = builder.CreateString(channel);
                var fbCommand = builder.CreateString(command);
                // TODO: replace this with dictionary to avoid JSON serialization
                //       see: https://flatbuffers.dev/flatbuffers_guide_use_c-sharp.html#autotoc_md93
                var fbPayload = builder.CreateString(payload?.ToString(Formatting.None));

                Message.StartMessage(builder);
                Message.AddChannel(builder, fbChannel);
                Message.AddCommand(builder, fbCommand);
                Message.AddPayload(builder, fbPayload);
                var msg = Message.EndMessage(builder);
                builder.Finish(msg.Value);
            }
            catch (Exception e)
            {
                Debug.LogError(e);
            }

            var rawMsg = builder.SizedByteArray();
            var result = await SendDataAsync(rawMsg);

            // message sent successfully
            if (result)
                return true;

            // something went wrong - queue message for later
            _msgQueue.Add(rawMsg);
            return false;
        }

        public void SendCommand(string channel, string command, JToken payload)
        {
            _ = SendCommandAsync(channel, command, payload);
        }
    }
}
