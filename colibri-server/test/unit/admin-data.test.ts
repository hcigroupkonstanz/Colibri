import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Subject } from 'rxjs';
import { DataStore } from '../../src/server/modules/command-hooks/data-store.js';
import { NetworkClient, NetworkMessage } from '../../src/server/modules/command-hooks/connection-pool.js';
import { Payload } from '../../src/server/modules/core/payload.js';
import { RingBuffer } from '../../src/server/modules/core/ring-buffer.js';
import { ClientActivity } from '../../src/server/modules/networking/client-activity.js';
import { SocketIoClient, SocketIOServer } from '../../src/server/modules/networking/socket-io-server.js';
import { TCPServerProxy, TcpNetworkClient } from '../../src/server/modules/networking/tcp-server-proxy.js';
import { ADMIN_CHANNEL, ADMIN_REFRESH_MILLIS, ADMIN_REQUEST_LIMIT, AdminData } from '../../src/server/modules/web/admin-data.js';

class FakeSocketIOServer {
    public readonly messagesSource = new Subject<NetworkMessage>();
    public readonly disconnectedSource = new Subject<NetworkClient>();
    public clients: SocketIoClient[] = [];
    public sent: { client: SocketIoClient; command: string; payload: Record<string, unknown> }[] = [];

    public get messages$() {
        return this.messagesSource.asObservable();
    }

    public get clientDisconnected$() {
        return this.disconnectedSource.asObservable();
    }

    public get currentClients(): ReadonlyArray<SocketIoClient> {
        return this.clients;
    }

    public getClient(id: string): SocketIoClient | undefined {
        return this.clients.find(c => c.id === id);
    }

    public broadcast(message: NetworkMessage, clients: ReadonlyArray<SocketIoClient>): void {
        for (const client of clients) {
            this.sent.push({ client, command: message.command, payload: message.payload!.asValue<Record<string, unknown>>() });
        }
    }

    public activityOf(_client: SocketIoClient, history = false): ClientActivity {
        return { in: 1, out: 2, limit: null, held: 0, ...(history ? { history: [ [ Date.now() - 1000, 1, 2 ] ] } : {}) };
    }

    public connect(id: string, app = 'colibri', tlsAtProxy = false): SocketIoClient {
        const client: SocketIoClient = {
            id, app, name: '127.0.0.1', version: '2', metadata: {}, tlsAtProxy,
            socket: { handshake: { secure: false, issued: 0 }, conn: { transport: { writable: true } } } as never,
        };
        this.clients.push(client);
        return client;
    }

    public disconnect(client: SocketIoClient): void {
        this.clients = this.clients.filter(c => c !== client);
        this.disconnectedSource.next(client);
    }
}

class FakeTcpServer {
    public clients: TcpNetworkClient[] = [];
    public readonly clientActivity = vi.fn(async (): Promise<ReadonlyMap<string, ClientActivity>> =>
        new Map([[ 't1', { in: 10, out: 20, limit: 'backlog', held: 4 } ]]));

    public get currentClients(): ReadonlyArray<TcpNetworkClient> {
        return this.clients;
    }
}

// Lets the promise chains of an answer settle; the TCP worker's answer is a resolved promise here.
const settle = async function (): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('AdminData', () => {
    let socketio: FakeSocketIOServer;
    let tcp: FakeTcpServer;
    let store: DataStore;
    let admin: AdminData;

    const send = function (client: SocketIoClient, command: string, payload: unknown): void {
        socketio.messagesSource.next({ channel: ADMIN_CHANNEL, command, origin: client, payload: Payload.fromValue(payload) });
    };

    const sentTo = (client: SocketIoClient) => socketio.sent.filter(s => s.client === client);

    beforeEach(async () => {
        vi.useFakeTimers();
        socketio = new FakeSocketIOServer();
        tcp = new FakeTcpServer();
        tcp.clients = [ {
            id: 't1', app: 'app', name: 'headset', version: '2', metadata: {}, address: '10.0.0.5', tls: false, tlsAtProxy: false, connectedAt: 0,
        } ];
        store = new DataStore();
        store.updateModel('app', 'cubes', { id: 'c1', x: 1 });
        admin = await start();
    });

    const start = async function (tcpTlsAtProxy?: boolean): Promise<AdminData> {
        const started = new AdminData({
            store,
            socketio: socketio as unknown as SocketIOServer,
            tcp: tcp as unknown as TCPServerProxy,
            version: '2.0.0',
            build: { commit: '3e2855e0c1d2b3a4f5e6d7c8b9a0f1e2d3c4b5a6', dirty: false, builtAt: 1_699_990_000_000 },
            startedAt: Date.now(),
            settings: { TCP_PORT: 9212 },
            ...(tcpTlsAtProxy === undefined ? {} : { tcpTlsAtProxy }),
        });
        await started.init();
        return started;
    };

    afterEach(() => {
        admin.stop();
        vi.useRealTimers();
    });

    it('sends nothing, and asks the TCP worker nothing, while no page asks', async () => {
        socketio.connect('page');
        await vi.advanceTimersByTimeAsync(10 * ADMIN_REFRESH_MILLIS);

        expect(socketio.sent).toEqual([]);
        expect(tcp.clientActivity).not.toHaveBeenCalled();
    });

    it('answers a request once, echoing its request number', async () => {
        const page = socketio.connect('page');
        send(page, 'request', { topic: 'server', request: 7 });
        await settle();

        expect(sentTo(page).map(s => s.command)).toEqual([ 'server' ]);
        expect(sentTo(page)[0]!.payload).toMatchObject({
            request: 7, version: '2.0.0', build: { commit: '3e2855e0c1d2b3a4f5e6d7c8b9a0f1e2d3c4b5a6', dirty: false }, settings: { TCP_PORT: 9212 },
        });

        await vi.advanceTimersByTimeAsync(5 * ADMIN_REFRESH_MILLIS);
        expect(sentTo(page)).toHaveLength(1);
    });

    it('tells a page that reached a trusted proxy over TLS that web TLS is at the proxy', async () => {
        const direct = socketio.connect('direct');
        send(direct, 'request', { topic: 'server' });
        await settle();
        expect(sentTo(direct)[0]!.payload).toMatchObject({ tls: null, tlsAtProxy: { web: false } });

        const proxied = socketio.connect('proxied', 'colibri', true);
        send(proxied, 'request', { topic: 'server' });
        await settle();
        expect(sentTo(proxied)[0]!.payload).toMatchObject({ tls: null, tlsAtProxy: { web: true } });
    });

    it('says that TCP TLS is at the proxy when TCP_TLS_AT_PROXY applies, and not when left out', async () => {
        const page = socketio.connect('page');
        send(page, 'request', { topic: 'server' });
        await settle();
        expect((sentTo(page)[0]!.payload as { tlsAtProxy: unknown }).tlsAtProxy).toEqual({ web: false, tcp: false });

        // stop() leaves the old one listening
        admin.stop();
        socketio = new FakeSocketIOServer();
        admin = await start(true);
        const next = socketio.connect('page');
        send(next, 'request', { topic: 'server' });
        await settle();
        expect((sentTo(next)[0]!.payload as { tlsAtProxy: unknown }).tlsAtProxy).toEqual({ web: false, tcp: true });
    });

    it('sends a subscribed topic at once and then every second, until unsubscribed', async () => {
        const page = socketio.connect('page');
        send(page, 'subscribe', { topic: 'models', request: 1, app: 'app' });
        await settle();
        expect(sentTo(page)).toHaveLength(1);
        expect(sentTo(page)[0]!.payload).toMatchObject({ request: 1, total: 1, models: [ { id: 'c1' } ] });

        store.updateModel('app', 'cubes', { id: 'c2' });
        await vi.advanceTimersByTimeAsync(ADMIN_REFRESH_MILLIS);
        expect(sentTo(page)).toHaveLength(2);
        expect(sentTo(page)[1]!.payload).toMatchObject({ request: 1, total: 2 });

        send(page, 'unsubscribe', { topic: 'models' });
        await vi.advanceTimersByTimeAsync(5 * ADMIN_REFRESH_MILLIS);
        expect(sentTo(page)).toHaveLength(2);
        expect(admin.subscriptionCount).toBe(0);
    });

    it('replaces a topic\'s query when the page subscribes to it again', async () => {
        const page = socketio.connect('page');
        send(page, 'subscribe', { topic: 'models', request: 1, filter: 'nothing' });
        send(page, 'subscribe', { topic: 'models', request: 2, filter: 'c1' });
        await settle();
        socketio.sent = [];

        await vi.advanceTimersByTimeAsync(ADMIN_REFRESH_MILLIS);
        expect(sentTo(page).map(s => [ s.payload.request, s.payload.total ])).toEqual([ [ 2, 1 ] ]);
        expect(admin.subscriptionCount).toBe(1);
    });

    it('forgets a page\'s subscriptions when it disconnects, and stops refreshing', async () => {
        const page = socketio.connect('page');
        send(page, 'subscribe', { topic: 'server' });
        send(page, 'subscribe', { topic: 'clients' });
        await settle();
        expect(admin.subscriptionCount).toBe(2);

        socketio.disconnect(page);
        expect(admin.subscriptionCount).toBe(0);
        socketio.sent = [];
        tcp.clientActivity.mockClear();

        await vi.advanceTimersByTimeAsync(5 * ADMIN_REFRESH_MILLIS);
        expect(socketio.sent).toEqual([]);
        expect(tcp.clientActivity).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('unsubscribes a page from every topic when it names none', async () => {
        const page = socketio.connect('page');
        send(page, 'subscribe', { topic: 'server' });
        send(page, 'subscribe', { topic: 'models' });
        send(page, 'unsubscribe', {});
        expect(admin.subscriptionCount).toBe(0);
    });

    it('asks the TCP worker for its clients\' activity only for the clients topic, once per refresh', async () => {
        const page = socketio.connect('page');
        const other = socketio.connect('other');
        send(page, 'subscribe', { topic: 'server' });
        await settle();
        expect(tcp.clientActivity).not.toHaveBeenCalled();

        send(page, 'subscribe', { topic: 'clients' });
        send(other, 'subscribe', { topic: 'clients' });
        await settle();
        tcp.clientActivity.mockClear();

        await vi.advanceTimersByTimeAsync(ADMIN_REFRESH_MILLIS);
        expect(tcp.clientActivity).toHaveBeenCalledTimes(1);
        const clients = sentTo(other).filter(s => s.command === 'clients').at(-1)!.payload;
        expect(clients).toMatchObject({
            adminPages: 2,
            clients: [ { id: 't1', transport: 'tcp', address: '10.0.0.5', in: 10, out: 20, limit: 'backlog', held: 4 } ],
        });
    });

    it('sends the clients\' rate history with a page\'s first clients snapshot only', async () => {
        tcp.clientActivity.mockImplementation(async () => new Map([[ 't1', { in: 10, out: 20, limit: null, held: 0, history: [ [ Date.now() - 1500, 8, 9 ] ] } ]]));
        socketio.connect('w1', 'app');
        const page = socketio.connect('page');
        send(page, 'subscribe', { topic: 'clients', request: 1 });
        await settle();

        expect(tcp.clientActivity).toHaveBeenLastCalledWith(expect.any(Number), true);
        expect(sentTo(page)[0]!.payload.clients).toEqual([
            expect.objectContaining({ id: 't1', in: 10, history: [ [ 8, 9 ] ] }),
            expect.objectContaining({ id: 'w1', in: 1, history: [ [ 1, 2 ] ] }),
        ]);

        await vi.advanceTimersByTimeAsync(ADMIN_REFRESH_MILLIS);
        expect(tcp.clientActivity).toHaveBeenLastCalledWith(expect.any(Number), false);
        const refreshed = sentTo(page)[1]!.payload.clients as Record<string, unknown>[];
        expect(refreshed.map(row => 'history' in row)).toEqual([ false, false ]);
    });

    it('skips a refresh for a page that has not taken the previous one, but answers its requests', async () => {
        const slow = socketio.connect('slow');
        const page = socketio.connect('page');
        send(slow, 'subscribe', { topic: 'models', request: 1 });
        send(page, 'subscribe', { topic: 'clients', request: 2 });
        await settle();
        socketio.sent = [];

        // a page that stopped reading: its connection is still sending
        const transport = (slow.socket.conn as unknown as { transport: { writable: boolean } }).transport;
        transport.writable = false;
        const channels = vi.spyOn(store, 'channels');
        await vi.advanceTimersByTimeAsync(3 * ADMIN_REFRESH_MILLIS);
        expect(sentTo(slow)).toEqual([]);
        expect(sentTo(page)).toHaveLength(3);
        // nobody else asked for the models, so they were not read
        expect(channels).not.toHaveBeenCalled();

        send(slow, 'request', { topic: 'server', request: 3 });
        await settle();
        expect(sentTo(slow).map(s => s.payload.request)).toEqual([ 3 ]);

        transport.writable = true;
        await vi.advanceTimersByTimeAsync(ADMIN_REFRESH_MILLIS);
        expect(sentTo(slow).map(s => s.payload.request)).toEqual([ 3, 1 ]);
    });

    it('builds one snapshot for every page asking the same', async () => {
        const pages = [ socketio.connect('a'), socketio.connect('b'), socketio.connect('c') ];
        for (const [i, page] of pages.entries()) send(page, 'subscribe', { topic: 'models', request: i, app: 'app' });
        await settle();
        socketio.sent = [];

        const channels = vi.spyOn(store, 'channels');
        await vi.advanceTimersByTimeAsync(ADMIN_REFRESH_MILLIS);
        expect(channels).toHaveBeenCalledTimes(1);
        expect(socketio.sent.map(s => s.payload.request)).toEqual([ 0, 1, 2 ]);
    });

    it('answers a request for the latency history once, and no subscription to it', async () => {
        const samples = new RingBuffer<[number, number]>(10);
        samples.push([ Date.now() - 200, 12.345 ]);
        tcp.clients[0]!.metadata['latency'] = samples;
        const page = socketio.connect('page');
        send(page, 'request', { topic: 'latency', request: 4 });
        send(page, 'subscribe', { topic: 'latency', request: 5 });
        await settle();

        expect(sentTo(page).map(s => s.payload)).toEqual([
            { request: 4, at: Date.now(), clients: [ { id: 't1', samples: [ [ Date.now() - 200, 12.35 ] ] } ], total: 1, medians: false },
        ]);
        expect(admin.subscriptionCount).toBe(0);
        await vi.advanceTimersByTimeAsync(3 * ADMIN_REFRESH_MILLIS);
        expect(sentTo(page)).toHaveLength(1);
    });

    it('answers only the admin UI\'s own app', async () => {
        const client = socketio.connect('client', 'myApp');
        send(client, 'request', { topic: 'server' });
        send(client, 'subscribe', { topic: 'models' });
        await settle();

        expect(socketio.sent).toEqual([]);
        expect(admin.subscriptionCount).toBe(0);
    });

    it('ignores unknown commands and topics, and malformed payloads', async () => {
        const page = socketio.connect('page');
        send(page, 'request', { topic: 'secrets' });
        send(page, 'request', 'server');
        send(page, 'request', null);
        send(page, 'delete', { topic: 'models' });
        send(page, 'subscribe', { topic: 'models', offset: 'x', limit: -1, app: 5 });
        await settle();

        expect(sentTo(page).map(s => s.command)).toEqual([ 'models' ]);
        expect(sentTo(page)[0]!.payload).toMatchObject({ query: { app: '', offset: 0, limit: 1 } });
    });

    it('ignores a page\'s requests past ADMIN_REQUEST_LIMIT', async () => {
        const page = socketio.connect('page');
        for (let i = 0; i < ADMIN_REQUEST_LIMIT.burst + 10; i++) send(page, 'request', { topic: 'server', request: i });
        await settle();
        expect(sentTo(page)).toHaveLength(ADMIN_REQUEST_LIMIT.burst);

        await vi.advanceTimersByTimeAsync(1000);
        send(page, 'request', { topic: 'server' });
        await settle();
        expect(sentTo(page)).toHaveLength(ADMIN_REQUEST_LIMIT.burst + 1);
    });

    it('changes nothing it reads', async () => {
        store.tombstoneMillis = 1000;
        store.removeModel('app', 'cubes', 'gone');
        await vi.advanceTimersByTimeAsync(2000);
        const before = JSON.stringify([ store.getAll('app', 'cubes'), store.tombstoneCount('app') ]);

        const page = socketio.connect('page');
        for (const topic of [ 'server', 'clients', 'models', 'model' ]) {
            send(page, 'subscribe', { topic, app: 'app', channel: 'cubes', id: 'gone' });
        }
        await vi.advanceTimersByTimeAsync(3 * ADMIN_REFRESH_MILLIS);

        expect(JSON.stringify([ store.getAll('app', 'cubes'), store.tombstoneCount('app') ])).toBe(before);
        expect(sentTo(page).find(s => s.command === 'model')!.payload).toMatchObject({ found: false });
        expect(sentTo(page).find(s => s.command === 'model')!.payload).not.toHaveProperty('deletedAt');
    });

    it('keeps payloads bounded however large the store is', async () => {
        for (let i = 0; i < 5000; i++) store.updateModel('app', `channel-${i % 50}`, { id: `model-${i}`, value: 'v'.repeat(100) });
        const page = socketio.connect('page');
        send(page, 'request', { topic: 'models', limit: 1e6 });
        await settle();

        const payload = sentTo(page)[0]!.payload;
        expect(payload.total).toBe(5001);
        expect(JSON.stringify(payload).length).toBeLessThan(64 * 1024);
    });
});
