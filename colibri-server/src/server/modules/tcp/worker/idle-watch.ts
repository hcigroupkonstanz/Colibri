import type { TcpServerOptions } from '../worker-messages.js';
import { HEARTBEAT_EVERY_BYTES } from './heartbeat-every-bytes.js';
import type { TcpClient } from './tcp-client.js';

// How long a client may send nothing at all before it is taken for gone. A Quest that drops off
// the Wi-Fi sends no FIN, so without this its connection stayed open - a connected client, keeping
// its app's synchronized models alive - until the kernel gave up retransmitting to it, which takes
// many minutes. A live client is never anywhere near this quiet: colibri-unity echoes the 100 ms
// heartbeat from its receive thread, so even a main thread busy loading a scene keeps it talking.
//
// That holds only as long as the client finds heartbeats in what it reads, also while it is still
// reading a backlog: see HEARTBEAT_EVERY_BYTES and TCPServerWorker.writeHeartbeat.
//
// A message larger than HEARTBEAT_EVERY_BYTES has no heartbeat inside it, though, so a client
// reading one can echo nothing until it is through: a 4 MiB broadcast takes about 21 s over a link
// of 200 KB/s. Nor can this server watch it being read. A write is done for Node.js once the kernel
// has taken it, and the kernel's buffers, and those of a proxy in between such as Docker's port
// forwarding, take megabytes at once: on loopback, all of that broadcast within 0.2 s. Such a client
// was disconnected 10 s in while reading all along, and once it had reconnected it never got the
// message. So until a client echoes a heartbeat sent after the latest such message written to it,
// it may stay quiet one more idle timeout for every HEARTBEAT_EVERY_BYTES of the largest one sent
// to it since it last did, the rate the heartbeats between messages already assume (6.4 KiB/s at
// the default), up to MAX_IDLE_ALLOWANCE_TIMEOUTS more (idleAllowanceMillis). The extra time ends
// once it echoes a heartbeat sent after the latest one; a client that never echoes heartbeats
// keeps it from its first such message on. The price is that a client that is gone by the time
// such a message is sent to it, or goes while it is being read, is noticed that much later.
const DEFAULT_IDLE_TIMEOUT_MILLIS = 10_000;

// The most idle timeouts a client reading a large message may stay quiet on top of its own; see
// DEFAULT_IDLE_TIMEOUT_MILLIS. Each one keeps a client that has gone connected, and its app's models
// alive, that much longer, and behind Docker Desktop's port forwarding or another proxy nothing else
// notices it at all: the server's connection is to the proxy, so the kernel never gives up on it
// either. Without a limit that was up to 81 idle timeouts in all, 13.5 minutes, for a message of
// MAX_FRAME_LENGTH. With 6, 60 s at the default, a 4 MiB message still gets through at about
// 60 KB/s or faster (the link it was reproduced on did 200 KB/s), and a client that has gone is
// noticed within 7 idle timeouts at worst.
const MAX_IDLE_ALLOWANCE_TIMEOUTS = 6;

// If the worker's own 100 ms tick comes this late, the thread itself was stalled (a long GC, a
// starved CPU) and could not have read anything in the meantime. Every client would look idle for
// that long, so the idle check is skipped for that one tick: by the next, whatever the clients sent
// during the stall has been read.
const TICK_STALL_MILLIS = 2000;

// A message size for the log: in MiB from 1 MiB, in KiB below.
const describeSize = function (bytes: number): string {
    const mebibyte = 1024 * 1024;
    return bytes >= mebibyte ? `${(bytes / mebibyte).toFixed(1)} MiB` : `${Math.round(bytes / 1024)} KiB`;
};

// What IdleWatch needs from the TCP worker that owns it.
interface IdleWatchCallbacks {
    // Drops the client from every index and posts clientDisconnected$; see
    // TCPServerWorker.handleSocketDisconnect.
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

    // Runs on the worker's every tick, at `now` (its performance.now() reading).
    public tick(now: number, clients: ReadonlyMap<string, TcpClient>, waitingClients: ReadonlyMap<string, TcpClient>): void {
        const stalled = this.lastTickAt !== undefined && now - this.lastTickAt > TICK_STALL_MILLIS;
        this.lastTickAt = now;
        if (!stalled) this.endIdleClients(now, clients, waitingClients);
    }

    // Ends every client that has sent nothing for idleTimeoutMillis, plus its idleAllowanceMillis,
    // exactly as if it had disconnected: out of every index, clientDisconnected$ posted, and so its
    // app's models dropped once it was the app's last client. Destroyed rather than ended - a peer
    // that is gone will neither read what is still queued for it nor answer a FIN.
    //
    // A client still waiting for its handshake is held to the same limit, counted from when it
    // connected: a real client handshakes at once, and since nothing is sent to a waiting client
    // any more, nothing else would ever notice one that never does.
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

    // How much longer than idleTimeoutMillis the client may stay quiet: one more idle timeout for
    // every HEARTBEAT_EVERY_BYTES of the message unreadLargeBytes measures, the time it takes at the
    // rate the heartbeats already assume, but no more than MAX_IDLE_ALLOWANCE_TIMEOUTS. See
    // DEFAULT_IDLE_TIMEOUT_MILLIS.
    private idleAllowanceMillis(client: TcpClient): number {
        return this.idleTimeoutMillis * Math.min(client.reading.unreadLargeBytes / HEARTBEAT_EVERY_BYTES, MAX_IDLE_ALLOWANCE_TIMEOUTS);
    }
}
