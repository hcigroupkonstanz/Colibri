import type * as net from 'net';
import { FrameReader, MAX_FRAME_LENGTH } from '../../protocol/protocol.js';
import { HeldUpdates } from '../../limits/inbound-limits.js';
import { TrafficMeter } from '../../limits/client-activity.js';

// Which limit kept a message from passing on at once.
export type Refusal = 'rate' | 'backlog';

export interface TcpClient {
    id: string;
    socket: net.Socket;
    reader: FrameReader;
    address: string;
    app: string;
    version: string;
    name: string;
    // Set by the first handleSocketDisconnect, so later calls return at once: closeClient and
    // IdleWatch call it before the socket's 'close' does. InboundHandler reads nothing more once set.
    disconnected: boolean;
    // Destroys a socket closeClient ended if the peer never closes its side; see
    // CLOSE_GRACE_MILLIS.
    closeTimer: NodeJS.Timeout | undefined;
    // What the write path keeps for this client.
    outbox: {
        // Set while writes to this client are dropped for backpressure. Only entering and leaving
        // it is logged: a stalled client drops many messages a second, and each warning is posted
        // to the main thread and re-broadcast to every admin UI, where WebLog cannot merge them
        // because the byte count differs.
        dropping: boolean;
        droppedSinceWarning: number;
        // Bytes of messages written to this client since its last heartbeat; see HEARTBEAT_EVERY_BYTES.
        bytesSinceHeartbeat: number;
        // Heartbeats handed to the socket that it has not flushed to the kernel yet; see ClientWriter.writeTickHeartbeat.
        heartbeatsQueued: number;
        // Bytes of replies handed to the socket that it has not flushed to the kernel yet; see
        // MAX_REPLY_BACKLOG_BYTES. Taken off writableLength before it is compared with highWaterMark.
        replyBytesQueued: number;
        // The same as dropping and droppedSinceWarning, for replies past MAX_REPLY_BACKLOG_BYTES.
        droppingReplies: boolean;
        droppedRepliesSinceWarning: number;
    };
    // What the idle watch reads; see IdleWatch.endIdleClients.
    reading: {
        // performance.now() of the last bytes received, or of the connection if none have been yet.
        lastInboundAt: number;
        // The size of the largest message over HEARTBEAT_EVERY_BYTES written to this client since it
        // last showed it had read all such messages (0 if none), and when the latest was written, on
        // the clock heartbeats carry. It has read them all once it echoes a heartbeat from after that.
        // See IdleWatch.idleAllowanceMillis.
        unreadLargeBytes: number;
        lastLargeWrittenAt: bigint;
    };
    // Whether any bytes have been received from it yet; see InboundHandler.acceptChunk.
    receivedAny: boolean;
    // Model updates over a limit, waiting for room; see HeldUpdates.
    held: HeldUpdates;
    // For the admin UI: Date.now() of the connection, the messages it sent and was sent, and the
    // limit that last refused one of its messages, and when (performance.now()).
    connectedAt: number;
    traffic: TrafficMeter;
    limitedBy: Refusal | undefined;
    limitedAt: number;
}

export const createTcpClient = function (id: string, socket: net.Socket, address: string): TcpClient {
    return {
        id,
        socket,
        reader: new FrameReader(MAX_FRAME_LENGTH),
        address,
        app: '',
        name: '',
        version: '0',
        disconnected: false,
        closeTimer: undefined,
        outbox: {
            dropping: false,
            droppedSinceWarning: 0,
            bytesSinceHeartbeat: 0,
            heartbeatsQueued: 0,
            replyBytesQueued: 0,
            droppingReplies: false,
            droppedRepliesSinceWarning: 0,
        },
        reading: {
            lastInboundAt: performance.now(),
            unreadLargeBytes: 0,
            lastLargeWrittenAt: 0n,
        },
        receivedAny: false,
        held: new HeldUpdates(),
        connectedAt: Date.now(),
        traffic: new TrafficMeter(performance.now()),
        limitedBy: undefined,
        limitedAt: 0,
    };
};
