using System;

namespace HCIKonstanz.Colibri.Networking.Protocol
{
    /// <summary>
    /// A single decoded v3 frame. The server models this as a discriminated union; C# has no
    /// such type, so this is a tagged struct: read <see cref="Type"/> first, then only the
    /// fields that belong to it. Everything else is left at its default.
    /// </summary>
    public readonly struct DecodedFrame : IEquatable<DecodedFrame>
    {
        public FrameType Type { get; }

        /// <summary>Heartbeat only: the server's opaque ping timestamp, echoed back verbatim.</summary>
        public ulong PingTimestamp { get; }

        /// <summary>Handshake only.</summary>
        public string Version { get; }

        /// <summary>Handshake only.</summary>
        public string App { get; }

        /// <summary>Handshake only: the client's host name.</summary>
        public string Name { get; }

        /// <summary>Message only.</summary>
        public string Channel { get; }

        /// <summary>Message only.</summary>
        public string Command { get; }

        /// <summary>Message only: opaque payload bytes, never interpreted by the codec.</summary>
        public byte[] Payload { get; }

        private DecodedFrame(FrameType type, ulong pingTimestamp, string version, string app, string name,
            string channel, string command, byte[] payload)
        {
            Type = type;
            PingTimestamp = pingTimestamp;
            Version = version;
            App = app;
            Name = name;
            Channel = channel;
            Command = command;
            Payload = payload;
        }

        public static DecodedFrame Heartbeat(ulong pingTimestamp)
            => new DecodedFrame(FrameType.Heartbeat, pingTimestamp, null, null, null, null, null, null);

        public static DecodedFrame Handshake(string version, string app, string name)
            => new DecodedFrame(FrameType.Handshake, 0, version, app, name, null, null, null);

        public static DecodedFrame Message(string channel, string command, byte[] payload)
            => new DecodedFrame(FrameType.Message, 0, null, null, null, channel, command, payload);

        public bool Equals(DecodedFrame other)
        {
            if (Type != other.Type)
                return false;

            switch (Type)
            {
                case FrameType.Heartbeat:
                    return PingTimestamp == other.PingTimestamp;

                case FrameType.Handshake:
                    return Version == other.Version && App == other.App && Name == other.Name;

                case FrameType.Message:
                    return Channel == other.Channel
                        && Command == other.Command
                        && PayloadEquals(Payload, other.Payload);

                default:
                    return false;
            }
        }

        private static bool PayloadEquals(byte[] a, byte[] b)
        {
            if (ReferenceEquals(a, b))
                return true;
            if (a == null || b == null || a.Length != b.Length)
                return false;

            for (var i = 0; i < a.Length; i++)
            {
                if (a[i] != b[i])
                    return false;
            }

            return true;
        }

        public override bool Equals(object obj) => obj is DecodedFrame other && Equals(other);

        public override int GetHashCode()
        {
            switch (Type)
            {
                case FrameType.Heartbeat:
                    return PingTimestamp.GetHashCode();

                case FrameType.Handshake:
                    return (Version, App, Name).GetHashCode();

                case FrameType.Message:
                    return (Channel, Command, Payload?.Length ?? 0).GetHashCode();

                default:
                    return 0;
            }
        }

        public override string ToString()
        {
            switch (Type)
            {
                case FrameType.Heartbeat:
                    return $"Heartbeat({PingTimestamp})";

                case FrameType.Handshake:
                    return $"Handshake({Version}::{App}::{Name})";

                case FrameType.Message:
                    return $"Message({Channel} / {Command}, {Payload?.Length ?? 0} bytes)";

                default:
                    return $"Frame(0x{(byte)Type:x2})";
            }
        }
    }
}
