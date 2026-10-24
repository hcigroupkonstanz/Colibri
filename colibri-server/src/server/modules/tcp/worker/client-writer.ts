import { encodeHeartbeatFrame } from '../../protocol/protocol.js';
import { HEARTBEAT_EVERY_BYTES } from './heartbeat-every-bytes.js';
import { PEER_GONE_ERRORS, WRITE_CANCELLED_ERRORS, errorCode } from './socket-errors.js';
import type { TcpClient } from './tcp-client.js';

// For a last-write-wins synchronization server, a client whose socket write buffer is
// already this full is not keeping up - queuing yet another update behind it only grows
// process memory without bound (the old `socket.write()`'s return value was ignored
// entirely). Dropping a stale update for a slow client is the correct behaviour here.
// Replies (see MAX_REPLY_BACKLOG_BYTES) neither count towards it nor are dropped by it.
const highWaterMark = 1024 * 1024;

// How many bytes of replies, the server's answers to a client's own requests, may wait to be sent
// to one client before further replies to it are dropped too.
//
// A reply is not dropped at highWaterMark like relayed traffic: nothing would ever send it again.
// The answer to a model::request for a whole channel is one frame per model, all written at once,
// so on any link slower than loopback a store larger than highWaterMark used to reach a late joiner
// only in part, and the models cut off stayed missing on it until they next changed. This bound is
// many full stores and many maximum-size frames; it only stops a client that keeps asking without
// ever reading from taking up memory without limit.
export const MAX_REPLY_BACKLOG_BYTES = 64 * 1024 * 1024;

// What ClientWriter needs from the TCP worker that owns it.
interface ClientWriterCallbacks {
    logWarning(msg: string): void;
}

// The TCP worker's write path to its clients: relayed traffic and replies, each dropped past its own
// limit for a client that is behind, and the heartbeats between them.
export class ClientWriter {
    public constructor(private readonly callbacks: ClientWriterCallbacks) {}

    public writeToClient(client: TcpClient, packet: Buffer, reply = false): void {
        // Writing after end() is an error that destroys the socket - logged twice, and able to
        // cut off a refusal frame that was still being flushed. A socket gets here ended
        // between the peer's FIN (which ends our side too) and its 'close' event.
        if (client.socket.writableEnded || client.socket.destroyed) {
            return;
        }

        if (reply ? !this.admitReply(client) : !this.admitRelayed(client)) {
            return;
        }

        if (client.outbox.bytesSinceHeartbeat >= HEARTBEAT_EVERY_BYTES) {
            this.writeHeartbeat(client, encodeHeartbeatFrame(process.hrtime.bigint()));
        }
        // After the heartbeat just written ahead of it, which comes before it on the wire, so an
        // echo of that one does not count as the client having read it.
        if (packet.length > HEARTBEAT_EVERY_BYTES) {
            client.reading.unreadLargeBytes = Math.max(client.reading.unreadLargeBytes, packet.length);
            client.reading.lastLargeWrittenAt = process.hrtime.bigint();
        }
        client.outbox.bytesSinceHeartbeat += packet.length;
        client.traffic.sent += 1;
        this.write(client, packet, reply ? 'reply' : 'relayed');
    }

    // The tick's heartbeat for one client.
    //
    // A client with an earlier heartbeat still waiting in its socket is skipped. A client that keeps
    // sending but never reads (a send-only script, or one whose receive loop has died) is kept
    // connected by what it sends, and used to be queued every tick's heartbeat on top: ten writes a
    // second, a few hundred bytes of memory each, for as long as it stayed. A client that is reading
    // loses nothing by the skip: it finds the heartbeat already waiting, and is sent the next one on
    // the first tick after that has gone to the kernel.
    public writeTickHeartbeat(client: TcpClient, packet: Buffer): void {
        if (client.outbox.heartbeatsQueued > 0) return;
        this.writeHeartbeat(client, packet);
    }

    // A heartbeat is never dropped for a client that is behind, as relayed traffic is past
    // highWaterMark: a client that sends nothing of its own is kept connected only by echoing
    // heartbeats (see IdleWatch.endIdleClients), so one dropped from what a live client is still
    // reading made it look gone. What bounds them instead: the ones between messages come one per
    // HEARTBEAT_EVERY_BYTES of messages admitted, and the tick's own are not queued behind one
    // still waiting (writeTickHeartbeat).
    private writeHeartbeat(client: TcpClient, packet: Buffer): void {
        if (client.socket.writableEnded || client.socket.destroyed) {
            return;
        }

        client.outbox.bytesSinceHeartbeat = 0;
        this.write(client, packet, 'heartbeat');
    }

    private write(client: TcpClient, packet: Buffer, kind: 'relayed' | 'reply' | 'heartbeat'): void {
        if (kind === 'reply') client.outbox.replyBytesQueued += packet.length;
        else if (kind === 'heartbeat') client.outbox.heartbeatsQueued += 1;
        client.socket.write(packet, (err) => {
            // Called once the kernel has taken the packet, or the write failed: either way it is
            // no longer waiting.
            if (kind === 'reply') client.outbox.replyBytesQueued -= packet.length;
            else if (kind === 'heartbeat') client.outbox.heartbeatsQueued -= 1;
            if (!err) return;

            // A peer that is gone fails every write still queued for it, each with a callback of
            // its own: one warning per queued message, thousands for a client whose Wi-Fi dropped
            // with model updates backed up. The socket's own 'error' event, or this server's
            // closing it, already reports the connection once (TCPServerWorker.handleSocketError).
            const code = errorCode(err);
            if (code && (PEER_GONE_ERRORS.has(code) || WRITE_CANCELLED_ERRORS.has(code))) return;

            this.callbacks.logWarning(
                `Failed to send message to client ${client.id}: ${err.message} `
            );
        });
    }

    // Whether relayed traffic may still be queued for the client: not once more than highWaterMark
    // of it is waiting. Replies waiting ahead of it do not count, so a client
    // still reading the answer to its model::request gets the updates made meanwhile too.
    private admitRelayed(client: TcpClient): boolean {
        const relayedBytes = client.socket.writableLength - client.outbox.replyBytesQueued;
        if (relayedBytes > highWaterMark) {
            client.outbox.droppedSinceWarning += 1;
            if (!client.outbox.dropping) {
                client.outbox.dropping = true;
                this.callbacks.logWarning(
                    `Dropping messages to client ${client.id}: writable buffer exceeds high-water mark (${relayedBytes} bytes)`
                );
            }
            return false;
        }

        if (client.outbox.dropping) {
            client.outbox.dropping = false;
            this.callbacks.logWarning(
                `Client ${client.id} caught up; dropped ${client.outbox.droppedSinceWarning} message(s) while backed up`
            );
            client.outbox.droppedSinceWarning = 0;
        }
        return true;
    }

    // Whether one more reply may be queued for the client: always, unless MAX_REPLY_BACKLOG_BYTES of
    // replies are waiting already.
    private admitReply(client: TcpClient): boolean {
        if (client.outbox.replyBytesQueued > MAX_REPLY_BACKLOG_BYTES) {
            client.outbox.droppedRepliesSinceWarning += 1;
            if (!client.outbox.droppingReplies) {
                client.outbox.droppingReplies = true;
                this.callbacks.logWarning(
                    `Dropping answers to Unity client '${client.name}' (${client.id}, app '${client.app}', ${client.address}): ` +
                        `more than ${MAX_REPLY_BACKLOG_BYTES / (1024 * 1024)} MiB of answers to its own requests (model::request) ` +
                        'are still waiting to be sent to it. The models it asked for from here on are missing on it until they ' +
                        'change. A client that keeps asking for every model without reading the answers looks like this.'
                );
            }
            return false;
        }

        if (client.outbox.droppingReplies) {
            client.outbox.droppingReplies = false;
            this.callbacks.logWarning(
                `Unity client '${client.name}' (${client.id}) is taking answers again; dropped ${client.outbox.droppedRepliesSinceWarning} ` +
                    'answer(s) to its requests while too many were waiting'
            );
            client.outbox.droppedRepliesSinceWarning = 0;
        }
        return true;
    }
}
