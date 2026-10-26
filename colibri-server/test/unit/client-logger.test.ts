import { describe, it, expect } from 'vitest';
import { Subject } from 'rxjs';
import { ConnectionPool } from '../../src/server/modules/hooks/connection-pool.js';
import type { NetworkClient, NetworkMessage, NetworkServer } from '../../src/server/modules/protocol/network.js';
import { ClientLogger, MAX_CLIENT_LOG_CHARS } from '../../src/server/modules/hooks/client-logger.js';
import { Service } from '../../src/server/modules/core/service.js';
import type { LogMessage } from '../../src/server/modules/core/log-message.js';
import { LogLevel } from '../../src/server/modules/core/log-message.js';
import { Payload } from '../../src/server/modules/protocol/payload.js';

class FakeServer implements NetworkServer {
    public clientConnectedSource = new Subject<NetworkClient>();
    public clientDisconnectedSource = new Subject<NetworkClient>();
    public messagesSource = new Subject<NetworkMessage>();
    public clients: NetworkClient[] = [];

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

    public broadcast(): void {
        // ClientLogger never relays, so nothing to record.
    }
}

const makeClient = function (id: string, app: string): NetworkClient {
    return { id, app, name: id, version: '2', metadata: {} };
};

// Captures every LogMessage published while subscribed, isolated per test since
// Service.output$ is a shared static bus across the whole process.
const captureLogs = function (): LogMessage[] {
    const captured: LogMessage[] = [];
    Service.output$.subscribe(msg => captured.push(msg));
    return captured;
};

const logOne = function (command: string, payload: Payload | undefined): LogMessage[] {
    const server = new FakeServer();
    const pool = new ConnectionPool(server);
    const captured = captureLogs();
    new ClientLogger(pool);

    server.messagesSource.next({ channel: 'log', command, payload, origin: makeClient('c1', 'sample-app') });
    return captured;
};

describe('ClientLogger', () => {
    // A web client sends a JS string, which reaches the server as Payload.fromValue('...').
    // Reading that with asString() is JSON.stringify, so every colibri-web log line used to
    // arrive in the admin UI wrapped in literal quotes.
    it('logs a Socket.IO string payload as text, without JSON quotes', () => {
        const captured = logOne('info', Payload.fromValue('hello world'));

        expect(captured).toHaveLength(1);
        expect(captured[0]!.message).toBe('[c1] hello world');
    });

    // RemoteLogger sends whatever the app logs; whole megabytes a line filled the server's heap.
    it('cuts a long line to MAX_CLIENT_LOG_CHARS and says how much is left out', () => {
        const captured = logOne('info', Payload.fromValue('x'.repeat(MAX_CLIENT_LOG_CHARS + 1000)));

        expect(captured[0]!.message).toBe(`[c1] ${'x'.repeat(MAX_CLIENT_LOG_CHARS)} [... 1000 more characters]`);
    });

    it('keeps the newlines in a stack trace instead of escaping them', () => {
        const captured = logOne('error', Payload.fromValue('boom\n    at somewhere.ts:1:1'));

        expect(captured[0]!.message).toBe('[c1] boom\n    at somewhere.ts:1:1');
        expect(captured[0]!.message).not.toContain('\\n');
    });

    // colibri-unity sends this channel as raw utf8 rather than JSON, precisely to avoid the
    // quoting above - that path has to keep working unchanged.
    it('logs raw text off the TCP wire verbatim', () => {
        const captured = logOne('info', Payload.fromBytes(Buffer.from('hello from unity', 'utf8')));

        expect(captured[0]!.message).toBe('[c1] hello from unity');
    });

    it('falls back to the serialized form for a payload that is not a string', () => {
        const captured = logOne('info', Payload.fromValue({ a: 1 }));

        expect(captured[0]!.message).toBe('[c1] {"a":1}');
    });

    it('logs an empty line rather than "undefined" for a message with no payload', () => {
        const captured = logOne('info', undefined);

        expect(captured[0]!.message).toBe('[c1] ');
    });

    it.each([
        ['info', LogLevel.Info],
        ['warn', LogLevel.Warn],
        ['warning', LogLevel.Warn],
        ['error', LogLevel.Error],
        ['debug', LogLevel.Debug],
        ['something-else', LogLevel.Debug],
    ] as const)('maps the "%s" command to its log level', (command, level) => {
        const captured = logOne(command, Payload.fromValue('text'));

        expect(captured[0]!.level).toBe(level);
        expect(captured[0]!.message).toBe('[c1] text');
    });

    it('tags every entry with the originating client', () => {
        const captured = logOne('info', Payload.fromValue('text'));

        expect(captured[0]!.metadata).toEqual({
            clientApp: 'sample-app',
            clientName: 'c1',
            clientId: 'c1',
        });
    });

    it('ignores messages on any other channel', () => {
        const server = new FakeServer();
        const pool = new ConnectionPool(server);
        const captured = captureLogs();
        new ClientLogger(pool);

        server.messagesSource.next({ channel: 'position', command: 'info', payload: Payload.fromValue('text') });

        // Nothing from ClientLogger itself: the pool says that no hook handled the message.
        expect(captured.filter(l => l.origin === 'ClientLogger')).toHaveLength(0);
    });
});
