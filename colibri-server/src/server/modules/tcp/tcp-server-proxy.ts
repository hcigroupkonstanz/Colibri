import type {
    TcpClientActivityReport,
    TcpClientConnected,
    TcpServerOptions,
    WireNetworkMessage,
} from './worker/tcp-server-worker.js';
import {
    TCP_SERVER_WORKER,
    TCP_SERVER_WORKER_ROLE,
} from './worker/tcp-server-worker.js';
import type { ClientActivity } from '../limits/client-activity.js';
import { Payload } from '../protocol/payload.js';
import type { TlsCredentialSource } from '../tls/tls-certificate.js';
import { WorkerServiceProxy } from '../core/worker/worker-service-proxy.js';
import { ownBytes } from '../protocol/protocol.js';
import type { Observable, Subscription } from 'rxjs';
import { Subject } from 'rxjs';
import type { Delivery, NetworkClient, NetworkMessage, NetworkServer } from '../protocol/network.js';

const toBuffer = function (value: Buffer | Uint8Array): Buffer {
    if (Buffer.isBuffer(value)) return value;
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
};

// Bounded so a worker that dies right on start (port in use, say) is not respawned forever.
// Reset when a client connects, which shows the restarted worker works.
const MAX_RESTART_ATTEMPTS = 5;
const RESTART_DELAY_MILLIS = 1000;

// The worker's answer to clientActivity() queues behind the TCP messages the main thread has yet to
// handle, so under load it can be late; the admin UI then shows no activity for the TCP clients that time.
export const CLIENT_ACTIVITY_TIMEOUT_MILLIS = 1000;

export interface TcpNetworkClient extends NetworkClient {
    // Behind a proxy, the address its PROXY protocol header named.
    address: string;
    tls: boolean;
    // Came through a trusted proxy and TCP_TLS_AT_PROXY says that proxy ends TLS.
    tlsAtProxy: boolean;
    // Date.now() at connect.
    connectedAt: number;
}

const NO_ACTIVITY: ReadonlyMap<string, ClientActivity> = new Map();

interface ActivityRequest {
    id: number;
    resolve: (activity: ReadonlyMap<string, ClientActivity>) => void;
    promise: Promise<ReadonlyMap<string, ClientActivity>>;
}

export class TCPServerProxy
    extends WorkerServiceProxy
    implements NetworkServer {
    public serviceName = 'UnityServer';
    public groupName = 'unity';

    private readonly clients = new Map<string, TcpNetworkClient>();
    // Mirrors the worker's clientsByApp, so broadcastToApp can tell there is no recipient without posting.
    private readonly clientIdsByApp = new Map<string, Set<string>>();
    private clientStream = new Subject<ReadonlyArray<NetworkClient>>();
    private clientAddedStream = new Subject<TcpNetworkClient>();
    private clientRemovedStream = new Subject<TcpNetworkClient>();

    private messageStream = new Subject<NetworkMessage>();

    // clientMessage$ posted by the worker and not dispatched here yet. Shared memory, so the worker
    // can read it while the queue it measures is full (see InboundBacklog).
    private readonly inboundBacklog = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

    // Kept for restarts. options.tls is always the latest certificate.
    private startOptions: { port: number; host: string; options: Omit<TcpServerOptions, 'inboundBacklog'> } | undefined;
    private restartAttempts = 0;
    private restartTimer: NodeJS.Timeout | undefined;
    private tlsChanges: Subscription | undefined;

    // Pending clientActivity() requests, by whether they ask for the rate history.
    private readonly activityRequests = new Map<boolean, ActivityRequest>();
    private lastActivityRequest = 0;

    public get clients$(): Observable<ReadonlyArray<NetworkClient>> {
        return this.clientStream.asObservable();
    }
    public get currentClients(): ReadonlyArray<TcpNetworkClient> {
        return Array.from(this.clients.values());
    }
    // TcpNetworkClient rather than NetworkClient: the voice server admits UDP senders by a client's address.
    public get clientConnected$(): Observable<TcpNetworkClient> {
        return this.clientAddedStream.asObservable();
    }
    public get clientDisconnected$(): Observable<TcpNetworkClient> {
        return this.clientRemovedStream.asObservable();
    }
    public get messages$(): Observable<NetworkMessage> {
        return this.messageStream.asObservable();
    }

    public constructor() {
        super();
        this.initWorker(TCP_SERVER_WORKER, { role: TCP_SERVER_WORKER_ROLE });

        this.workerMessages$.subscribe((msg) => {
            switch (msg.channel) {
                case 'clientConnected$': {
                    const connected = msg.content as unknown as TcpClientConnected;
                    this.onClientConnected({
                        id: connected.id,
                        app: connected.app,
                        name: connected.name,
                        version: connected.version,
                        address: connected.address,
                        tls: connected.tls,
                        tlsAtProxy: connected.tlsAtProxy,
                        connectedAt: connected.connectedAt,
                        metadata: {},
                    });
                    break;
                }

                case 'clientActivity$':
                    this.onClientActivity(msg.content as unknown as TcpClientActivityReport);
                    break;

                case 'clientDisconnected$':
                    this.onClientDisconnected(msg.content.id as string);
                    break;

                case 'clientMessage$': {
                    const wireMessage = msg.content as unknown as WireNetworkMessage;
                    try {
                        this.onClientMessage({
                            channel: wireMessage.channel,
                            command: wireMessage.command,
                            payload: Payload.fromBytes(toBuffer(wireMessage.payload)),
                            origin: wireMessage.origin ? this.clients.get(wireMessage.origin.id) : undefined,
                        });
                    } finally {
                        // Also when a subscriber throws, or the count would stay up for good.
                        Atomics.sub(this.inboundBacklog, 0, 1);
                    }
                    break;
                }
            }
        });
    }

    // `tls`: the port accepts only TLS connections, served with these credentials and each renewal.
    public start(
        port: number,
        host: string,
        options: Omit<TcpServerOptions, 'inboundBacklog' | 'tls'> = {},
        tls?: TlsCredentialSource
    ): void {
        this.startOptions = { port, host, options: tls ? { ...options, tls: tls.credentials } : options };

        this.tlsChanges?.unsubscribe();
        this.tlsChanges = tls?.changes$.subscribe((credentials) => {
            if (this.startOptions) {
                this.startOptions = { ...this.startOptions, options: { ...this.startOptions.options, tls: credentials } };
            }
            this.postMessage('m:tlsCredentials', { tls: credentials });
        });

        this.postStart();
        this.clientStream.next(this.currentClients);
    }

    private postStart(): void {
        if (!this.startOptions) return;

        const { port, host, options } = this.startOptions;
        this.postMessage('m:start', { port, host, options: { ...options, inboundBacklog: this.inboundBacklog } });
    }

    public async stop(): Promise<void> {
        this.startOptions = undefined;
        this.tlsChanges?.unsubscribe();
        this.tlsChanges = undefined;
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = undefined;
        }
        for (const { id } of Array.from(this.activityRequests.values())) this.finishActivityRequest(id, NO_ACTIVITY);

        this.postMessage('m:stop');
        await this.terminateWorker();
    }

    // Traffic per TCP client id as the worker counts it (admin UI); `history` adds each client's rate
    // history. Requests of one kind share the pending answer. Resolves empty after timeoutMillis.
    public clientActivity(timeoutMillis = CLIENT_ACTIVITY_TIMEOUT_MILLIS, history = false): Promise<ReadonlyMap<string, ClientActivity>> {
        if (this.clients.size === 0) return Promise.resolve(NO_ACTIVITY);
        const waiting = this.activityRequests.get(history);
        if (waiting) return waiting.promise;

        const id = ++this.lastActivityRequest;
        let resolve!: (activity: ReadonlyMap<string, ClientActivity>) => void;
        const promise = new Promise<ReadonlyMap<string, ClientActivity>>(r => (resolve = r));
        const timeout = setTimeout(() => this.finishActivityRequest(id, NO_ACTIVITY), timeoutMillis);
        timeout.unref();
        this.activityRequests.set(history, {
            id,
            promise,
            resolve: (activity) => {
                clearTimeout(timeout);
                resolve(activity);
            },
        });
        this.postMessage('m:clientActivity', history ? { request: id, history } : { request: id });
        return promise;
    }

    private onClientActivity(report: TcpClientActivityReport): void {
        const activity = new Map<string, ClientActivity>();
        for (const { id, ...rest } of report.clients ?? []) activity.set(id, rest);
        this.finishActivityRequest(report.request, activity);
    }

    // An answer to a request that already timed out matches nothing and is dropped.
    private finishActivityRequest(id: number, activity: ReadonlyMap<string, ClientActivity>): void {
        for (const [ history, request ] of this.activityRequests) {
            if (request.id !== id) continue;
            this.activityRequests.delete(history);
            request.resolve(activity);
            return;
        }
    }

    // Restarted rather than left dead: HTTP and Socket.IO would keep running with every TCP client
    // gone and posts to the dead thread discarded.
    protected override onWorkerExited(): void {
        // The thread took every connection with it; report them gone so downstream state is dropped.
        for (const client of Array.from(this.clients.values())) {
            this.clients.delete(client.id);
            this.removeFromAppIndex(client);
            this.clientRemovedStream.next(client);
        }
        this.clientStream.next(this.currentClients);

        // Node delivers a worker's posted messages before its exit, so this is 0 already; reset
        // anyway, or the next worker would start with a stale count.
        Atomics.store(this.inboundBacklog, 0, 0);

        // start() has not been called, or stop() has.
        if (!this.startOptions) return;

        if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
            this.logError(
                `TCP server worker exited ${this.restartAttempts} times; not restarting again`,
                false
            );
            return;
        }

        this.restartAttempts += 1;
        this.restartTimer = setTimeout(() => {
            this.restartTimer = undefined;
            this.logWarning(`Restarting the TCP server worker (attempt ${this.restartAttempts}/${MAX_RESTART_ATTEMPTS})`);
            if (this.restartWorker()) {
                this.postStart();
            }
        }, RESTART_DELAY_MILLIS);
    }

    public broadcast(
        msg: NetworkMessage,
        clients: ReadonlyArray<NetworkClient> = this.currentClients,
        delivery: Delivery = 'relay'
    ): void {
        this.postMessage('m:broadcast', {
            msg: this.toWireMessage(msg),
            clients: clients.map((c) => c.id),
            reply: delivery === 'reply',
        });
    }

    // Broadcast to one app's TCP clients. The worker resolves them from its per-app index, so no id
    // array is cloned into it.
    public broadcastToApp(msg: NetworkMessage, app: string, exceptClientId?: string): void {
        // No TCP recipient (a web-only app, say): skip the encoding and the structured clone.
        if (!this.hasRecipients(app, exceptClientId)) return;

        this.postMessage('m:broadcastToApp', {
            msg: this.toWireMessage(msg),
            app,
            exclude: exceptClientId,
        });
    }

    public hasRecipients(app: string, exceptClientId?: string): boolean {
        const ids = this.clientIdsByApp.get(app);
        if (!ids || ids.size === 0) return false;
        if (exceptClientId !== undefined && ids.size === 1 && ids.has(exceptClientId)) return false;
        return true;
    }

    // ownBytes: the structured clone into the worker copies the payload's whole ArrayBuffer, and
    // asBytes() of a string payload is a view into Node's 64 KiB Buffer pool.
    private toWireMessage(msg: NetworkMessage): { channel: string; command: string; payload: Buffer } {
        return {
            channel: msg.channel,
            command: msg.command,
            payload: ownBytes(msg.payload?.asBytes() ?? Buffer.alloc(0)),
        };
    }

    private onClientConnected(client: TcpNetworkClient): void {
        this.restartAttempts = 0;

        // A re-handshake arrives as a second connect under the same id, maybe in another app. The old
        // entry is reported disconnected so its app drops the id, after the new one is set so the same app is not seen empty.
        const previous = this.clients.get(client.id);
        this.clients.set(client.id, client);
        if (previous) {
            this.removeFromAppIndex(previous);
            this.clientRemovedStream.next(previous);
        }

        this.addToAppIndex(client);
        this.clientAddedStream.next(client);
        this.clientStream.next(this.currentClients);
    }

    private onClientDisconnected(id: string): void {
        const client = this.clients.get(id);
        this.clients.delete(id);

        if (client) {
            this.removeFromAppIndex(client);
            this.clientRemovedStream.next(client);
        }
        this.clientStream.next(this.currentClients);
    }

    private addToAppIndex(client: TcpNetworkClient): void {
        let ids = this.clientIdsByApp.get(client.app);
        if (!ids) {
            ids = new Set();
            this.clientIdsByApp.set(client.app, ids);
        }
        ids.add(client.id);
    }

    private removeFromAppIndex(client: TcpNetworkClient): void {
        const ids = this.clientIdsByApp.get(client.app);
        if (!ids) return;

        ids.delete(client.id);
        if (ids.size === 0) {
            this.clientIdsByApp.delete(client.app);
        }
    }

    private onClientMessage(msg: NetworkMessage): void {
        this.messageStream.next(msg);
    }
}
