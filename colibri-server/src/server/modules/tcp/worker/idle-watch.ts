import type { TcpServerOptions } from '../worker-messages.js';
import { HEARTBEAT_EVERY_BYTES } from './heartbeat-every-bytes.js';
import type { TcpClient } from './tcp-client.js';

// How long a client may send nothing at all before it is taken for gone. A headset that drops off
// the Wi-Fi sends no FIN, and the kernel takes many minutes to give up retransmitting to it. A live
// client is never this quiet: colibri-unity echoes the 100 ms heartbeat from its receive thread,
// even while its main thread loads a scene, as long as it finds heartbeats in what it reads, also
// in a backlog (see HEARTBEAT_EVERY_BYTES and ClientWriter.writeToClient).
//
// A message larger than HEARTBEAT_EVERY_BYTES has no heartbeat inside it, so a client reading one
// echoes nothing until it is through, and this server cannot watch the read: a write is done for
// Node.js once the kernel has taken it, and the kernel's buffers and a proxy's in between (Docker's
// port forwarding) take megabytes at once. Until the client echoes a heartbeat sent after the
// latest such message, it may therefore stay quiet longer: see idleAllowanceMillis.
const DEFAULT_IDLE_TIMEOUT_MILLIS = 10_000;

// The most idle timeouts a client reading a large message may stay quiet on top of its own; see
// DEFAULT_IDLE_TIMEOUT_MILLIS. Behind a proxy such as Docker's port forwarding nothing else
// notices a gone client (the kernel's connection is to the proxy), so each one keeps it, and its
// app's models, alive that much longer. With 6 (70 s in all at the default) a 4 MiB message still
// gets through at about 60 KB/s, and a gone client is noticed within 7 idle timeouts at worst.
const MAX_IDLE_ALLOWANCE_TIMEOUTS = 6;

// If the worker's 100 ms tick comes this late, the thread was stalled (a long GC, a starved CPU) and
// read nothing meanwhile, so every client would look idle. The check is skipped for that tick; by the
// next, what the clients sent during the stall has been read.
const TICK_STALL_MILLIS = 2000;

const describeSize = function (bytes: number): string {
    const mebibyte = 1024 * 1024;
    return bytes >= mebibyte ? `${(bytes / mebibyte).toFixed(1)} MiB` : `${Math.round(bytes / 1024)} KiB`;
};

interface IdleWatchCallbacks {
    // Drops the client from every index and posts clientDisconnected$ (TCPServerWorker.handleSocketDisconnect).
    handleSocketDisconnect(client: TcpClient): void;
    logDebug(msg: string): void;
    logWarning(msg: string): void;
}

// The TCP worker's idle timeout (TCP_IDLE_TIMEOUT_SECONDS): ends the clients that have gone quiet.
export class IdleWatch {
    private idleTimeoutMillis = DEFAULT_IDLE_TIMEOUT_MILLIS;
    private lastTickAt: number | undefined;

    public constructor(private readonly callbacks: IdleWatchCallbacks) {}

    public configure(options: Pick<TcpServerOptions, 'idleTimeoutMillis'>): void {
        this.idleTimeoutMillis = options.idleTimeoutMillis ?? DEFAULT_IDLE_TIMEOUT_MILLIS;
    }

    // Called from the worker's tick; `now` is performance.now().
    public tick(now: number, clients: ReadonlyMap<string, TcpClient>, waitingClients: ReadonlyMap<string, TcpClient>): void {
        const stalled = this.lastTickAt !== undefined && now - this.lastTickAt > TICK_STALL_MILLIS;
        this.lastTickAt = now;
        if (!stalled) this.endIdleClients(now, clients, waitingClients);
    }

    // Ends every client that has sent nothing for idleTimeoutMillis plus its idleAllowanceMillis, as if
    // it had disconnected (so its app's models are dropped if it was the last client). Destroyed, not
    // ended: a gone peer neither reads what is queued for it nor answers a FIN.
    //
    // A client still waiting for its handshake is held to the same limit, counted from its connect:
    // nothing is written to it, so nothing else would notice one that never handshakes.
    private endIdleClients(now: number, clients: ReadonlyMap<string, TcpClient>, waitingClients: ReadonlyMap<string, TcpClient>): void {
        if (this.idleTimeoutMillis <= 0) return;

        for (const client of [...clients.values(), ...waitingClients.values()]) {
            const allowance = this.idleAllowanceMillis(client);
            if (client.reading.lastInboundAt > now - this.idleTimeoutMillis - allowance) continue;

            const seconds = Math.round((now - client.reading.lastInboundAt) / 1000);
            if (clients.has(client.id)) {
                const reading = allowance > 0
                    ? `, and ${Math.round(allowance / 1000)} s more for reading a ${describeSize(client.reading.unreadLargeBytes)} message sent to it`
                    : '';
                const tooSlow = allowance > 0 ? ', and so does a link too slow to read that message in that time' : '';
                this.callbacks.logWarning(
                    `Unity client '${client.name}' (${client.id}, app '${client.app}', ${client.address}) has sent nothing for ` +
                        `${seconds} s (TCP_IDLE_TIMEOUT_SECONDS${reading}); disconnecting it as gone. A headset that left the ` +
                        `Wi-Fi or went to sleep without closing its connection looks like this${tooSlow}.`
                );
            } else {
                this.callbacks.logDebug(`Disconnecting client ${client.id} from ${client.address}: no handshake within ${seconds} s`);
            }

            this.callbacks.handleSocketDisconnect(client);
            client.socket.destroy();
        }
    }

    // How much longer than idleTimeoutMillis the client may stay quiet while reading a large message:
    // one more timeout per HEARTBEAT_EVERY_BYTES of unreadLargeBytes (the rate the heartbeats between
    // messages already assume, 6.4 KiB/s at the default), at most MAX_IDLE_ALLOWANCE_TIMEOUTS. It ends
    // once the client echoes a heartbeat sent after the message; one that never echoes keeps it. The
    // price is that a client that goes while such a message is sent or read is noticed that much later.
    private idleAllowanceMillis(client: TcpClient): number {
        return this.idleTimeoutMillis * Math.min(client.reading.unreadLargeBytes / HEARTBEAT_EVERY_BYTES, MAX_IDLE_ALLOWANCE_TIMEOUTS);
    }
}
