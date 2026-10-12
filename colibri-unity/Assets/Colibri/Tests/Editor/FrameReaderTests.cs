using HCIKonstanz.Colibri.Networking.Protocol;
using NUnit.Framework;
using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace HCIKonstanz.Colibri.Tests
{
    /// <summary>
    /// Ingress-side tests, ported case-for-case from the server's
    /// <c>test/unit/protocol.test.ts</c>. The server is the reference implementation; the
    /// C# side is what is under test here.
    /// </summary>
    public class FrameReaderTests
    {
        private const int MaxFrameLength = 1024 * 1024;

        private static List<DecodedFrame> ReadAll(FrameReader reader, ReadOnlySpan<byte> data)
            => reader.Append(data).ToList();


        /*
         *  Round trips
         */

        [Test]
        public void HeartbeatRoundTripsAPingTimestamp()
        {
            var reader = new FrameReader(MaxFrameLength);
            var frame = FrameCodec.EncodeHeartbeat(123456789012345UL);

            Assert.That(ReadAll(reader, frame), Is.EqualTo(new[] { DecodedFrame.Heartbeat(123456789012345UL) }));
        }

        // The timestamp is the server's raw hrtime reading and is echoed back untouched; a
        // signed round trip anywhere in the path would corrupt the top bit.
        [Test]
        public void HeartbeatRoundTripsTheFullUnsignedRange()
        {
            var reader = new FrameReader(MaxFrameLength);
            var frame = FrameCodec.EncodeHeartbeat(ulong.MaxValue);

            Assert.That(ReadAll(reader, frame), Is.EqualTo(new[] { DecodedFrame.Heartbeat(ulong.MaxValue) }));
        }

        [Test]
        public void HandshakeRoundTripsVersionAppName()
        {
            var reader = new FrameReader(MaxFrameLength);
            var frame = FrameCodec.EncodeHandshake("2", "myApp", "myClient");

            Assert.That(ReadAll(reader, frame), Is.EqualTo(new[] { DecodedFrame.Handshake("2", "myApp", "myClient") }));
        }

        [Test]
        public void MessageRoundTripsChannelCommandAndPayloadBytes()
        {
            var reader = new FrameReader(MaxFrameLength);
            var payload = Encoding.UTF8.GetBytes("{\"x\":1}");
            var frame = FrameCodec.EncodeMessage("app::chan", "model::update", payload);

            Assert.That(ReadAll(reader, frame),
                Is.EqualTo(new[] { DecodedFrame.Message("app::chan", "model::update", payload) }));
        }

        [Test]
        public void MessageRoundTripsAnEmptyPayload()
        {
            var reader = new FrameReader(MaxFrameLength);
            var frame = FrameCodec.EncodeMessage("c", "cmd", ReadOnlySpan<byte>.Empty);

            Assert.That(ReadAll(reader, frame),
                Is.EqualTo(new[] { DecodedFrame.Message("c", "cmd", Array.Empty<byte>()) }));
        }

        // The payload is an opaque byte range - the server relays it verbatim without ever
        // decoding it as a string, so a byte that is not valid utf8 must survive intact.
        [Test]
        public void MessageRoundTripsNonUtf8PayloadBytes()
        {
            var reader = new FrameReader(MaxFrameLength);
            var payload = new byte[] { 0x00, 0xFF, 0x7F, 0x80 };
            var frame = FrameCodec.EncodeMessage("b", "raw", payload);

            Assert.That(ReadAll(reader, frame), Is.EqualTo(new[] { DecodedFrame.Message("b", "raw", payload) }));
        }


        /*
         *  Fragmentation
         */

        [Test]
        public void ReassemblesAFrameSplitAcrossManySmallChunks()
        {
            var reader = new FrameReader(MaxFrameLength);
            var payload = Encoding.UTF8.GetBytes("{\"points\":[" + string.Join(",", Enumerable.Range(0, 50)) + "]}");
            var frame = FrameCodec.EncodeMessage("app::chan", "model::update", payload);

            var decoded = new List<DecodedFrame>();
            for (var i = 0; i < frame.Length; i++)
                decoded.AddRange(ReadAll(reader, new ReadOnlySpan<byte>(frame, i, 1)));

            Assert.That(decoded, Is.EqualTo(new[] { DecodedFrame.Message("app::chan", "model::update", payload) }));
        }

        [Test]
        public void ReassemblesAFrameSplitIntoTwoHalvesAcrossSeparateAppends()
        {
            var reader = new FrameReader(MaxFrameLength);
            var frame = FrameCodec.EncodeHeartbeat(42);
            var mid = frame.Length / 2;

            Assert.That(ReadAll(reader, new ReadOnlySpan<byte>(frame, 0, mid)), Is.Empty);
            Assert.That(ReadAll(reader, new ReadOnlySpan<byte>(frame, mid, frame.Length - mid)),
                Is.EqualTo(new[] { DecodedFrame.Heartbeat(42) }));
        }


        /*
         *  Coalescing
         */

        [Test]
        public void YieldsMultipleFramesDeliveredInASingleSegment()
        {
            var reader = new FrameReader(MaxFrameLength);
            var segment = Concat(
                FrameCodec.EncodeHeartbeat(1),
                FrameCodec.EncodeHandshake("2", "app", "name"),
                FrameCodec.EncodeMessage("x", "y", Encoding.UTF8.GetBytes("z")));

            Assert.That(ReadAll(reader, segment), Is.EqualTo(new[]
            {
                DecodedFrame.Heartbeat(1),
                DecodedFrame.Handshake("2", "app", "name"),
                DecodedFrame.Message("x", "y", Encoding.UTF8.GetBytes("z")),
            }));
        }

        [Test]
        public void HandlesOneCompleteFramePlusATrailingPartialFrameInTheSameSegment()
        {
            var reader = new FrameReader(MaxFrameLength);
            var a = FrameCodec.EncodeHeartbeat(7);
            var b = FrameCodec.EncodeHeartbeat(8);

            var first = ReadAll(reader, Concat(a, b.Take(3).ToArray()));
            Assert.That(first, Is.EqualTo(new[] { DecodedFrame.Heartbeat(7) }));

            var second = ReadAll(reader, b.Skip(3).ToArray());
            Assert.That(second, Is.EqualTo(new[] { DecodedFrame.Heartbeat(8) }));
        }


        /*
         *  Malformed / oversized input
         */

        [Test]
        public void ThrowsOnAZeroLengthFrame()
        {
            var reader = new FrameReader(MaxFrameLength);
            var frame = new byte[5];

            Assert.Throws<FrameException>(() => reader.Append(frame));
        }

        [Test]
        public void ThrowsWhenTheDeclaredLengthExceedsMaxFrameLength()
        {
            var reader = new FrameReader(16);
            var frame = new byte[5];
            BinaryPrimitives.WriteUInt32LittleEndian(frame, 1_000_000);
            frame[4] = (byte)FrameType.Heartbeat;

            Assert.Throws<FrameException>(() => reader.Append(frame));
        }

        [Test]
        public void ThrowsOnAnUnknownFrameType()
        {
            var reader = new FrameReader(MaxFrameLength);
            var frame = new byte[6];
            BinaryPrimitives.WriteUInt32LittleEndian(frame, 2);
            frame[4] = 0xFF;

            Assert.Throws<FrameException>(() => reader.Append(frame));
        }

        [Test]
        public void ThrowsWhenAMessageFramesChannelLengthOverrunsTheBody()
        {
            var reader = new FrameReader(MaxFrameLength);
            var buffer = new byte[9];
            BinaryPrimitives.WriteUInt32LittleEndian(buffer, 4); // type + 2-byte channelLen field only
            buffer[4] = (byte)FrameType.Message;
            BinaryPrimitives.WriteUInt16LittleEndian(buffer.AsSpan(5), 9999); // far longer than what's present

            Assert.Throws<FrameException>(() => reader.Append(buffer));
        }

        [Test]
        public void ThrowsWhenAMessageFramesCommandLengthOverrunsTheBody()
        {
            var reader = new FrameReader(MaxFrameLength);
            // type + channelLen(2) + channel(1) + commandLen(2)
            var buffer = new byte[5 + 2 + 1 + 2];
            BinaryPrimitives.WriteUInt32LittleEndian(buffer, 6);
            buffer[4] = (byte)FrameType.Message;
            BinaryPrimitives.WriteUInt16LittleEndian(buffer.AsSpan(5), 1);
            buffer[7] = (byte)'c';
            BinaryPrimitives.WriteUInt16LittleEndian(buffer.AsSpan(8), 500);

            Assert.Throws<FrameException>(() => reader.Append(buffer));
        }

        [Test]
        public void ThrowsOnAMalformedHeartbeatBody()
        {
            var reader = new FrameReader(MaxFrameLength);
            var frame = new byte[5 + 4];
            BinaryPrimitives.WriteUInt32LittleEndian(frame, 1 + 4);
            frame[4] = (byte)FrameType.Heartbeat;

            Assert.Throws<FrameException>(() => reader.Append(frame));
        }

        [Test]
        public void RejectsAHandshakeWithFewerThanThreeFields()
        {
            var reader = new FrameReader(MaxFrameLength);

            Assert.Throws<FrameException>(() => reader.Append(HandshakeFrameWithBody("not-enough-parts")));
        }

        [Test]
        public void RejectsAHandshakeWithMoreThanThreeFields()
        {
            var reader = new FrameReader(MaxFrameLength);

            // '::' is the field separator and docs/protocol.md forbids it inside a field; a
            // lenient parser would silently truncate the name at the extra separator.
            Assert.Throws<FrameException>(() => reader.Append(HandshakeFrameWithBody("2::app::na::me")));
        }


        /*
         *  Growth and compaction
         */

        [Test]
        public void GrowsPastTheInitialCapacityForASingleLargeFrame()
        {
            var reader = new FrameReader(MaxFrameLength, 16);
            var payload = Enumerable.Repeat((byte)'a', 10_000).ToArray();
            var frame = FrameCodec.EncodeMessage("c", "cmd", payload);

            Assert.That(ReadAll(reader, frame), Is.EqualTo(new[] { DecodedFrame.Message("c", "cmd", payload) }));
        }

        [Test]
        public void ReclaimsSpaceAfterFullyConsumingBufferedFrames()
        {
            var reader = new FrameReader(MaxFrameLength);

            reader.Append(FrameCodec.EncodeHeartbeat(1));
            Assert.That(reader.PendingBytes, Is.Zero);

            reader.Append(FrameCodec.EncodeHeartbeat(2));
            Assert.That(reader.PendingBytes, Is.Zero);
        }

        [Test]
        public void KeepsOnlyTheTrailingPartialFramePendingAcrossManySmallAppends()
        {
            var reader = new FrameReader(MaxFrameLength);
            var complete = FrameCodec.EncodeHeartbeat(1);
            var partial = FrameCodec.EncodeHeartbeat(2).Take(5).ToArray();

            reader.Append(Concat(complete, partial));

            Assert.That(reader.PendingBytes, Is.EqualTo(partial.Length));
        }

        [Test]
        public void ResetDiscardsBufferedBytes()
        {
            var reader = new FrameReader(MaxFrameLength);
            reader.Append(FrameCodec.EncodeHeartbeat(1).Take(5).ToArray());
            Assert.That(reader.PendingBytes, Is.EqualTo(5));

            reader.Reset();

            Assert.That(reader.PendingBytes, Is.Zero);
        }


        private static byte[] HandshakeFrameWithBody(string body)
        {
            var bytes = Encoding.UTF8.GetBytes(body);
            var frame = new byte[5 + bytes.Length];
            BinaryPrimitives.WriteUInt32LittleEndian(frame, (uint)(1 + bytes.Length));
            frame[4] = (byte)FrameType.Handshake;
            bytes.CopyTo(frame, 5);
            return frame;
        }

        private static byte[] Concat(params byte[][] parts)
            => parts.SelectMany(p => p).ToArray();
    }
}
