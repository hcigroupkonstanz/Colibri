using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Text;

namespace HCIKonstanz.Colibri.Networking.Protocol
{
    /// <summary>
    /// Growable read buffer with read/write cursors, fed from the socket receive loop. Mirrors the
    /// semantics of the server's <c>FrameReader</c>: in the common case (no fragmentation) consumed
    /// frames are dropped by resetting both cursors - no copy at all. Only a frame split across TCP
    /// segments triggers a compaction, and that copy is bounded by the pending leftover (at most one
    /// frame's worth), not by total stream length.
    ///
    /// This replaces the v1 <c>HasPacketHeader</c>/<c>GetPacketHeader</c> null-byte scanning
    /// entirely: every length is a real bounds-checked field.
    /// </summary>
    public sealed class FrameReader
    {
        private static readonly IReadOnlyList<DecodedFrame> NoFrames = Array.Empty<DecodedFrame>();
        private static readonly Encoding Utf8 = new UTF8Encoding(false, false);

        private readonly int _maxFrameLength;
        private byte[] _buffer;
        private int _readPos;
        private int _writePos;

        public FrameReader(int maxFrameLength = FrameCodec.MaxFrameLength, int initialCapacity = 4096)
        {
            if (maxFrameLength <= 0)
                throw new ArgumentOutOfRangeException(nameof(maxFrameLength));
            if (initialCapacity <= 0)
                throw new ArgumentOutOfRangeException(nameof(initialCapacity));

            _maxFrameLength = maxFrameLength;
            _buffer = new byte[initialCapacity];
        }

        /// <summary>Bytes buffered but not yet consumed - i.e. the trailing partial frame.</summary>
        public int PendingBytes => _writePos - _readPos;

        public void Reset()
        {
            _readPos = 0;
            _writePos = 0;
        }

        /// <summary>
        /// Appends newly received bytes and returns every complete frame now available.
        /// </summary>
        /// <exception cref="FrameException">
        /// On a malformed or oversized frame. Callers must treat that as fatal for the connection:
        /// the stream is desynchronized and there is nothing to resynchronize on.
        /// </exception>
        /// <remarks>
        /// Deliberately not an iterator: the read cursor only advances as frames are decoded, so a
        /// caller that stopped enumerating early would leave the reader with a stale cursor and
        /// silently re-deliver or drop bytes. Draining eagerly makes the cursor state a function of
        /// <see cref="Append"/> alone.
        /// </remarks>
        public IReadOnlyList<DecodedFrame> Append(ReadOnlySpan<byte> data)
        {
            EnsureCapacity(data.Length);
            data.CopyTo(_buffer.AsSpan(_writePos));
            _writePos += data.Length;

            // A partial frame is the common case on a fragmented stream, so don't allocate a
            // result list until there is something to put in it.
            List<DecodedFrame> frames = null;

            while (true)
            {
                var available = _writePos - _readPos;
                if (available < FrameCodec.HeaderSize)
                    break;

                var totalLength = BinaryPrimitives.ReadUInt32LittleEndian(_buffer.AsSpan(_readPos));
                if (totalLength == 0 || totalLength > (uint)_maxFrameLength)
                {
                    // Leave the cursors where they are; the caller is expected to drop the
                    // connection, and Reset() is what clears the buffer.
                    throw new FrameException($"Invalid frame length: {totalLength}");
                }

                // totalLength counts everything after the length field itself (type + body).
                var frameLength = FrameCodec.LengthFieldSize + (int)totalLength;
                if (available < frameLength)
                    break;

                var frameEnd = _readPos + frameLength;
                var type = _buffer[_readPos + FrameCodec.LengthFieldSize];
                var frame = DecodeFrame(type, _readPos + FrameCodec.HeaderSize, frameEnd);
                _readPos = frameEnd;

                frames ??= new List<DecodedFrame>();
                frames.Add(frame);
            }

            Compact();
            return frames ?? NoFrames;
        }

        private DecodedFrame DecodeFrame(byte type, int bodyStart, int bodyEnd)
        {
            switch ((FrameType)type)
            {
                case FrameType.Heartbeat:
                {
                    if (bodyEnd - bodyStart != FrameCodec.HeartbeatBodySize)
                        throw new FrameException($"Malformed heartbeat frame ({bodyEnd - bodyStart} body bytes)");

                    return DecodedFrame.Heartbeat(BinaryPrimitives.ReadUInt64LittleEndian(_buffer.AsSpan(bodyStart)));
                }

                case FrameType.Handshake:
                {
                    var text = Utf8.GetString(_buffer, bodyStart, bodyEnd - bodyStart);
                    // Exactly three fields. '::' is the field separator and docs/protocol.md
                    // forbids it inside a field, so a name containing one is a malformed frame.
                    var parts = text.Split(new[] { FrameCodec.FieldSeparator }, StringSplitOptions.None);
                    if (parts.Length != 3)
                        throw new FrameException($"Malformed handshake frame: \"{text}\"");

                    return DecodedFrame.Handshake(parts[0], parts[1], parts[2]);
                }

                case FrameType.Message:
                {
                    var offset = bodyStart;
                    if (offset + 2 > bodyEnd)
                        throw new FrameException("Malformed message frame: missing channel length");
                    int channelLength = BinaryPrimitives.ReadUInt16LittleEndian(_buffer.AsSpan(offset));
                    offset += 2;
                    if (offset + channelLength > bodyEnd)
                        throw new FrameException("Malformed message frame: channel overruns body");
                    var channel = Utf8.GetString(_buffer, offset, channelLength);
                    offset += channelLength;

                    if (offset + 2 > bodyEnd)
                        throw new FrameException("Malformed message frame: missing command length");
                    int commandLength = BinaryPrimitives.ReadUInt16LittleEndian(_buffer.AsSpan(offset));
                    offset += 2;
                    if (offset + commandLength > bodyEnd)
                        throw new FrameException("Malformed message frame: command overruns body");
                    var command = Utf8.GetString(_buffer, offset, commandLength);
                    offset += commandLength;

                    // Copied out (not a slice) since the backing buffer is reused and compacted
                    // on subsequent Append() calls.
                    var payload = new byte[bodyEnd - offset];
                    Buffer.BlockCopy(_buffer, offset, payload, 0, payload.Length);
                    return DecodedFrame.Message(channel, command, payload);
                }

                default:
                    throw new FrameException($"Unknown frame type: {type}");
            }
        }

        private void EnsureCapacity(int incoming)
        {
            if (_writePos + (long)incoming <= _buffer.Length)
                return;

            Compact();
            if (_writePos + (long)incoming <= _buffer.Length)
                return;

            var required = _writePos + (long)incoming;
            var newSize = (long)_buffer.Length * 2;
            while (newSize < required)
                newSize *= 2;

            var grown = new byte[newSize];
            Buffer.BlockCopy(_buffer, 0, grown, 0, _writePos);
            _buffer = grown;
        }

        private void Compact()
        {
            if (_readPos == 0)
                return;

            if (_readPos == _writePos)
            {
                _readPos = 0;
                _writePos = 0;
                return;
            }

            Buffer.BlockCopy(_buffer, _readPos, _buffer, 0, _writePos - _readPos);
            _writePos -= _readPos;
            _readPos = 0;
        }
    }
}
