import {
    TCP_SERVER_WORKER,
    TCP_SERVER_WORKER_ROLE,
    TcpClientActivityReport,
    TcpClientConnected,
    TcpServerOptions,
    WireNetworkMessage,
} from './tcp-server-worker.js';
import { ClientActivity } from './client-activity.js';
import { Payload, TlsCredentialSource, WorkerServiceProxy } from '../core/index.js';
import { ownBytes } from './protocol.js';
import { Observable, Subject, Subscription } from 'rxjs';
import { Delivery, NetworkClient, NetworkMessage, NetworkServer } from '../command-hooks/index.js';

const toBuffer = function (value: Buffer | Uint8Array): Buffer {
    if (Buffer.isBuffer(value)) return value;
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
};

// Bounded so a worker that dies immediately on start (a port already in use, say) reports
// the problem instead of respawning forever. Reset once a client actually connects, which
// is proof the restarted transport works.
const MAX_RESTART_ATTEMPTS = 5;
const RESTART_DELAY_MILLIS = 1000;

// How long clientActivity() waits for the worker's answer. The answer queues behind the TCP
// messages the main thread has yet to handle, so under load it can take a while; past this the
// admin UI gets no activity for the TCP clients this once rather than waiting.
export const CLIENT_ACTIVITY_TIMEOUT_MILLIS = 1000;

// A TCP client as the main thread knows it.
export interface TcpNetworkClient extends NetworkClient {
    // Its address, behind a proxy the one its PROXY protocol header named.
    address: string;
    tls: boolean;
    // Whether it reached a trusted proxy over TLS, as TCP_TLS_AT_PROXY says; see TcpClientConnected.
    tlsAtProxy: boolean;
    // Date.now() of the connection.
    connectedAt: number;
}

const NO_ACTIVITY: ReadonlyMap<string, ClientActivity> = new Map();

// A clientActivity() request waiting for the worker's answer.
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
    // Mirrors the worker's own clientsByApp index on this side of the postMessage
    // boundary, purely so broadcastToApp can answer "is there any TCP client in this app?"
    // without paying asBytes() and a structured clone to find out the answer is no.
    private readonly clientIdsByApp = new Map<string, Set<string>>();
    private clientStream = new Subject<ReadonlyArray<NetworkClient>>();
    private clientAddedStream = new Subject<TcpNetworkClient>();
    private clientRemovedStream = new Subject<TcpNetworkClient>();

    private messageStream = new Subject<NetworkMessage>();

    // How many clientMessage$ the worker has posted that have not been dispatched here yet: the
    // worker adds one per post, this side takes one off per message handled. Shared memory rather
    // than a message, because it has to be readable while the very queue it measures is full. The
    // worker holds back model updates and drops broadcasts while it is over the limit; see
    // InboundBacklog.
    private readonly inboundBacklog = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

    // What the worker needs to know beyond the port: everything in TcpServerOptions except the
    // backlog counter, which is this proxy's own. The TLS certificate in it is always the latest, so
    // that a restarted worker starts with that one.
    private startOptions: { port: number; host: string; options: Omit<TcpServerOptions, 'inboundBacklog'> } | undefined;
    private restartAttempts = 0;
    private restartTimer: NodeJS.Timeout | undefined;
    private tlsChanges: Subscription | undefined;

    // The clientActivity() requests waiting for the worker's answer, by whether they ask for the
    // rate history.
    private readonly activityRequests = new Map<boolean, ActivityRequest>();
    private lastActivityRequest = 0;

    public get clients$(): Observable<ReadonlyArray<NetworkClient>> {
        return this.clientStream.asObservable();
    }
    public get currentClients(): ReadonlyArray<TcpNetworkClient> {
        return Array.from(this.clients.values());
    }
    // TcpNetworkClient rather than NetworkClient: the voice server needs each client's address.
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
                        // Even if a subscriber threw: a message counted and never taken off again
                        // would leave the worker that much closer to its limit, for good.
                        Atomics.sub(this.inboundBacklog, 0, 1);
                    }
                    break;
                }
            }
        });
    }

    // `tls`: accept only TLS connections, with this certificate and each renewed one.
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
        // Cleared first so a worker exit triggered by the terminate below isn't mistaken
        // for a crash and restarted underneath the shutdown.
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

    // What the admin UI's client view shows of each TCP client's traffic, by client id, from the
    // worker, which counts it. Asked for, and answered, only while an admin UI page shows it: one
    // round trip a second. With `history`, each client's rate history too, for a page's first
    // snapshot. Requests made while one of the same kind is waiting share its answer. Resolves with
    // nothing for a client the worker did not report, and with nothing at all if the worker has not
    // answered within CLIENT_ACTIVITY_TIMEOUT_MILLIS.
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

    // An answer that comes after its request timed out is dropped: a later request is waiting for
    // its own.
    private finishActivityRequest(id: number, activity: ReadonlyMap<string, ClientActivity>): void {
        for (const [ history, request ] of this.activityRequests) {
            if (request.id !== id) continue;
            this.activityRequests.delete(history);
            request.resolve(activity);
            return;
        }
    }

    // The TCP transport is the whole reason this process exists for Unity clients, so a
    // worker that dies must not leave a half-alive server: HTTP and Socket.IO would keep
    // answering normally while every TCP client is gone and every postMessage to the dead
    // thread is silently discarded.
    protected override onWorkerExited(): void {
        // The thread took every connection with it. Report the disconnects so nothing
        // downstream (ModelSynchronization, the admin UI client list) keeps a stale client.
        for (const client of Array.from(this.clients.values())) {
            this.clients.delete(client.id);
            this.removeFromAppIndex(client);
            this.clientRemovedStream.next(client);
        }
        this.clientStream.next(this.currentClients);

        // Node delivers every message a worker posted before it reports the worker's exit, so
        // the backlog is back to 0 by now. Reset all the same: a count left behind by a thread
        // that no longer exists would have the next one limiting messages from the start.
        Atomics.store(this.inboundBacklog, 0, 0);

        // No startOptions means we were never started, or are being shut down on purpose.
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

    // Fast path for "broadcast to every client of one app": rather than shipping a
    // per-client id array across the worker boundary (structured-clone cost scales with
    // client count), the worker resolves recipients from its own per-app index.
    public broadcastToApp(msg: NetworkMessage, app: string, exceptClientId?: string): void {
        // A web-only deployment (or any app whose clients are all web clients, which
        // always includes 'colibri') would otherwise pay a full JSON.stringify plus a
        // structured clone into the worker on every broadcast, only for the worker to
        // resolve an empty recipient set and return.
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

    // ownBytes, because this payload is about to be structured-cloned into the worker, which
    // copies the whole ArrayBuffer behind it. A TCP-origin payload already owns its bytes and
    // passes through untouched; anything asBytes() had to encode from a string (every web-origin
    // or server-built message) is a view into the 64 KiB Buffer pool and is copied out first.
    private toWireMessage(msg: NetworkMessage): { channel: string; command: string; payload: Buffer } {
        return {
            channel: msg.channel,
            command: msg.command,
            payload: ownBytes(msg.payload?.asBytes() ?? Buffer.alloc(0)),
        };
    }

    private onClientConnected(client: TcpNetworkClient): void {
        // A client completing a handshake proves the (possibly restarted) worker is
        // healthy, so the restart budget starts over from here.
        this.restartAttempts = 0;

        // A TCP client can handshake again on the same connection; the worker then reports it
        // connected again under the same id, in its new app. Downstream that has to look like
        // leaving the old app and joining the new one - ConnectionPool's app index,
        // ModelSynchronization clearing the store of an app whose last client left, and
        // ClientBroadcast's client::disconnected - or the old app keeps the id, and its store,
        // forever. The new entry is in `clients` before the old one is reported gone, so a
        // re-handshake into the *same* app is not mistaken for that app's last client leaving.
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
