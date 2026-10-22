using System.IO;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;

namespace HCIKonstanz.Colibri.Networking
{
    /// <summary>
    /// One connection to the server: its socket, and the stream frames are read from and written to (the
    /// socket's <see cref="NetworkStream"/>, or an <see cref="SslStream"/> over it). Closing the socket
    /// ends the session and fails whatever is reading or writing.
    /// </summary>
    internal sealed class ServerSession
    {
        public readonly Socket Socket;
        public readonly Stream Stream;

        // The server address the socket is connected to, for the log; null in the tests' sessions.
        public readonly IPAddress Address;

        public ServerSession(Socket socket, Stream stream, IPAddress address = null)
        {
            Socket = socket;
            Stream = stream;
            Address = address;
        }

        /// <summary>A session without TLS on a connected socket. For the EditMode tests.</summary>
        internal static ServerSession Plain(Socket socket) => new ServerSession(socket, new NetworkStream(socket, false));

        public void Close() => ConnectRace.CloseSocket(Socket);
    }
}
