import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { config, Subject } from 'rxjs';
import { WebLog } from '../../src/server/modules/web/web-log.js';
import { SocketIoClient, SocketIOServer } from '../../src/server/modules/networking/socket-io-server.js';
import { NetworkMessage } from '../../src/server/modules/command-hooks/connection-pool.js';
import { Payload, Service } from '../../src/server/modules/core/index.js';

class FakeSocketIOServer {
    public messagesSource = new Subject<NetworkMessage>();
    public clients: SocketIoClient[] = [];
    public broadcasts: { message: NetworkMessage; clients: ReadonlyArray<SocketIoClient> }[] = [];

    public get messages$() {
        return this.messagesSource.asObservable();
    }

    public get currentClients(): ReadonlyArray<SocketIoClient> {
        return this.clients;
    }

    public getClient(id: string): SocketIoClient | undefined {
        return this.clients.find(c => c.id === id);
    }

    public broadcast(message: NetworkMessage, clients: ReadonlyArray<SocketIoClient>): void {
        this.broadcasts.push({ message, clients });
    }

    /** The live log lines sent, without the histories that answer requestLog. */
    public get live() {
        return this.broadcasts.filter(b => b.message.command === 'message');
    }

    public get histories() {
        return this.broadcasts
            .filter(b => b.message.command === 'history')
            .map(b => b.message.payload!.asValue<{ request: number | null; at: number; messages: { message: string; created: number; first: number; count: number }[] }>());
    }

    public connectClient(client: SocketIoClient): void {
        this.clients.push(client);
    }
}

const makeClient = function (id: string, app: string): SocketIoClient {
    return { id, app, name: id, version: '1', metadata: {}, socket: {} as never, tlsAtProxy: false };
};

const requestLog = function (server: FakeSocketIOServer, origin: SocketIoClient, body: unknown): void {
    server.messagesSource.next({
        channel: 'colibri::log',
        command: 'requestLog',
        origin,
        payload: Payload.fromValue(body)
    });
};

class Emitter extends Service {
    public get serviceName(): string { return 'Emitter'; }
    public get groupName(): string { return 'test'; }

    public emitDebug(msg: string, metadata: Record<string, string | number | boolean> = {}): void {
        this.logDebug(msg, metadata);
    }

    public emitError(msg: string, metadata: Record<string, string | number | boolean> = {}): void {
        this.logError(msg, false, metadata);
    }

    public emitWarning(msg: string, metadata: Record<string, string | number | boolean> = {}): void {
        this.logWarning(msg, metadata);
    }

    public emitInfo(msg: string, metadata: Record<string, string | number | boolean> = {}): void {
        this.logInfo(msg, metadata);
    }
}

describe('WebLog', () => {
    it('by default shows all levels but hides broadcast-tagged messages', async () => {
        const server = new FakeSocketIOServer();
        const webLog = new WebLog(server as unknown as SocketIOServer);
        await webLog.init();

        const admin = makeClient('admin1', 'colibri');
        server.connectClient(admin);

        const emitter = new Emitter();
        emitter.emitError('err');
        emitter.emitWarning('warn');
        emitter.emitInfo('info');
        emitter.emitDebug('debug');
        emitter.emitDebug('sync', { broadcastTraffic: true });

        expect(server.broadcasts).toHaveLength(4);
        expect(server.broadcasts.map(b => (b.message.payload!.asValue<{ message: string }>()).message))
            .toEqual(['err', 'warn', 'info', 'debug']);
    });

    it('honors a level filter set via requestLog, without broadcasting suppressed levels at all', async () => {
        const server = new FakeSocketIOServer();
        const webLog = new WebLog(server as unknown as SocketIOServer);
        await webLog.init();

        const admin = makeClient('admin1', 'colibri');
        server.connectClient(admin);
        requestLog(server, admin, { levels: [ 0 ] });

        const emitter = new Emitter();
        emitter.emitError('err');
        emitter.emitWarning('warn');
        emitter.emitInfo('info');
        emitter.emitDebug('debug');

        expect(server.live).toHaveLength(1);
        expect(server.live[0]!.message.payload!.asValue<{ message: string }>().message).toBe('err');
    });

    it('the sync-traffic switch overrides the level gate for broadcast-tagged messages (carve-out semantics)', async () => {
        const server = new FakeSocketIOServer();
        const webLog = new WebLog(server as unknown as SocketIOServer);
        await webLog.init();

        const admin = makeClient('admin1', 'colibri');
        server.connectClient(admin);

        // Debug selected, sync traffic explicitly hidden: broadcast-tagged Debug is hidden,
        // non-broadcast Debug still shows.
        requestLog(server, admin, { levels: [ 3 ], showBroadcastTraffic: false });

        const emitter = new Emitter();
        emitter.emitDebug('plain-debug');
        emitter.emitDebug('sync-tick', { broadcastTraffic: true });

        expect(server.live).toHaveLength(1);
        expect(server.live[0]!.message.payload!.asValue<{ message: string }>().message).toBe('plain-debug');

        // Debug NOT selected, sync traffic explicitly shown: broadcast-tagged message still
        // shows even though its level (Debug) is unchecked.
        requestLog(server, admin, { levels: [ 0 ], showBroadcastTraffic: true });
        // requestLog also replays matching history (here, the buffered 'sync-tick' now
        // matches the new prefs) - discard that one-off broadcast to isolate live delivery.
        server.broadcasts.length = 0;

        emitter.emitDebug('plain-debug-2');
        emitter.emitDebug('sync-tick-2', { broadcastTraffic: true });

        expect(server.live).toHaveLength(1);
        expect(server.live[0]!.message.payload!.asValue<{ message: string }>().message).toBe('sync-tick-2');
    });

    it('gives two clients with different preferences only their own wanted subset', async () => {
        const server = new FakeSocketIOServer();
        const webLog = new WebLog(server as unknown as SocketIOServer);
        await webLog.init();

        const debugAndSyncClient = makeClient('a', 'colibri');
        const errorOnlyClient = makeClient('b', 'colibri');
        server.connectClient(debugAndSyncClient);
        server.connectClient(errorOnlyClient);

        requestLog(server, debugAndSyncClient, { levels: [ 0, 1, 2, 3 ], showBroadcastTraffic: true });
        requestLog(server, errorOnlyClient, { levels: [ 0 ], showBroadcastTraffic: false });

        const emitter = new Emitter();
        emitter.emitError('err');
        emitter.emitDebug('sync', { broadcastTraffic: true });

        const recipientsFor = (message: string) =>
            server.live.find(b => b.message.payload!.asValue<{ message: string }>().message === message)
                ?.clients.map(c => c.id);

        expect(recipientsFor('err')).toEqual([ 'a', 'b' ]);
        expect(recipientsFor('sync')).toEqual([ 'a' ]);
    });

    it('replays history through requestLog honoring the requested preferences', async () => {
        const server = new FakeSocketIOServer();
        const webLog = new WebLog(server as unknown as SocketIOServer);
        await webLog.init();

        const emitter = new Emitter();
        emitter.emitError('err');
        emitter.emitDebug('debug');
        emitter.emitDebug('sync', { broadcastTraffic: true });

        const admin = makeClient('admin1', 'colibri');
        server.connectClient(admin);
        server.broadcasts.length = 0;

        // one history message with the matching entries, each in the same shape as a live line
        requestLog(server, admin, { levels: [ 0 ], showBroadcastTraffic: false, request: 7 });

        expect(server.broadcasts).toHaveLength(1);
        expect(server.broadcasts[0]!.clients).toEqual([ admin ]);
        expect(server.histories).toHaveLength(1);
        expect(server.histories[0]!.request).toBe(7);
        expect(server.histories[0]!.messages.map(m => m.message)).toEqual([ 'err' ]);
    });

    // The Connections switch: routine connect and disconnect lines, tagged by whoever logs them.
    it('hides connection lines live and in the history once asked to, and shows them by default', async () => {
        const server = new FakeSocketIOServer();
        const webLog = new WebLog(server as unknown as SocketIOServer);
        await webLog.init();

        const emitter = new Emitter();
        emitter.emitDebug('client connected', { connection: true, clientApp: 'appA' });
        emitter.emitWarning('client gone quiet', { clientApp: 'appA' });

        const quiet = makeClient('quiet', 'colibri');
        const all = makeClient('all', 'colibri');
        server.connectClient(quiet);
        server.connectClient(all);
        requestLog(server, quiet, { showConnections: false, request: 1 });
        requestLog(server, all, { request: 2 });

        expect(server.histories.find(h => h.request === 1)!.messages.map(m => m.message)).toEqual([ 'client gone quiet' ]);
        expect(server.histories.find(h => h.request === 2)!.messages.map(m => m.message)).toEqual([ 'client connected', 'client gone quiet' ]);

        server.broadcasts.length = 0;
        emitter.emitDebug('client disconnected', { connection: true });
        emitter.emitInfo('something else');
        expect(server.live.map(b => [ b.message.payload!.asValue<{ message: string }>().message, b.clients.map(c => c.id) ])).toEqual([
            [ 'client disconnected', [ 'all' ] ],
            [ 'something else', [ 'quiet', 'all' ] ],
        ]);
    });

    it('still applies the level filter to connection lines it shows', async () => {
        const server = new FakeSocketIOServer();
        const webLog = new WebLog(server as unknown as SocketIOServer);
        await webLog.init();
        const admin = makeClient('admin1', 'colibri');
        server.connectClient(admin);
        requestLog(server, admin, { levels: [ 0, 1, 2 ], showConnections: true });

        new Emitter().emitDebug('client connected', { connection: true });
        expect(server.live).toEqual([]);
    });

    it('answers requestLog with a history even when nothing matches, echoing a numeric request only', async () => {
        vi.useFakeTimers({ toFake: [ 'Date' ] });
        try {
            vi.setSystemTime(1_700_000_000_000);
            const server = new FakeSocketIOServer();
            const webLog = new WebLog(server as unknown as SocketIOServer);
            await webLog.init();

            const admin = makeClient('admin1', 'colibri');
            server.connectClient(admin);

            requestLog(server, admin, { filter: 'no-such-app', request: 3 });
            requestLog(server, admin, { filter: 'no-such-app', request: '4' });
            requestLog(server, admin, { filter: 'no-such-app' });

            // with the server's time, by which the lines are stamped
            expect(server.histories).toEqual([
                { request: 3, at: 1_700_000_000_000, messages: [] },
                { request: null, at: 1_700_000_000_000, messages: [] },
                { request: null, at: 1_700_000_000_000, messages: [] }
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('sends the history in the order the lines last occurred, so a merged entry sits at its latest repeat', async () => {
        vi.useFakeTimers({ toFake: [ 'Date' ] });
        try {
            const server = new FakeSocketIOServer();
            const webLog = new WebLog(server as unknown as SocketIOServer);
            await webLog.init();

            const emitter = new Emitter();
            vi.setSystemTime(1000);
            emitter.emitInfo('repeated');
            vi.setSystemTime(2000);
            emitter.emitInfo('once');
            vi.setSystemTime(3000);
            emitter.emitInfo('repeated');

            const admin = makeClient('admin1', 'colibri');
            server.connectClient(admin);
            requestLog(server, admin, {});

            expect(server.histories[0]!.messages.map(m => [ m.message, m.first, m.created, m.count ])).toEqual([
                [ 'once', 2000, 2000, 0 ],
                [ 'repeated', 1000, 3000, 1 ]
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('merges a repeated message into one entry with an incrementing count, even with unrelated traffic interleaved', async () => {
        const server = new FakeSocketIOServer();
        const webLog = new WebLog(server as unknown as SocketIOServer);
        await webLog.init();

        const admin = makeClient('admin1', 'colibri');
        server.connectClient(admin);

        const emitter = new Emitter();
        emitter.emitDebug('tick');
        // unrelated traffic between repeats - a positional lookback would lose the match here
        for (let i = 0; i < 10; i++) {
            emitter.emitDebug(`unrelated-${i}`);
        }
        emitter.emitDebug('tick');
        emitter.emitDebug('tick');

        const ticks = server.broadcasts
            .map(b => b.message.payload!.asValue<{ message: string; count: number }>())
            .filter(m => m.message === 'tick');

        expect(ticks).toHaveLength(3);
        expect(ticks.map(t => t.count)).toEqual([ 0, 1, 2 ]);
        // all three broadcasts refer to the same log entry id
        const ids = server.broadcasts
            .map(b => b.message.payload!.asValue<{ message: string; id: string }>())
            .filter(m => m.message === 'tick')
            .map(m => m.id);
        expect(new Set(ids).size).toBe(1);
    });

    it('keeps the time of the first occurrence in a merged entry, and moves created to the latest', async () => {
        vi.useFakeTimers({ toFake: [ 'Date' ] });
        try {
            const server = new FakeSocketIOServer();
            const webLog = new WebLog(server as unknown as SocketIOServer);
            await webLog.init();

            const admin = makeClient('admin1', 'colibri');
            server.connectClient(admin);

            const emitter = new Emitter();
            vi.setSystemTime(1000);
            emitter.emitDebug('tick');
            vi.setSystemTime(2000);
            emitter.emitDebug('tick');
            vi.setSystemTime(3000);
            emitter.emitDebug('tick');

            expect(server.broadcasts.map(b => b.message.payload!.asValue<{ first: number; created: number }>())
                .map(m => [ m.first, m.created ])).toEqual([ [ 1000, 1000 ], [ 1000, 2000 ], [ 1000, 3000 ] ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not merge the same line from two apps', async () => {
        const server = new FakeSocketIOServer();
        const webLog = new WebLog(server as unknown as SocketIOServer);
        await webLog.init();

        const admin = makeClient('admin1', 'colibri');
        server.connectClient(admin);

        const emitter = new Emitter();
        emitter.emitInfo('[127.0.0.1] ready', { clientApp: 'app-a' });
        emitter.emitInfo('[127.0.0.1] ready', { clientApp: 'app-b' });
        emitter.emitInfo('[127.0.0.1] ready', { clientApp: 'app-a' });

        const sent = server.broadcasts
            .map(b => b.message.payload!.asValue<{ id: string; count: number; metadata: { clientApp: string } }>());
        expect(sent.map(m => [ m.metadata.clientApp, m.count ])).toEqual([ [ 'app-a', 0 ], [ 'app-b', 0 ], [ 'app-a', 1 ] ]);
        expect(sent[2]!.id).toBe(sent[0]!.id);
        expect(sent[1]!.id).not.toBe(sent[0]!.id);
    });

    it('does not merge the same line about two clients of one app', async () => {
        const server = new FakeSocketIOServer();
        const webLog = new WebLog(server as unknown as SocketIOServer);
        await webLog.init();

        const admin = makeClient('admin1', 'colibri');
        server.connectClient(admin);

        const emitter = new Emitter();
        emitter.emitDebug('Colibri client 127.0.0.1 disconnected', { clientApp: 'app-a', clientName: 'ud-0', clientId: 'id-0' });
        emitter.emitDebug('Colibri client 127.0.0.1 disconnected', { clientApp: 'app-a', clientName: 'ud-1', clientId: 'id-1' });
        emitter.emitDebug('Colibri client 127.0.0.1 disconnected', { clientApp: 'app-a', clientName: 'ud-0', clientId: 'id-0' });

        const sent = server.broadcasts
            .map(b => b.message.payload!.asValue<{ id: string; count: number; metadata: { clientName: string } }>());
        expect(sent.map(m => [ m.metadata.clientName, m.count ])).toEqual([ [ 'ud-0', 0 ], [ 'ud-1', 0 ], [ 'ud-0', 1 ] ]);
        expect(sent[2]!.id).toBe(sent[0]!.id);
        expect(sent[1]!.id).not.toBe(sent[0]!.id);
    });

    it('does not merge into a message that has since been evicted from history', async () => {
        const server = new FakeSocketIOServer();
        const webLog = new WebLog(server as unknown as SocketIOServer);
        await webLog.init();

        const admin = makeClient('admin1', 'colibri');
        server.connectClient(admin);

        const emitter = new Emitter();
        emitter.emitDebug('tick');

        // Reach into the private ring buffer capacity via repeated unrelated messages to force
        // the 'tick' entry out of history (MAX_LOG_SIZE = 20000).
        for (let i = 0; i < 20000; i++) {
            emitter.emitDebug(`filler-${i}`);
        }
        server.broadcasts.length = 0;

        emitter.emitDebug('tick');

        const ticks = server.broadcasts
            .map(b => b.message.payload!.asValue<{ message: string; count: number }>())
            .filter(m => m.message === 'tick');

        expect(ticks).toHaveLength(1);
        expect(ticks[0]!.count).toBe(0);
    });

    // The merge index used to keep every key ever logged, each pinning its message after the
    // history had evicted it: 100k distinct lines left 100k entries behind 20k of history.
    it('keeps its merge index bounded by the history, and merging still works after evictions', async () => {
        const server = new FakeSocketIOServer();
        const webLog = new WebLog(server as unknown as SocketIOServer);
        await webLog.init();
        const internals = webLog as unknown as {
            recentByKey: Map<string, unknown>;
            logMessages: { length: number; toArray(): unknown[] };
        };

        const emitter = new Emitter();
        emitter.emitDebug('tick');
        for (let i = 0; i < 30000; i++) {
            emitter.emitDebug(`unique-${i}`);
        }

        expect(internals.logMessages.length).toBe(20000);
        expect(internals.recentByKey.size).toBeLessThanOrEqual(20000);
        // nothing evicted is still reachable through the index
        const inHistory = new Set(internals.logMessages.toArray());
        expect([ ...internals.recentByKey.values() ].every(msg => inHistory.has(msg))).toBe(true);

        const admin = makeClient('admin1', 'colibri');
        server.connectClient(admin);
        emitter.emitDebug('unique-29999'); // still in history: merged
        emitter.emitDebug('tick'); // evicted long ago: a new entry

        expect(server.broadcasts.map(b => b.message.payload!.asValue<{ message: string; count: number }>())
            .map(m => [ m.message, m.count ])).toEqual([ [ 'unique-29999', 1 ], [ 'tick', 0 ] ]);
        expect(internals.recentByKey.size).toBeLessThanOrEqual(20000);
    });

    it('does not throw on a missing or empty requestLog payload, and defaults to all levels / hidden broadcast', async () => {
        const server = new FakeSocketIOServer();
        const webLog = new WebLog(server as unknown as SocketIOServer);
        await webLog.init();

        const admin = makeClient('admin1', 'colibri');
        server.connectClient(admin);

        expect(() => {
            server.messagesSource.next({ channel: 'colibri::log', command: 'requestLog', origin: admin, payload: undefined });
        }).not.toThrow();

        const emitter = new Emitter();
        emitter.emitDebug('debug');
        emitter.emitDebug('sync', { broadcastTraffic: true });

        expect(server.live.map(b => b.message.payload!.asValue<{ message: string }>().message)).toEqual(['debug']);
    });

    // requestLog is accepted from any client of any app, so its payload can be anything.
    describe('with a malformed requestLog payload', () => {
        // RxJS rethrows a subscriber's exception asynchronously - in the real server that is
        // an uncaught exception, and fatal - so it is collected here instead of expected to
        // throw from next().
        let unhandled: unknown[];

        beforeEach(() => {
            unhandled = [];
            config.onUnhandledError = (err) => unhandled.push(err);
        });

        afterEach(() => {
            config.onUnhandledError = null;
        });

        const settle = () => new Promise(resolve => setTimeout(resolve, 0));

        const setUp = async () => {
            const server = new FakeSocketIOServer();
            const webLog = new WebLog(server as unknown as SocketIOServer);
            await webLog.init();

            const admin = makeClient('admin1', 'colibri');
            server.connectClient(admin);
            return { server, admin };
        };

        const delivered = function (server: FakeSocketIOServer): string[] {
            return server.live.map(b => b.message.payload!.asValue<{ message: string }>().message);
        };

        it.each([
            [ 'levels: 1', { levels: 1 } ],
            [ 'levels: \'x\'', { levels: 'x' } ],
            [ 'levels: {}', { levels: {} } ],
            [ 'filter: 5', { filter: 5 } ],
            [ 'filter: {}', { filter: {} } ],
            [ 'showBroadcastTraffic: \'yes\'', { showBroadcastTraffic: 'yes' } ],
            [ 'a null payload', null ],
            [ 'a number payload', 5 ],
            [ 'a string payload', 'levels' ],
            [ 'an array payload', [ 0 ] ],
        ])('ignores %s, survives, and keeps the defaults', async (_, body) => {
            const { server, admin } = await setUp();

            requestLog(server, admin, body);
            await settle();
            expect(unhandled).toEqual([]);

            const emitter = new Emitter();
            emitter.emitError('err');
            emitter.emitDebug('debug');
            emitter.emitDebug('sync', { broadcastTraffic: true });

            // all levels, no filter, broadcast traffic hidden
            expect(delivered(server)).toEqual([ 'err', 'debug' ]);
        });

        it('keeps only the known levels out of a mixed array', async () => {
            const { server, admin } = await setUp();

            requestLog(server, admin, { levels: [ 0, 'x', 7, null, 1.5, '3' ] });
            await settle();
            expect(unhandled).toEqual([]);

            const emitter = new Emitter();
            emitter.emitError('err');
            emitter.emitWarning('warn');
            emitter.emitDebug('debug');

            expect(delivered(server)).toEqual([ 'err' ]);
        });

        it('survives a payload that is not JSON at all', async () => {
            const { server, admin } = await setUp();

            server.messagesSource.next({
                channel: 'colibri::log',
                command: 'requestLog',
                origin: admin,
                payload: Payload.fromString('{not json')
            });
            await settle();
            expect(unhandled).toEqual([]);

            const emitter = new Emitter();
            emitter.emitInfo('still alive');
            expect(delivered(server)).toContain('still alive');
        });
    });
});
