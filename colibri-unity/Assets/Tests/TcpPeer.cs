using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using HCIKonstanz.Colibri.Networking;
using HCIKonstanz.Colibri.Networking.Protocol;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEngine;

namespace HCIKonstanz.Colibri.E2E
{
    /// <summary>
    /// The second endpoint every propagation test needs.
    ///
    /// The server excludes the sender from its own broadcasts, so a single Unity client cannot
    /// observe anything it sends - something else has to be on the app. This is a raw v3 client
    /// built on the package's own <see cref="FrameCodec"/> and <see cref="FrameReader"/>, which
    /// keeps the suite to one process and no second Unity instance. It is a C# port of
    /// <c>colibri-server/test/tcp-crosstalk-check.ts</c>, which proved the flow by hand.
    ///
    /// Using Colibri's own codec means a bug in the codec could in principle hide itself by
    /// being symmetrical. That is what the cross-implementation vectors in
    /// <c>ProtocolVectorTests</c> are for; these tests are about the client above the codec.
    /// </summary>
    public sealed class TcpPeer : IDisposable
    {
        private static readonly Encoding Utf8 = new UTF8Encoding(false, false);

        private TcpClient _client;
        private readonly FrameReader _reader = new FrameReader();
        private readonly ConcurrentQueue<DecodedFrame> _inbox = new ConcurrentQueue<DecodedFrame>();
        private readonly SemaphoreSlim _writeLock = new SemaphoreSlim(1, 1);
        private readonly CancellationTokenSource _lifetime = new CancellationTokenSource();

        /// <summary>Drained from <see cref="_inbox"/> on the main thread, and never discarded, so a
        /// test can assert on ordering and on what else did or did not arrive.</summary>
        private readonly List<DecodedFrame> _received = new List<DecodedFrame>();

        private readonly int _port;
        private readonly bool _useTls;
        private Stream _stream;
        private int _heartbeats;

        /// <summary>A peer on the test server, over TLS when the suite runs over TLS (<see cref="E2EServer.OverTls"/>).</summary>
        public TcpPeer() : this(E2EServer.TcpPort, E2EServer.OverTls)
        {
        }

        /// <param name="port">The server's binary port.</param>
        /// <param name="useTls">
        /// Whether the server has TLS on. The peer accepts whatever certificate it presents: the
        /// peer is not what is under test, the Unity client's own check is.
        /// </param>
        public TcpPeer(int port, bool useTls)
        {
            _port = port;
            _useTls = useTls;
        }

        /// <summary>How many heartbeats the server has sent this peer, all of them echoed back.</summary>
        public int Heartbeats => Volatile.Read(ref _heartbeats);

        public IReadOnlyList<DecodedFrame> Received
        {
            get
            {
                Drain();
                return _received;
            }
        }


        /// <summary>True once the server has closed this peer's connection.</summary>
        public bool Closed => Volatile.Read(ref _closed);
        private bool _closed;

        /// <summary>True once the server has sent this peer a frame of any kind.</summary>
        private bool Answered => Volatile.Read(ref _answered);
        private bool _answered;

        /// <summary>
        /// Connects and handshakes, and returns once the server has answered. It writes nothing
        /// to a client before it has put it on the app, or refused it, so from the first frame on,
        /// anything relayed to the app reaches this peer. Returning as soon as the handshake was
        /// written was not enough: the server reads its connections in no fixed order, and under
        /// load it relayed a message sent on another connection after the handshake before it had
        /// read the handshake.
        /// </summary>
        /// <param name="version">
        /// Handshake protocol version. Defaults to the client library's own, so the peer is
        /// accepted; a test can pass something else to exercise the server's refusal.
        /// </param>
        public IEnumerator Connect(string name = "e2e-peer", string version = null)
        {
            yield return E2EServer.Await(ConnectAsync(name, version), "the raw peer never reached the server");
            yield return E2EServer.WaitUntil(() => Answered || Closed,
                $"The server never answered the handshake of the raw peer '{name}'");
        }

        private async Task ConnectAsync(string name, string version)
        {
            _client = await E2EServer.ConnectTcpAsync(E2EServer.Host, _port);

            Stream stream = _client.GetStream();
            if (_useTls)
                stream = await TestTls.ConnectAsync(stream, E2EServer.Host);

            _stream = stream;

            // Started before the handshake so the server's first heartbeat is never missed.
            _ = ReadLoop(_lifetime.Token);

            await WriteAsync(
                FrameCodec.EncodeHandshake(version ?? WebServerConnection.ClientVersion, E2EServer.App, name),
                _lifetime.Token);
        }

        /// <summary>Waits for the server to hang up, and fails if it does not.</summary>
        public IEnumerator ExpectClosed(float timeoutSeconds = 8f)
        {
            var deadline = Time.realtimeSinceStartup + timeoutSeconds;

            while (!Closed)
            {
                if (Time.realtimeSinceStartup > deadline)
                    Assert.Fail($"The server never closed the peer's connection within {timeoutSeconds:0.#} s.");

                yield return null;
            }
        }

        public void Send(string channel, string command, JToken payload)
            => Send(channel, command, payload == null ? null : payload.ToString(Newtonsoft.Json.Formatting.None));

        public void Send(string channel, string command, string rawPayload)
        {
            var frame = FrameCodec.EncodeMessage(channel, command,
                rawPayload == null ? Array.Empty<byte>() : Utf8.GetBytes(rawPayload));

            _ = WriteAsync(frame, _lifetime.Token);
        }


        /*
         *  Assertions
         */

        /// <summary>
        /// Waits for one message, hands it to <paramref name="onReceived"/> and consumes it.
        /// Fails with what did arrive, which is almost always the more useful half.
        /// </summary>
        public IEnumerator Expect(string channel, string command, Action<DecodedFrame> onReceived = null,
            float timeoutSeconds = 8f)
        {
            var deadline = Time.realtimeSinceStartup + timeoutSeconds;

            for (; ; )
            {
                Drain();

                var index = _received.FindIndex(f => f.Channel == channel && (command == null || f.Command == command));
                if (index >= 0)
                {
                    var frame = _received[index];
                    _received.RemoveAt(index);
                    onReceived?.Invoke(frame);
                    yield break;
                }

                if (Time.realtimeSinceStartup > deadline)
                    Assert.Fail($"The peer never received '{command ?? "any command"}' on channel '{channel}' "
                        + $"within {timeoutSeconds:0.#} s. It did receive: {Describe()}");

                yield return null;
            }
        }

        /// <summary>Waits out a settling period and fails if anything arrived on the channel.</summary>
        public IEnumerator ExpectNothing(string channel, float seconds = 1f)
        {
            yield return E2EServer.Settle(seconds);

            Drain();
            var stray = _received.Where(f => f.Channel == channel).ToArray();

            Assert.That(stray, Is.Empty,
                $"Expected nothing on channel '{channel}', but the peer received: {string.Join(", ", stray.Select(Summarize))}");
        }

        public static string Text(DecodedFrame frame)
            => Utf8.GetString(frame.Payload ?? Array.Empty<byte>());

        public static JToken Json(DecodedFrame frame)
        {
            var text = Text(frame);
            try
            {
                return JToken.Parse(text);
            }
            catch (Exception)
            {
                Assert.Fail($"The peer received a payload that is not JSON: '{text}'");
                return null;
            }
        }

        public string Describe()
            => _received.Count == 0 ? "nothing" : string.Join(", ", _received.Select(Summarize));

        private static string Summarize(DecodedFrame frame)
            => $"{frame.Channel}/{frame.Command} '{Text(frame)}'";

        private void Drain()
        {
            while (_inbox.TryDequeue(out var frame))
                _received.Add(frame);
        }


        /*
         *  Transport
         */

        private async Task ReadLoop(CancellationToken token)
        {
            var buffer = new byte[16 * 1024];

            while (!token.IsCancellationRequested)
            {
                int read;
                try
                {
                    read = await _stream.ReadAsync(buffer, 0, buffer.Length, token);
                }
                catch (Exception)
                {
                    // Disposed or reset - either way there is nothing left to read.
                    Volatile.Write(ref _closed, true);
                    return;
                }

                if (read <= 0)
                {
                    Volatile.Write(ref _closed, true);
                    return;
                }

                foreach (var frame in Decode(buffer, read))
                {
                    Volatile.Write(ref _answered, true);

                    switch (frame.Type)
                    {
                        case FrameType.Heartbeat:
                            Interlocked.Increment(ref _heartbeats);
                            // Not echoing these gets the peer dropped mid-test, which then shows up
                            // as a message that mysteriously never arrived.
                            await WriteAsync(FrameCodec.EncodeHeartbeat(frame.PingTimestamp), token);
                            break;

                        case FrameType.Message:
                            _inbox.Enqueue(frame);
                            break;
                    }
                }
            }
        }

        /// <summary>
        /// Decoding lives in its own method because <see cref="FrameReader.Append"/> takes a
        /// <c>ReadOnlySpan</c>, which cannot be a local in an async method. The list is copied for
        /// the same reason the reader hands one back: it reuses its own buffer on the next call.
        /// </summary>
        private List<DecodedFrame> Decode(byte[] buffer, int count)
            => new List<DecodedFrame>(_reader.Append(new ReadOnlySpan<byte>(buffer, 0, count)));

        private async Task WriteAsync(byte[] frame, CancellationToken token)
        {
            await _writeLock.WaitAsync(token);
            try
            {
                await _stream.WriteAsync(frame, 0, frame.Length, token);
            }
            catch (Exception)
            {
                // A write that fails during teardown is expected; one that fails mid-test surfaces
                // as the missing message it causes.
            }
            finally
            {
                _writeLock.Release();
            }
        }

        public void Dispose()
        {
            _lifetime.Cancel();

            try
            {
                _stream?.Dispose();
                _client?.Close();
            }
            catch (Exception)
            {
                // Nothing useful to do with a failure to close a socket we are discarding.
            }

            _lifetime.Dispose();
            _writeLock.Dispose();
        }
    }
}
