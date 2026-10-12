import { describe, it, expect } from 'vitest';
import { Subject } from 'rxjs';
import { ConnectionPool, NetworkClient, NetworkMessage, NetworkServer } from '../../src/server/modules/command-hooks/connection-pool.js';
import { Broadcaster } from '../../src/server/modules/command-hooks/broadcaster.js';
import { BroadcastLogger } from '../../src/server/modules/command-hooks/broadcast-logger.js';
import { Service } from '../../src/server/modules/core/service.js';
import { LogMessage } from '../../src/server/modules/core/log-message.js';

class FakeServer implements NetworkServer {
    public clientConnectedSource = new Subject<NetworkClient>();
    public clientDisconnectedSource = new Subject<NetworkClient>();
    public messagesSource = new Subject<NetworkMessage>();
    public clients: NetworkClient[] = [];
    public broadcasts: { message: NetworkMessage; clients: ReadonlyArray<NetworkClient> }[] = [];

    public get currentClients(): ReadonlyArray<NetworkClient> {
        return this.clients;
    }
    public get clientConnected$() {
        return this.clientConnectedSource.asObservable();
    }
    public get clientDisconnected$() {
        return this.clientDisconnectedSource.asObservable();
    }
    public get messages$() {
        return this.messagesSource.asObservable();
    }

    public broadcast(message: NetworkMessage, clients: ReadonlyArray<NetworkClient>): void {
        this.broadcasts.push({ message, clients });
    }

    public connectClient(client: NetworkClient): void {
        this.clients.push(client);
        this.clientConnectedSource.next(client);
    }
}

const makeClient = function (id: string, app: string): NetworkClient {
    return { id, app, name: id, version: '1', metadata: {} };
};

// Captures every LogMessage published while subscribed, isolated per test since
// Service.output$ is a shared static bus across the whole process.
const captureLogs = function (): LogMessage[] {
    const captured: LogMessage[] = [];
    Service.output$.subscribe(msg => captured.push(msg));
    return captured;
};

describe('BroadcastLogger', () => {
    it('does not interfere with Broadcaster relaying the same message', () => {
        const server = new FakeServer();
        const pool = new ConnectionPool(server);
        new Broadcaster(pool);
        new BroadcastLogger(pool);

        const clientA = makeClient('a1', 'appA');
        const clientB = makeClient('a2', 'appA');
        server.connectClient(clientA);
        server.connectClient(clientB);

        const message: NetworkMessage = { channel: 'position', command: 'broadcast::bool', origin: clientA };
        server.messagesSource.next(message);

        expect(server.broadcasts).toHaveLength(1);
        expect(server.broadcasts[0]!.clients.map(c => c.id)).toEqual(['a2']);
    });

    it('emits a debug log entry with client metadata when a broadcast message arrives', () => {
        const server = new FakeServer();
        const pool = new ConnectionPool(server);
        const captured = captureLogs();
        new BroadcastLogger(pool);

        const origin = makeClient('c1', 'sample-app');
        const message: NetworkMessage = { channel: 'position', command: 'broadcast::string', origin };
        server.messagesSource.next(message);

        expect(captured).toHaveLength(1);
        expect(captured[0]!.message).toBe('[c1] broadcast position (broadcast::string)');
        expect(captured[0]!.metadata).toEqual({
            clientApp: 'sample-app',
            clientName: 'c1',
            clientId: 'c1',
            channel: 'position',
            command: 'broadcast::string',
            broadcastTraffic: true,
        });
    });

    it('does not log anything when the hook is never constructed, but the relay still works', () => {
        const server = new FakeServer();
        const pool = new ConnectionPool(server);
        const captured = captureLogs();
        new Broadcaster(pool);

        const origin = makeClient('c1', 'sample-app');
        const other = makeClient('c2', 'sample-app');
        server.connectClient(origin);
        server.connectClient(other);
        server.messagesSource.next({ channel: 'position', command: 'broadcast::bool', origin });

        expect(captured).toHaveLength(0);
        expect(server.broadcasts).toHaveLength(1);
    });

    it('keeps the log text identical across messages with different payloads, for WebLog dedup', () => {
        const server = new FakeServer();
        const pool = new ConnectionPool(server);
        const captured = captureLogs();
        new BroadcastLogger(pool);

        const origin = makeClient('c1', 'sample-app');
        server.messagesSource.next({ channel: 'position', command: 'broadcast::json', origin, payload: { asString: () => '{"x":1}' } as never });
        server.messagesSource.next({ channel: 'position', command: 'broadcast::json', origin, payload: { asString: () => '{"x":2}' } as never });

        expect(captured).toHaveLength(2);
        expect(captured[0]!.message).toBe(captured[1]!.message);
    });

    it('ignores messages that are not broadcast traffic', () => {
        const server = new FakeServer();
        const pool = new ConnectionPool(server);
        const captured = captureLogs();
        new BroadcastLogger(pool);

        server.messagesSource.next({ channel: 'app::chan', command: 'model::update' });

        // Nothing from BroadcastLogger itself: the pool says that no hook handled the message.
        expect(captured.filter(l => l.origin === 'BroadcastLogger')).toHaveLength(0);
    });
});
