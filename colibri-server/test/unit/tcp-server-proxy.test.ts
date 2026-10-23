import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Subject, config as rxjsConfig } from 'rxjs';
import type { TlsCredentials } from '../../src/server/modules/core/tls-files.js';
import { TCPServerProxy } from '../../src/server/modules/networking/tcp-server-proxy.js';
import { WorkerServiceProxy } from '../../src/server/modules/core/worker-service-proxy.js';
import type { WorkerMessage } from '../../src/server/modules/core/worker-message.js';
import { ConnectionPool } from '../../src/server/modules/command-hooks/connection-pool.js';
import type { NetworkClient } from '../../src/server/modules/networking/network.js';
import { DataStore } from '../../src/server/modules/command-hooks/data-store.js';
import { ModelSynchronization } from '../../src/server/modules/command-hooks/model-sync.js';
import { Payload } from '../../src/server/modules/core/payload.js';

// The proxy's only link to the worker thread is the message channel, so these tests stand in for
// the thread by pushing what TCPServerWorker would post. No thread is started: under vitest the
// worker module is a .ts file that a plain worker_threads.Worker cannot load anyway.
interface ProxyInternals {
    workerMessages: Subject<WorkerMessage>;
    inboundBacklog: Int32Array;
    onWorkerExited(): void;
}

describe('TCPServerProxy', () => {
    let proxy: TCPServerProxy;

    const fromWorker = function (channel: string, content: Record<string, unknown>): void {
        (proxy as unknown as ProxyInternals).workerMessages.next({ channel, content });
    };

    const handshake = function (id: string, app: string, name = id): void {
        fromWorker('clientConnected$', { id, app, name, version: '2' });
    };

    const modelUpdate = function (id: string, channel: string, model: Record<string, unknown>): void {
        fromWorker('clientMessage$', {
            channel,
            command: 'model::update',
            payload: Buffer.from(JSON.stringify(model), 'utf8'),
            origin: { id, app: '', name: '', version: '2', metadata: {} },
        });
    };

    beforeEach(() => {
        vi.spyOn(WorkerServiceProxy.prototype as unknown as { initWorker(): void }, 'initWorker').mockImplementation(() => undefined);
        proxy = new TCPServerProxy();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // The worker moves a re-handshaking client to its new app, but the proxy used to add the new
    // app without removing the old one: the old app kept the id in its index forever.
    describe('a client that handshakes again', () => {
        it('is reported as leaving its old app before joining the new one', () => {
            const events: string[] = [];
            proxy.clientConnected$.subscribe(c => events.push(`connected ${c.app}`));
            proxy.clientDisconnected$.subscribe(c => events.push(`disconnected ${c.app}`));

            handshake('c1', 'appA');
            handshake('c1', 'appB');

            expect(events).toEqual(['connected appA', 'disconnected appA', 'connected appB']);
            expect(proxy.currentClients.map(c => `${c.id} ${c.app}`)).toEqual(['c1 appB']);
            expect(proxy.hasRecipients('appA')).toBe(false);
            expect(proxy.hasRecipients('appB')).toBe(true);
        });

        it('is gone from both apps once it disconnects', () => {
            handshake('c1', 'appA');
            handshake('c1', 'appB');
            fromWorker('clientDisconnected$', { id: 'c1' });

            expect(proxy.currentClients).toEqual([]);
            expect(proxy.hasRecipients('appA')).toBe(false);
            expect(proxy.hasRecipients('appB')).toBe(false);
        });
    });

    // End to end through the hooks that care: the old app's synchronized models must be dropped
    // exactly as if the client had disconnected, and only then.
    describe('re-handshake and the model store', () => {
        let store: DataStore;

        beforeEach(() => {
            store = new DataStore();
            const pool = new ConnectionPool(proxy);
            new ModelSynchronization(pool, store);
        });

        it('clears the old app\'s store when the client was its last', () => {
            handshake('c1', 'appA');
            modelUpdate('c1', 'objects', { id: 'm1', x: 1 });
            expect(store.getAll('appA', 'objects')).toHaveLength(1);

            handshake('c1', 'appB');

            expect(store.getAll('appA', 'objects')).toEqual([]);
        });

        it('keeps the old app\'s store while another of its clients is still connected', () => {
            handshake('c1', 'appA');
            handshake('c2', 'appA');
            modelUpdate('c1', 'objects', { id: 'm1', x: 1 });

            handshake('c1', 'appB');

            expect(store.getAll('appA', 'objects')).toHaveLength(1);
        });

        // Leaving and rejoining the same app in one step must not look like the app emptying.
        it('keeps the store when the client handshakes into the same app again', () => {
            handshake('c1', 'appA', 'first-name');
            modelUpdate('c1', 'objects', { id: 'm1', x: 1 });

            handshake('c1', 'appA', 'second-name');

            expect(store.getAll('appA', 'objects')).toHaveLength(1);
            expect(proxy.currentClients.map((c: NetworkClient) => c.name)).toEqual(['second-name']);
        });
    });

    // Every broadcast is structured-cloned into the worker, which copies a payload's whole backing
    // ArrayBuffer. A payload encoded from a string (anything web-origin or built by the server) is
    // a view into the 64 KiB Buffer pool, and used to cross as 64 KiB.
    describe('payloads sent to the worker', () => {
        let sent: { channel: string; content: Record<string, unknown> }[];

        beforeEach(() => {
            sent = [];
            vi.spyOn(WorkerServiceProxy.prototype as unknown as { postMessage(channel: string, content?: Record<string, unknown>): void }, 'postMessage')
                .mockImplementation((channel, content) => {
                    sent.push({ channel, content: content ?? {} });
                });
            handshake('c1', 'appA');
        });

        const sentPayload = function (): Buffer {
            const msg = sent.at(-1)?.content.msg as { payload: Buffer } | undefined;
            if (!msg) throw new Error('nothing was sent to the worker');
            return msg.payload;
        };

        it('own exactly their bytes when broadcast to an app', () => {
            proxy.broadcastToApp({ channel: 'objects', command: 'model::update', payload: Payload.fromValue({ id: 'm1', x: 1 }) }, 'appA');

            const payload = sentPayload();
            expect(payload.toString()).toBe('{"id":"m1","x":1}');
            expect(payload.buffer.byteLength).toBe(payload.length);
        });

        it('own exactly their bytes when sent to one client', () => {
            proxy.broadcast({ channel: 'objects', command: 'model::update', payload: Payload.fromString('{"id":"m1"}') }, proxy.currentClients);

            const payload = sentPayload();
            expect(payload.toString()).toBe('{"id":"m1"}');
            expect(payload.buffer.byteLength).toBe(payload.length);
        });

        it('are passed through without a copy when they already own their bytes', () => {
            const bytes = Buffer.allocUnsafeSlow(11);
            bytes.write('{"id":"m1"}');

            proxy.broadcastToApp({ channel: 'objects', command: 'model::update', payload: Payload.fromBytes(bytes) }, 'appA');

            expect(sentPayload()).toBe(bytes);
        });
    });

    // The worker drops relayed traffic for a client too far behind, but must not drop an answer
    // to the client's own request: nothing would ever send that again.
    describe('answers to a client\'s own request', () => {
        let sent: { channel: string; content: Record<string, unknown> }[];

        beforeEach(() => {
            sent = [];
            vi.spyOn(WorkerServiceProxy.prototype as unknown as { postMessage(channel: string, content?: Record<string, unknown>): void }, 'postMessage')
                .mockImplementation((channel, content) => {
                    sent.push({ channel, content: content ?? {} });
                });
            new ModelSynchronization(new ConnectionPool(proxy), new DataStore());
            handshake('joiner', 'appA');
            handshake('owner', 'appA');
        });

        const request = function (payload: Record<string, unknown>): void {
            fromWorker('clientMessage$', {
                channel: 'objects',
                command: 'model::request',
                payload: Buffer.from(JSON.stringify(payload), 'utf8'),
                origin: { id: 'joiner', app: 'appA', name: 'joiner', version: '2', metadata: {} },
            });
        };

        const posts = () => sent.filter(m => m.channel === 'm:broadcast' || m.channel === 'm:broadcastToApp')
            .map(m => `${m.channel} ${(m.content.msg as { command: string }).command} reply=${m.content.reply}`);

        it('are marked as replies for the worker, relayed traffic is not', () => {
            modelUpdate('owner', 'objects', { id: 'm1', x: 1 });
            modelUpdate('owner', 'objects', { id: 'm2', x: 1 });
            fromWorker('clientMessage$', {
                channel: 'objects',
                command: 'model::delete',
                payload: Buffer.from('{"id":"gone"}', 'utf8'),
                origin: { id: 'owner', app: 'appA', name: 'owner', version: '2', metadata: {} },
            });
            sent.length = 0;

            request({});
            request({ id: 'unknown' });
            request({ id: 'gone', again: true });
            modelUpdate('owner', 'objects', { id: 'm1', x: 2 });

            expect(posts()).toEqual([
                'm:broadcast model::update reply=true',
                'm:broadcast model::update reply=true',
                'm:broadcast model::update reply=true',
                'm:broadcast model::delete reply=true',
                'm:broadcastToApp model::update reply=undefined',
            ]);
        });

        it('are relayed traffic unless said otherwise', () => {
            proxy.broadcast({ channel: 'objects', command: 'model::update', payload: Payload.fromString('{"id":"m1"}') }, proxy.currentClients);

            expect(posts()).toEqual(['m:broadcast model::update reply=false']);
        });
    });

    // The worker counts every message it posts here; this side has to count each one back down
    // once it is dispatched, or the worker would think the main thread is further behind than it
    // is - and, past the limit, drop updates for good.
    describe('the inbound backlog', () => {
        let sent: { channel: string; content: Record<string, unknown> }[];
        const internals = () => proxy as unknown as ProxyInternals;

        beforeEach(() => {
            sent = [];
            vi.spyOn(WorkerServiceProxy.prototype as unknown as { postMessage(channel: string, content?: Record<string, unknown>): void }, 'postMessage')
                .mockImplementation((channel, content) => {
                    sent.push({ channel, content: content ?? {} });
                });
        });

        const startMessages = () => sent.filter(m => m.channel === 'm:start');

        it('shares its counter and the limit with the worker in the start message', () => {
            proxy.start(9212, '0.0.0.0', { inboundBacklogLimit: 1234 });

            const [start] = startMessages();
            expect(start?.content).toMatchObject({ port: 9212, host: '0.0.0.0', options: { inboundBacklogLimit: 1234 } });
            const counter = (start?.content.options as { inboundBacklog: Int32Array }).inboundBacklog;
            expect(counter).toBe(internals().inboundBacklog);
            expect(counter.buffer).toBeInstanceOf(SharedArrayBuffer);
        });

        it('counts a message back down once it has been dispatched', () => {
            handshake('c1', 'appA');
            Atomics.store(internals().inboundBacklog, 0, 3);
            let pendingWhileHandling = -1;
            proxy.messages$.subscribe(() => {
                pendingWhileHandling = Atomics.load(internals().inboundBacklog, 0);
            });

            modelUpdate('c1', 'objects', { id: 'm1' });

            expect(pendingWhileHandling).toBe(3);
            expect(Atomics.load(internals().inboundBacklog, 0)).toBe(2);
        });

        it('counts a message back down even when handling it threw', async () => {
            const unhandled: unknown[] = [];
            const original = rxjsConfig.onUnhandledError;
            rxjsConfig.onUnhandledError = err => unhandled.push(err);
            try {
                handshake('c1', 'appA');
                Atomics.store(internals().inboundBacklog, 0, 1);

                // No payload at all: turning it into a Payload throws.
                fromWorker('clientMessage$', { channel: 'objects', command: 'model::update', origin: { id: 'c1' } });

                expect(Atomics.load(internals().inboundBacklog, 0)).toBe(0);
                // RxJS reports the subscriber's error on a later timer tick.
                await new Promise(resolve => setTimeout(resolve, 0));
                expect(unhandled).toHaveLength(1);
            } finally {
                rxjsConfig.onUnhandledError = original;
            }
        });

        it('starts a restarted worker from zero, with the same counter and settings', () => {
            vi.useFakeTimers();
            try {
                vi.spyOn(WorkerServiceProxy.prototype as unknown as { restartWorker(): boolean }, 'restartWorker').mockReturnValue(true);
                proxy.start(9212, '0.0.0.0', { inboundBacklogLimit: 77 });
                Atomics.store(internals().inboundBacklog, 0, 500);

                internals().onWorkerExited();
                expect(Atomics.load(internals().inboundBacklog, 0)).toBe(0);
                vi.advanceTimersByTime(1000);

                const [first, restarted] = startMessages();
                expect(restarted?.content).toEqual(first?.content);
                expect((restarted?.content.options as { inboundBacklog: Int32Array }).inboundBacklog).toBe(internals().inboundBacklog);
            } finally {
                vi.useRealTimers();
            }
        });
    });

    // The worker compiles its own trust function from the list, so it has to be sent the same list
    // the main thread trusts for X-Forwarded-For, restarted or not.
    describe('the trusted proxies and TCP_PROXY_PROTOCOL', () => {
        let sent: { channel: string; content: Record<string, unknown> }[];

        beforeEach(() => {
            sent = [];
            vi.spyOn(WorkerServiceProxy.prototype as unknown as { postMessage(channel: string, content?: Record<string, unknown>): void }, 'postMessage')
                .mockImplementation((channel, content) => {
                    sent.push({ channel, content: content ?? {} });
                });
        });

        const startOptions = () => sent.filter(m => m.channel === 'm:start').map(m => m.content.options);

        it('go to the worker with the start message, and to a restarted one again', () => {
            vi.useFakeTimers();
            try {
                vi.spyOn(WorkerServiceProxy.prototype as unknown as { restartWorker(): boolean }, 'restartWorker').mockReturnValue(true);
                proxy.start(9212, '0.0.0.0', { trustedProxies: ['loopback', '172.20.0.0/16'], proxyProtocol: true });

                (proxy as unknown as ProxyInternals).onWorkerExited();
                vi.advanceTimersByTime(1000);

                expect(startOptions()).toHaveLength(2);
                for (const options of startOptions()) {
                    expect(options).toMatchObject({ trustedProxies: ['loopback', '172.20.0.0/16'], proxyProtocol: true });
                }
            } finally {
                vi.useRealTimers();
            }
        });
    });

    // The worker serves TLS with whatever certificate it was last sent: the one in the start
    // message, then each renewed one. A restarted worker must start with the latest.
    describe('the TLS certificate', () => {
        let sent: { channel: string; content: Record<string, unknown> }[];
        const credentials = (name: string): TlsCredentials => ({ cert: Buffer.from(`${name} cert`), key: Buffer.from(`${name} key`) });

        beforeEach(() => {
            sent = [];
            vi.spyOn(WorkerServiceProxy.prototype as unknown as { postMessage(channel: string, content?: Record<string, unknown>): void }, 'postMessage')
                .mockImplementation((channel, content) => {
                    sent.push({ channel, content: content ?? {} });
                });
        });

        const startOptions = () => sent.filter(m => m.channel === 'm:start').map(m => m.content.options as { tls?: TlsCredentials });

        it('goes to the worker with the start message', () => {
            const current = credentials('first');
            proxy.start(9212, '0.0.0.0', { idleTimeoutMillis: 1 }, { credentials: current, changes$: new Subject<TlsCredentials>() });

            expect(startOptions()).toEqual([ expect.objectContaining({ idleTimeoutMillis: 1, tls: current }) ]);
        });

        it('is left out without TLS', () => {
            proxy.start(9212, '0.0.0.0', {});

            expect(startOptions()[0]).not.toHaveProperty('tls');
        });

        it('is sent again when renewed, and a restarted worker starts with the renewed one', () => {
            vi.useFakeTimers();
            try {
                vi.spyOn(WorkerServiceProxy.prototype as unknown as { restartWorker(): boolean }, 'restartWorker').mockReturnValue(true);
                const changes = new Subject<TlsCredentials>();
                proxy.start(9212, '0.0.0.0', {}, { credentials: credentials('first'), changes$: changes });

                const renewed = credentials('second');
                changes.next(renewed);
                expect(sent.filter(m => m.channel === 'm:tlsCredentials').map(m => m.content.tls)).toEqual([ renewed ]);

                (proxy as unknown as ProxyInternals).onWorkerExited();
                vi.advanceTimersByTime(1000);
                expect(startOptions().map(o => o.tls)).toEqual([ credentials('first'), renewed ]);
            } finally {
                vi.useRealTimers();
            }
        });

        it('is not sent any more once stopped', async () => {
            vi.spyOn(WorkerServiceProxy.prototype as unknown as { terminateWorker(): Promise<void> }, 'terminateWorker').mockResolvedValue();
            const changes = new Subject<TlsCredentials>();
            proxy.start(9212, '0.0.0.0', {}, { credentials: credentials('first'), changes$: changes });

            await proxy.stop();
            changes.next(credentials('second'));

            expect(sent.filter(m => m.channel === 'm:tlsCredentials')).toEqual([]);
        });
    });

    // The admin UI's client view: one round trip to the worker per refresh, and only then.
    describe('client activity', () => {
        let sent: { channel: string; content?: Record<string, unknown> }[];

        beforeEach(() => {
            sent = [];
            vi.spyOn(WorkerServiceProxy.prototype as unknown as { postMessage(channel: string, content?: Record<string, unknown>): void }, 'postMessage')
                .mockImplementation((channel, content) => {
                    sent.push({ channel, content });
                });
        });

        const asked = () => sent.filter(m => m.channel === 'm:clientActivity').map(m => m.content?.request as number);

        it('knows each client\'s address, TLS and connection time from its handshake', () => {
            fromWorker('clientConnected$', { id: 'c1', app: 'appA', name: 'quest', version: '2', address: '10.0.0.7', tls: true, tlsAtProxy: false, connectedAt: 123 });
            fromWorker('clientConnected$', { id: 'c2', app: 'appA', name: 'quest-2', version: '2', address: '10.0.0.8', tls: false, tlsAtProxy: true, connectedAt: 124 });

            expect(proxy.currentClients).toEqual([
                { id: 'c1', app: 'appA', name: 'quest', version: '2', address: '10.0.0.7', tls: true, tlsAtProxy: false, connectedAt: 123, metadata: {} },
                { id: 'c2', app: 'appA', name: 'quest-2', version: '2', address: '10.0.0.8', tls: false, tlsAtProxy: true, connectedAt: 124, metadata: {} },
            ]);
        });

        it('asks the worker and resolves with its answer, by client id', async () => {
            handshake('c1', 'appA');
            const activity = proxy.clientActivity();
            expect(asked()).toEqual([ 1 ]);

            fromWorker('clientActivity$', { request: 1, clients: [ { id: 'c1', in: 5, out: 7, limit: 'rate', held: 2 } ] });
            expect(Array.from(await activity)).toEqual([ [ 'c1', { in: 5, out: 7, limit: 'rate', held: 2 } ] ]);
        });

        it('shares one request among callers while it waits for the answer', async () => {
            handshake('c1', 'appA');
            const first = proxy.clientActivity();
            const second = proxy.clientActivity();
            expect(asked()).toEqual([ 1 ]);

            fromWorker('clientActivity$', { request: 1, clients: [] });
            expect(await second).toBe(await first);
            proxy.clientActivity();
            expect(asked()).toEqual([ 1, 2 ]);
        });

        it('asks for the rate history in a request of its own', async () => {
            handshake('c1', 'appA');
            const plain = proxy.clientActivity();
            const withHistory = proxy.clientActivity(1000, true);
            expect(proxy.clientActivity(1000, true)).toBe(withHistory);
            expect(sent.filter(m => m.channel === 'm:clientActivity').map(m => m.content)).toEqual([ { request: 1 }, { request: 2, history: true } ]);

            const history = [ [ 1_700_000_000_000, 5, 7 ] ];
            fromWorker('clientActivity$', { request: 2, clients: [ { id: 'c1', in: 5, out: 7, limit: null, held: 0, history } ] });
            fromWorker('clientActivity$', { request: 1, clients: [ { id: 'c1', in: 5, out: 7, limit: null, held: 0 } ] });
            expect((await withHistory).get('c1')?.history).toEqual(history);
            expect((await plain).get('c1')).not.toHaveProperty('history');
        });

        it('asks nothing while there is no TCP client', async () => {
            expect((await proxy.clientActivity()).size).toBe(0);
            expect(asked()).toEqual([]);
        });

        it('gives up on a worker that does not answer, and ignores its late answer', async () => {
            vi.useFakeTimers();
            try {
                handshake('c1', 'appA');
                const activity = proxy.clientActivity(500);
                vi.advanceTimersByTime(500);
                expect((await activity).size).toBe(0);

                const next = proxy.clientActivity(500);
                fromWorker('clientActivity$', { request: 1, clients: [ { id: 'c1', in: 1, out: 1, limit: null, held: 0 } ] });
                fromWorker('clientActivity$', { request: 2, clients: [ { id: 'c1', in: 2, out: 2, limit: null, held: 0 } ] });
                expect((await next).get('c1')?.in).toBe(2);
            } finally {
                vi.useRealTimers();
            }
        });
    });
});
