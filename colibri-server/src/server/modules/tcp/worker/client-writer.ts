import { encodeHeartbeatFrame } from '../../protocol/protocol.js';
import { HEARTBEAT_EVERY_BYTES } from './heartbeat-every-bytes.js';
import { PEER_GONE_ERRORS, WRITE_CANCELLED_ERRORS, errorCode } from './socket-errors.js';
import type { TcpClient } from './tcp-client.js';

// Relayed traffic is dropped for a client whose write buffer holds this much: sync is last-write-wins,
// so a stale update is no loss, and queuing more would only grow memory. Replies
// (MAX_REPLY_BACKLOG_BYTES) neither count towards it nor are dropped by it.
const highWaterMark = 1024 * 1024;

// Bytes of replies (the server's answers to a client's own requests) that may wait for one client
// before further replies to it are dropped.
// Replies are not dropped at highWaterMark like relayed traffic, since nothing would send them again:
// a model::request for a channel is one frame per model, all written at once, so on a slow link a
// store larger than highWaterMark would reach a late joiner only in part. This bound only stops a
// client that keeps asking without reading from taking up unbounded memory.
export const MAX_REPLY_BACKLOG_BYTES = 64 * 1024 * 1024;

interface ClientWriterCallbacks {
    logWarning(msg: string): void;
}

// The TCP worker's write path to its clients: relayed traffic and replies, each dropped past its own
// limit for a client that is behind, and the heartbeats between them.
export class ClientWriter {
    public constructor(private readonly callbacks: ClientWriterCallbacks) {}

    public writeToClient(client: TcpClient, packet: Buffer, reply = false): void {
        // A write after end() errors and destroys the socket, which can cut off a refusal frame still
        // being flushed. A socket can get here ended, between the peer's FIN (which ends our side too)
        // and its 'close'.
        if (client.socket.writableEnded || client.socket.destroyed) {
            return;
        }

        if (reply ? !this.admitReply(client) : !this.admitRelayed(client)) {
            return;
        }

        if (client.outbox.bytesSinceHeartbeat >= HEARTBEAT_EVERY_BYTES) {
            this.writeHeartbeat(client, encodeHeartbeatFrame(process.hrtime.bigint()));
        }
        // Stamped after the heartbeat just written ahead of the packet, so an echo of that one does
        // not count as the client having read the packet.
        if (packet.length > HEARTBEAT_EVERY_BYTES) {
            client.reading.unreadLargeBytes = Math.max(client.reading.unreadLargeBytes, packet.length);
            client.reading.lastLargeWrittenAt = process.hrtime.bigint();
        }
        client.outbox.bytesSinceHeartbeat += packet.length;
        client.traffic.sent += 1;
        this.write(client, packet, reply ? 'reply' : 'relayed');
    }

    // The tick's heartbeat. Skipped while an earlier one is still queued: a client that keeps sending
    // but never reads (a send-only script, a dead receive loop) stays connected by what it sends and
    // would otherwise queue ten heartbeats a second. A reading client loses nothing: it finds the
    // queued one and gets the next on the first tick after that has gone to the kernel.
    public writeTickHeartbeat(client: TcpClient, packet: Buffer): void {
        if (client.outbox.heartbeatsQueued > 0) return;
        this.writeHeartbeat(client, packet);
    }

    // Never dropped for a client that is behind, unlike relayed traffic: a client with nothing of its
    // own to send stays connected only by echoing heartbeats (IdleWatch.endIdleClients). Bounded
    // instead: one per HEARTBEAT_EVERY_BYTES of admitted messages, and the tick's are not queued
    // behind one still waiting (writeTickHeartbeat).
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

            // A gone peer fails every write queued for it, each with its own callback: thousands of
            // warnings for a client that dropped off Wi-Fi with updates backed up. The connection is
            // already reported once, by the socket's 'error' (TCPServerWorker.handleSocketError) or by
            // this server closing it.
            const code = errorCode(err);
            if (code && (PEER_GONE_ERRORS.has(code) || WRITE_CANCELLED_ERRORS.has(code))) return;

            this.callbacks.logWarning(
                `Failed to send message to client ${client.id}: ${err.message} `
            );
        });
    }

    // Whether relayed traffic may still be queued for the client: not once more than highWaterMark of
    // it is waiting. Replies waiting ahead of it do not count, so a client still reading the answer
    // to its model::request gets the updates made meanwhile too.
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
