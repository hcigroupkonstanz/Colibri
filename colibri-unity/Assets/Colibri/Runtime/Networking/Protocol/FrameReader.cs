using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Text;

namespace HCIKonstanz.Colibri.Networking.Protocol
{
    /// <summary>
    /// Reassembles length-prefixed frames from the bytes of the socket receive loop. Mirrors the
    /// buffering of the server's <c>FrameReader</c> (<c>protocol.ts</c>).
    /// </summary>
    public sealed class FrameReader
    {
        private static readonly IReadOnlyList<DecodedFrame> _noFrames = Array.Empty<DecodedFrame>();
        private static readonly Encoding _utf8 = new UTF8Encoding(false, false);

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

        /// <summary>Bytes of the trailing partial frame, buffered but not yet decoded.</summary>
        public int PendingBytes => _writePos - _readPos;

        public void Reset()
        {
            _readPos = 0;
            _writePos = 0;
        }

        /// <summary>
        /// Appends received bytes and returns every complete frame now available.
        /// </summary>
        /// <exception cref="FrameException">
        /// On a malformed or oversized frame. The stream cannot resynchronize, so the caller must
        /// drop the connection.
        /// </exception>
        // Not an iterator: the read cursor advances as frames decode, so stopping early would leave it stale.
        public IReadOnlyList<DecodedFrame> Append(ReadOnlySpan<byte> data)
        {
            EnsureCapacity(data.Length);
            data.CopyTo(_buffer.AsSpan(_writePos));
            _writePos += data.Length;

            // Allocated lazily: most calls on a fragmented stream complete no frame.
            List<DecodedFrame> frames = null;

            while (true)
            {
                var available = _writePos - _readPos;
                if (available < FrameCodec.HeaderSize)
                    break;

                var totalLength = BinaryPrimitives.ReadUInt32LittleEndian(_buffer.AsSpan(_readPos));
                if (totalLength == 0 || totalLength > (uint)_maxFrameLength)
                {
                    // Cursors stay put; the caller drops the connection, and Reset() clears the buffer.
                    throw new FrameException($"Invalid frame length: {totalLength}");
                }

                // totalLength counts type + body, not the length field.
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
            return frames ?? _noFrames;
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
                    var text = _utf8.GetString(_buffer, bodyStart, bodyEnd - bodyStart);
                    // '::' separates the three fields and is not allowed inside one.
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
                    var channel = _utf8.GetString(_buffer, offset, channelLength);
                    offset += channelLength;

                    if (offset + 2 > bodyEnd)
                        throw new FrameException("Malformed message frame: missing command length");
                    int commandLength = BinaryPrimitives.ReadUInt16LittleEndian(_buffer.AsSpan(offset));
                    offset += 2;
                    if (offset + commandLength > bodyEnd)
                        throw new FrameException("Malformed message frame: command overruns body");
                    var command = _utf8.GetString(_buffer, offset, commandLength);
                    offset += commandLength;

                    // Copied: the buffer is reused and compacted by later Append calls.
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
