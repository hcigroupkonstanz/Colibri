import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('socket.io-client', () => ({
    connect: vi.fn()
}));

import { connect } from 'socket.io-client';
import { type Message, PROTOCOL_VERSION } from '../src/Colibri';
import type * as ColibriModule from '../src/Colibri';
import type * as ColibriErrorModule from '../src/ColibriError';
import type * as ModelSynchronizationModule from '../src/ModelSynchronization';
import { SyncModel } from '../src/SyncModel';
import { Synced } from '../src/Synced';
import { type FakeSocket, getAnyHandler, getHandler, makeFakeSocket } from './support/fakeSocket';
import { Widget, deliver, endOfAnswers, endRequest, everything, latest, nextTask } from './support/modelSyncHelpers';

const connectMock = connect as unknown as Mock;

let Colibri: typeof ColibriModule.Colibri;
type Colibri = ColibriModule.Colibri;
let DeleteRestApi: typeof ColibriModule.DeleteRestApi;
let GetRestApi: typeof ColibriModule.GetRestApi;
let PutRestApi: typeof ColibriModule.PutRestApi;
let RegisterChannel: typeof ColibriModule.RegisterChannel;
let RegisterOnce: typeof ColibriModule.RegisterOnce;
let SendMessage: typeof ColibriModule.SendMessage;
let UnregisterChannel: typeof ColibriModule.UnregisterChannel;
let ColibriError: typeof ColibriErrorModule.ColibriError;
let RegisterModelSync: typeof ModelSynchronizationModule.RegisterModelSync;

let fakeSocket: FakeSocket;

beforeEach(async () => {
    vi.resetModules();
    ({ Colibri, DeleteRestApi, GetRestApi, PutRestApi, RegisterChannel, RegisterOnce, SendMessage, UnregisterChannel } =
        await import('../src/Colibri'));
    ({ ColibriError } = await import('../src/ColibriError'));
    ({ RegisterModelSync } = await import('../src/ModelSynchronization'));
    vi.clearAllMocks();
    fakeSocket = makeFakeSocket();
    connectMock.mockReturnValue(fakeSocket);
});

afterEach(() => {
    // Colibri.instance is a private static that must not leak between tests.
    (Colibri as unknown as { instance: Colibri | null }).instance = null;
    fakeSocket.connected = false;
    vi.unstubAllGlobals();
});

describe('Colibri constructor', () => {
    it('throws when the server address is empty', () => {
        expect(() => new Colibri('app', '', 9211)).toThrow('Server Address missing or empty!');
    });

    it('throws when the server address is whitespace only', () => {
        expect(() => new Colibri('app', '   ', 9211)).toThrow('Server Address missing or empty!');
    });

    it.each([0, -1, 65536, 100000])('throws when the port %d is out of range', port => {
        expect(() => new Colibri('app', 'localhost', port)).toThrow('Port out of allowed range (1 - 65535)');
    });

    // NaN fails every range comparison, so it used to sail through and connect to "host:NaN".
    it.each([NaN, 9211.5])('throws a ColibriError for the port %d, which is not a whole number', port => {
        expect(() => new Colibri('app', 'localhost', port)).toThrow(ColibriError);
    });

    // 1.x took a port string such as '9011' from plain JavaScript because its range checks coerced
    // it; the stricter whole-number check must not turn that into a refusal.
    it.each(['9211', ' 9211 '])('accepts the port as the numeric string %j', port => {
        const colibri = new Colibri('app', 'localhost', port as unknown as number);
        expect(colibri.port).toBe(9211);
        expect(colibri.uri).toBe('ws://localhost:9211');
    });

    it.each(['abc', '90x1', ''])('throws a ColibriError for the port string %j, which is not a number', port => {
        expect(() => new Colibri('app', 'localhost', port as unknown as number)).toThrow(
            'Port must be a whole number (1 - 65535)'
        );
    });

    it('accepts the ends of the port range', () => {
        expect(new Colibri('app', 'localhost', 1).uri).toBe('ws://localhost:1');
        (Colibri as unknown as { instance: Colibri | null }).instance = null;
        expect(new Colibri('app', 'localhost', 65535).uri).toBe('ws://localhost:65535');
    });

    // Under Node there is no `window` at all, so the default used to be a ReferenceError that
    // escaped the constructor instead of a ColibriError saying what was missing.
    it('throws a ColibriError, not a ReferenceError, when no server is given outside a browser', () => {
        expect(typeof window).toBe('undefined');
        expect(() => new Colibri('app')).toThrow(ColibriError);
        expect(() => new Colibri('app')).toThrow('pass it as the second argument');
    });

    it('defaults the server to the host that served the page in a browser', () => {
        vi.stubGlobal('window', { location: { hostname: 'colibri.example.org' } });

        const c = new Colibri('app');

        expect(c.server).toBe('colibri.example.org');
        expect(c.uri).toBe('ws://colibri.example.org:9211');
    });

    it('builds a ws:// uri when the server has no scheme', () => {
        const c = new Colibri('app', 'localhost', 9211);
        expect(c.uri).toBe('ws://localhost:9211');
    });

    it('leaves an explicit ws:// scheme untouched', () => {
        const c = new Colibri('app', 'ws://localhost', 9211);
        expect(c.uri).toBe('ws://localhost:9211');
    });

    it('leaves an explicit wss:// scheme untouched', () => {
        const c = new Colibri('app', 'wss://example.com', 443);
        expect(c.uri).toBe('wss://example.com:443');
    });

    it('derives an http REST API uri from a ws server', () => {
        const c = new Colibri('myapp', 'localhost', 9211);
        expect(c.uriRestApi).toBe('http://localhost:9211/api/store/myapp/');
    });

    it('derives an https REST API uri from a wss server', () => {
        const c = new Colibri('myapp', 'wss://example.com', 443);
        expect(c.uriRestApi).toBe('https://example.com:443/api/store/myapp/');
    });

    // http(s):// is what an address bar shows for the same server, and used to be glued behind a
    // second scheme: 'ws://https://example.com:9011' and 'http://https://example.com:9011'.
    it.each([
        ['example.com', 'ws://example.com:9211', 'http://example.com:9211/api/store/app/'],
        ['ws://example.com', 'ws://example.com:9211', 'http://example.com:9211/api/store/app/'],
        ['wss://example.com', 'wss://example.com:9211', 'https://example.com:9211/api/store/app/'],
        ['http://example.com', 'ws://example.com:9211', 'http://example.com:9211/api/store/app/'],
        ['https://example.com', 'wss://example.com:9211', 'https://example.com:9211/api/store/app/'],
        ['HTTPS://example.com', 'wss://example.com:9211', 'https://example.com:9211/api/store/app/'],
        // A trailing slash, as copied out of an address bar, used to land in front of the port.
        ['example.com/', 'ws://example.com:9211', 'http://example.com:9211/api/store/app/'],
        ['https://example.com/', 'wss://example.com:9211', 'https://example.com:9211/api/store/app/'],
        ['  wss://example.com//  ', 'wss://example.com:9211', 'https://example.com:9211/api/store/app/']
    ])('maps the server %j to the socket %s and the REST API %s', (server, uri, rest) => {
        const c = new Colibri('app', server, 9211);

        expect(c.uri).toBe(uri);
        expect(c.uriRestApi).toBe(rest);
        expect(connectMock).toHaveBeenCalledWith(uri, expect.anything());
    });

    it('rejects a scheme that is neither ws(s) nor http(s)', () => {
        expect(() => new Colibri('app', 'ftp://example.com', 9211)).toThrow(ColibriError);
        expect(connectMock).not.toHaveBeenCalled();
    });

    it('rejects a server address that is nothing but a scheme', () => {
        expect(() => new Colibri('app', 'https://', 9211)).toThrow('Server Address missing or empty!');
    });

    // The admin UI's URL is 'http://<server>:9211', and the port in it used to stay part of the
    // host: 'ws://host:9011:9011', which retried forever without a word.
    it.each([
        ['http://example.com:9211/', 9211, 'ws://example.com:9211', 'http://example.com:9211/api/store/app/'],
        ['ws://example.com:8080', 8080, 'ws://example.com:8080', 'http://example.com:8080/api/store/app/'],
        ['https://example.com:443', 443, 'wss://example.com:443', 'https://example.com:443/api/store/app/'],
        ['example.com:9211', 9211, 'ws://example.com:9211', 'http://example.com:9211/api/store/app/'],
        ['http://[::1]:44011', 44011, 'ws://[::1]:44011', 'http://[::1]:44011/api/store/app/'],
        ['[::1]', 9211, 'ws://[::1]:9211', 'http://[::1]:9211/api/store/app/']
    ])('takes the port from the server %j when none is passed', (server, port, uri, rest) => {
        const c = new Colibri('app', server);

        expect(c.port).toBe(port);
        expect(c.uri).toBe(uri);
        expect(c.uriRestApi).toBe(rest);
        expect(connectMock).toHaveBeenCalledWith(uri, expect.anything());
    });

    it('accepts the same port in the server address and the argument', () => {
        expect(new Colibri('app', 'http://example.com:44011', 44011).uri).toBe('ws://example.com:44011');
    });

    it('rejects a server address whose port disagrees with the one passed', () => {
        expect(() => new Colibri('app', 'http://example.com:9211', 44011)).toThrow(ColibriError);
        expect(() => new Colibri('app', 'http://example.com:9211', 44011)).toThrow('give the port once');
        expect(connectMock).not.toHaveBeenCalled();
    });

    it('uses 9211 when neither the server address nor the argument has a port', () => {
        expect(new Colibri('app', 'example.com').port).toBe(9211);
    });

    it.each(['example.com:0', 'example.com:65536'])('rejects the out-of-range port in the server %j', server => {
        expect(() => new Colibri('app', server)).toThrow('Port out of allowed range (1 - 65535)');
    });

    // A path used to land in front of the port: 'wss://example.com/colibri:9011'.
    it.each([
        'https://example.com/colibri',
        'https://example.com/colibri/',
        'http://example.com:9211/log',
        'http://example.com:9211/#/log',
        'example.com?app=x'
    ])('rejects the server %j, which has a path or query after the host', server => {
        expect(() => new Colibri('app', server)).toThrow(ColibriError);
        expect(() => new Colibri('app', server)).toThrow('has a path or query after the host');
        expect(connectMock).not.toHaveBeenCalled();
    });

    it.each(['example.com:', 'example.com:abc', 'ws://:9211', 'fe80::1'])(
        'rejects the server %j, which is not a host and an optional port',
        server => {
            expect(() => new Colibri('app', server)).toThrow(ColibriError);
            expect(connectMock).not.toHaveBeenCalled();
        }
    );

    it('connects with the app/version query and websocket transport', () => {
        new Colibri('myapp', 'localhost', 9211);
        expect(connectMock).toHaveBeenCalledWith('ws://localhost:9211', {
            query: { app: 'myapp', version: '2' },
            transports: ['websocket']
        });
    });

    it('registers the connect handler and the colibri latency channel', () => {
        new Colibri('app', 'localhost', 9211);
        expect(fakeSocket.on).toHaveBeenCalledWith('connect', expect.any(Function));
        expect(fakeSocket.on).toHaveBeenCalledWith('colibri', expect.any(Function));
        expect(fakeSocket.onAny).toHaveBeenCalledWith(expect.any(Function));
    });

    it('echoes inbound latency messages back out through the colibri channel', () => {
        const c = new Colibri('app', 'localhost', 9211);
        const handler = getHandler(fakeSocket.on, 'colibri');

        handler({ channel: 'colibri', command: 'latency', payload: 123 });

        expect(fakeSocket.emit).toHaveBeenCalledWith('colibri', {
            command: 'latency',
            payload: 123
        });
        void c;
    });

    it('logs on socket connect', () => {
        const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
        new Colibri('app', 'localhost', 9211);
        const connectHandler = getHandler(fakeSocket.on, 'connect');

        connectHandler();

        expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('Connected to colibri server'));
    });

    it('forwards inbound onAny messages through the messages observable', () => {
        const c = new Colibri('app', 'localhost', 9211);
        const [onAnyHandler] = fakeSocket.onAny.mock.calls[0];

        const received: unknown[] = [];
        c.messages.subscribe(msg => received.push(msg));

        onAnyHandler('some-channel', { command: 'cmd', payload: { a: 1 } });

        expect(received).toEqual([{ channel: 'some-channel', command: 'cmd', payload: { a: 1 } }]);
    });

    // The server takes a client of the app 'colibri' for its own admin UI: it gets the server's log
    // and every client's connects, and is exempt from the version check. Nothing used to say so.
    it("warns that the app name 'colibri' is reserved for the admin UI", () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        new Colibri('colibri', 'localhost', 9211);

        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toContain("'colibri' is reserved for the server's admin UI");
        // Still connects under that name: an app relying on it keeps working.
        expect(connectMock).toHaveBeenCalledWith('ws://localhost:9211', {
            query: { app: 'colibri', version: PROTOCOL_VERSION },
            transports: ['websocket']
        });
        warnSpy.mockRestore();
    });

    // The server compares the name exactly, so only 'colibri' itself is the admin UI.
    it.each(['my-app', 'Colibri', 'colibri-study'])('does not warn about the app name %j', app => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        new Colibri(app, 'localhost', 9211);

        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it('throws when a second instance is constructed', () => {
        new Colibri('app', 'localhost', 9211);
        expect(() => new Colibri('app2', 'localhost', 9212)).toThrow('A Colibri instance already exists!');
    });
});

describe('Colibri.getInstance', () => {
    it('warns and returns null when uninitialized', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        expect(Colibri.getInstance()).toBeNull();
        expect(warnSpy).toHaveBeenCalled();
    });

    it('does not warn when warnIfNotInitialized is false', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        expect(Colibri.getInstance(false)).toBeNull();
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('returns the existing instance without warning', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const c = new Colibri('app', 'localhost', 9211);

        expect(Colibri.getInstance()).toBe(c);
        expect(warnSpy).not.toHaveBeenCalled();
    });
});

describe('Colibri instance methods delegate to the socket', () => {
    it('sendMessage emits {command, payload}, defaulting payload to {}', () => {
        const c = new Colibri('app', 'localhost', 9211);

        c.sendMessage('ch', 'cmd');
        expect(fakeSocket.emit).toHaveBeenCalledWith('ch', {
            command: 'cmd',
            payload: {}
        });

        c.sendMessage('ch', 'cmd2', { a: 1 });
        expect(fakeSocket.emit).toHaveBeenCalledWith('ch', {
            command: 'cmd2',
            payload: { a: 1 }
        });
    });

    it('registerChannel/unregisterChannel/registerOnce delegate to socket.on/off/once', () => {
        const c = new Colibri('app', 'localhost', 9211);
        const handler = () => undefined;

        c.registerChannel('ch', handler);
        expect(fakeSocket.on).toHaveBeenCalledWith('ch', handler);

        c.unregisterChannel('ch', handler);
        expect(fakeSocket.off).toHaveBeenCalledWith('ch', handler);

        c.registerOnce('ch', handler);
        expect(fakeSocket.once).toHaveBeenCalledWith('ch', handler);
    });
});

describe('wrapper functions', () => {
    // RegisterChannel, UnregisterChannel and RegisterOnce are covered under "registering before
    // new Colibri()": they no longer do nothing without an instance.
    it('return undefined when Colibri is not initialized', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        expect(SendMessage('ch', 'cmd')).toBeUndefined();
        expect(GetRestApi('key')).toBeUndefined();
        expect(PutRestApi('key', {})).toBeUndefined();
        expect(DeleteRestApi('key')).toBeUndefined();

        warnSpy.mockRestore();
    });

    it('delegate to the instance once Colibri is initialized', () => {
        new Colibri('app', 'localhost', 9211);
        const handler = () => undefined;

        SendMessage('ch', 'cmd', { a: 1 });
        expect(fakeSocket.emit).toHaveBeenCalledWith('ch', {
            command: 'cmd',
            payload: { a: 1 }
        });

        RegisterChannel('ch', handler);
        expect(fakeSocket.on).toHaveBeenCalledWith('ch', handler);

        UnregisterChannel('ch', handler);
        expect(fakeSocket.off).toHaveBeenCalledWith('ch', handler);

        RegisterOnce('ch', handler);
        expect(fakeSocket.once).toHaveBeenCalledWith('ch', handler);
    });
});

// The server may already have a model under the id registered: another client created it, or this
// one did before the page was reloaded, while another client kept the app alive. registerModel sent
// the model in full straight away, and the answer to the request for every model, already on its
// way, then put the old copy back here only: this client showed the old values while the server and
// every other client had the new ones.
describe('registering a model whose id the server may already have', () => {
    const connectSocket = () => {
        for (const [event, handler] of fakeSocket.on.mock.calls) {
            if (event === 'connect') handler();
        }
    };

    const disconnectSocket = () => {
        for (const [event, handler] of fakeSocket.on.mock.calls) {
            if (event === 'disconnect') handler('transport close');
        }
    };

    /** Everything emitted, as [command, payload], in the order it was. */
    const sentInOrder = () =>
        fakeSocket.emit.mock.calls.map(([, msg]) => [(msg as Message).command, (msg as Message).payload]);

    // Long enough for a change a model reported to have been sent: SyncModel buffers for 1ms.
    const settle = () => new Promise(resolve => setTimeout(resolve, 10));

    class Pair extends SyncModel<Pair> {
        @Synced() accessor a = '';
        @Synced() accessor b = '';
    }

    let debugSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    });

    afterEach(() => {
        debugSpy.mockRestore();
    });

    /**
     * A connected Colibri, a RegisterModelSync on 'reg' that has asked for every model, and then a
     * Pair 'p1' of its own, registered.
     */
    const registered = async () => {
        new Colibri('app', 'localhost', 9211);
        const [models$, registerModel] = RegisterModelSync({ name: 'reg', type: Pair });
        connectSocket();
        await nextTask();
        expect(sentInOrder()).toEqual(everything);
        // The server has none.
        endOfAnswers(fakeSocket);
        fakeSocket.emit.mockClear();

        const pair = new Pair('p1');
        pair.a = 'mine-a';
        pair.b = 'mine-b';
        registerModel(pair);
        return { models$, registerModel, pair };
    };

    it('asks for the id, and sends nothing until the server has answered', async () => {
        await registered();
        await settle();

        expect(sentInOrder()).toEqual([['model::request', { id: 'p1' }]]);
    });

    it('takes what the server has for the id instead of overwriting it', async () => {
        const { models$, pair } = await registered();

        deliver(fakeSocket, 'reg', { command: 'model::update', payload: { id: 'p1', a: 'server-a', b: 'server-b' } });
        await settle();

        expect([pair.a, pair.b]).toEqual(['server-a', 'server-b']);
        // The update taken for the answer may not be it (see 'keeping a change made after
        // registerModel'): nothing more is sent than the request whose answer comes after it.
        expect(sentInOrder()).toEqual([['model::request', { id: 'p1' }], endRequest]);
        expect(latest(models$)).toEqual([pair]);
    });

    // RegisterModelSync asks for every model first, and that answer comes before the one for the id.
    it('takes the answer to the request for every model as its answer too', async () => {
        const { models$, pair } = await registered();

        deliver(fakeSocket, 'reg', { command: 'model::update', payload: { id: 'p1', a: 'server-a', b: 'server-b' } });
        deliver(fakeSocket, 'reg', { command: 'model::update', payload: { id: 'p1', a: 'server-a', b: 'server-b' } });
        await settle();

        expect([pair.a, pair.b]).toEqual(['server-a', 'server-b']);
        expect(sentInOrder()).toEqual([['model::request', { id: 'p1' }], endRequest]);
        expect(latest(models$)).toEqual([pair]);
    });

    it('sends a change made after registering on top of what the server has', async () => {
        const { pair } = await registered();
        pair.a = 'changed';
        await settle();
        expect(sentInOrder()).toEqual([['model::request', { id: 'p1' }]]);

        deliver(fakeSocket, 'reg', { command: 'model::update', payload: { id: 'p1', a: 'server-a', b: 'server-b' } });
        await settle();

        expect([pair.a, pair.b]).toEqual(['changed', 'server-b']);
        // Asked for again, to see that the server has it (see the next describe).
        expect(sentInOrder()).toEqual([
            ['model::request', { id: 'p1' }],
            ['model::update', { id: 'p1', a: 'changed' }],
            ['model::request', { id: 'p1', again: true }],
            endRequest
        ]);

        deliver(fakeSocket, 'reg', { command: 'model::update', payload: { id: 'p1', a: 'changed', b: 'server-b' } });
        endOfAnswers(fakeSocket);
        fakeSocket.emit.mockClear();
        pair.b = 'changed too';
        await settle();
        expect(sentInOrder()).toEqual([['model::update', { id: 'p1', b: 'changed too' }]]);
    });

    it('does not ask for everything again once the server has answered', async () => {
        await registered();

        deliver(fakeSocket, 'reg', { command: 'model::update', payload: { id: 'p1' } });
        await settle();

        expect(sentInOrder()).toEqual([
            ['model::request', { id: 'p1' }],
            ['model::update', { id: 'p1', a: 'mine-a', b: 'mine-b' }]
        ]);
    });

    it('asks for a model registered while disconnected once reconnected, as one it has now', async () => {
        new Colibri('app', 'localhost', 9211);
        const [, registerModel] = RegisterModelSync({ name: 'reg', type: Pair });
        connectSocket();
        await nextTask();
        disconnectSocket();
        fakeSocket.emit.mockClear();

        const pair = new Pair('p1');
        pair.a = 'mine-a';
        registerModel(pair);
        pair.b = 'changed while away';
        await settle();
        expect(sentInOrder()).toEqual([]);

        connectSocket();
        deliver(fakeSocket, 'reg', { command: 'model::update', payload: { id: 'p1' } });
        await settle();

        expect(sentInOrder()).toEqual([
            ['model::request', { id: 'p1' }],
            ['model::update', { id: 'p1', a: 'mine-a', b: 'changed while away' }],
            ...everything
        ]);
    });

    // detach() stops this client sending the model's changes; the whole model is one of them.
    it('does not send a model whose detach() was called before the answer came', async () => {
        const { pair } = await registered();
        pair.detach();

        deliver(fakeSocket, 'reg', { command: 'model::update', payload: { id: 'p1' } });
        await settle();

        expect(sentInOrder()).toEqual([['model::request', { id: 'p1' }]]);
    });

    // Both used to stay listed, and every later update for the id went to the first of them only.
    it('replaces the copy of the id the server told it about, instead of listing the id twice', async () => {
        new Colibri('app', 'localhost', 9211);
        const [models$, registerModel] = RegisterModelSync({ name: 'reg', type: Pair });
        connectSocket();
        await nextTask();
        deliver(fakeSocket, 'reg', { command: 'model::update', payload: { id: 'p1', a: 'server-a', b: 'server-b' } });
        const [copy] = latest(models$);
        fakeSocket.emit.mockClear();

        const pair = new Pair('p1');
        registerModel(pair);
        expect(latest(models$)).toEqual([pair]);

        deliver(fakeSocket, 'reg', { command: 'model::update', payload: { id: 'p1', a: 'server-a', b: 'server-b' } });
        deliver(fakeSocket, 'reg', { command: 'model::update', payload: { id: 'p1', b: 'changed by another client' } });
        await settle();
        expect([pair.a, pair.b]).toEqual(['server-a', 'changed by another client']);
        expect(latest(models$)).toEqual([pair]);

        // The copy no longer sends its changes.
        copy.a = 'changed on the copy';
        await settle();
        expect(sentInOrder()).toEqual([['model::request', { id: 'p1' }], endRequest]);
    });

    it('does nothing when the model listed is registered again', async () => {
        const { models$, registerModel, pair } = await registered();
        registerModel(pair);

        deliver(fakeSocket, 'reg', { command: 'model::update', payload: { id: 'p1' } });
        await settle();

        expect(latest(models$)).toEqual([pair]);
        expect(sentInOrder()).toEqual([
            ['model::request', { id: 'p1' }],
            ['model::update', { id: 'p1', a: 'mine-a', b: 'mine-b' }]
        ]);
    });

    // Every RegisterModelSync on a channel receives the answer to a request another one sent.
    it('does not list the bare answer to another RegisterModelSync on the channel as a model', async () => {
        new Colibri('app', 'localhost', 9211);
        const [, registerModel] = RegisterModelSync({ name: 'reg-twice', type: Pair });
        const [other$] = RegisterModelSync({ name: 'reg-twice', type: Pair });
        connectSocket();
        await nextTask();
        registerModel(new Pair('p1'));

        deliver(fakeSocket, 'reg-twice', { command: 'model::update', payload: { id: 'p1' } });
        await settle();
        expect(latest(other$)).toEqual([]);

        // One another client has is still listed, fields or not.
        deliver(fakeSocket, 'reg-twice', { command: 'model::update', payload: { id: 'theirs' } });
        expect(latest(other$).map(m => m.id)).toEqual(['theirs']);
    });

    it('replaces an own model registered earlier under the same id, and says so', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const { models$, registerModel, pair } = await registered();
            deliver(fakeSocket, 'reg', { command: 'model::update', payload: { id: 'p1' } });

            const second = new Pair('p1');
            registerModel(second);
            expect(latest(models$)).toEqual([second]);
            expect(warnSpy).toHaveBeenCalledTimes(1);
            expect(warnSpy.mock.calls[0][0]).toContain("'p1'");

            deliver(fakeSocket, 'reg', { command: 'model::update', payload: { id: 'p1', a: 'mine-a', b: 'mine-b' } });
            fakeSocket.emit.mockClear();
            pair.a = 'changed on the first';
            second.b = 'changed on the second';
            await settle();

            expect(sentInOrder()).toEqual([['model::update', { id: 'p1', b: 'changed on the second' }]]);
        } finally {
            warnSpy.mockRestore();
        }
    });
});

// A change made after registerModel, before the server has answered for the model, is held back and
// sent on top of what the server has. The update taken for the answer need not be the answer,
// though: the answer to the request for every model carries the id too, and so does an update
// another client made. The real answer then came after the change was sent, without it, and undid
// it on this client only: it showed the old value while the server and every other client had the
// new one.
// delete() deletes a model for every client, as destroying a SyncBehaviour does in Unity: the
// server removes it and tells every other client. It used to only stop this client syncing it.
describe('deleting a model for every client', () => {
    const connectSocket = () => {
        for (const [event, handler] of fakeSocket.on.mock.calls) {
            if (event === 'connect') handler();
        }
    };

    /** Everything emitted with `command`, as [channel, payload]. */
    const sent = (command: string) =>
        fakeSocket.emit.mock.calls
            .filter(([, msg]) => (msg as Message).command === command)
            .map(([channel, msg]) => [channel, (msg as Message).payload]);

    // Long enough for a change a model reported to have been sent: SyncModel buffers for 1ms.
    const settle = () => new Promise(resolve => setTimeout(resolve, 10));

    let debugSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    });

    afterEach(() => {
        debugSpy.mockRestore();
        vi.useRealTimers();
    });

    /** A connected Colibri with the own model 'w1' on channel 'del', which the server has. */
    const connectedWithOwnWidget = async () => {
        new Colibri('app', 'localhost', 9211);
        const [models$, registerModel] = RegisterModelSync({ name: 'del', type: Widget });
        const widget = new Widget('w1');
        widget.label = 'mine';
        registerModel(widget);
        connectSocket();
        deliver(fakeSocket, 'del', { command: 'model::update', payload: { id: 'w1', label: 'mine' } });
        await settle();
        fakeSocket.emit.mockClear();
        return { models$, registerModel, widget };
    };

    it('deletes an own model on the server, and takes it out of the list', async () => {
        const { models$, widget } = await connectedWithOwnWidget();

        widget.delete();
        widget.label = 'after';
        await settle();

        expect(sent('model::delete')).toEqual([['del', { id: 'w1' }]]);
        expect(sent('model::update')).toEqual([]);
        expect(latest(models$)).toEqual([]);
    });

    it('deletes a model another client created', () => {
        new Colibri('app', 'localhost', 9211);
        const [models$] = RegisterModelSync({ name: 'del', type: Widget });
        connectSocket();
        deliver(fakeSocket, 'del', { command: 'model::update', payload: { id: 'r1', label: 'theirs' } });
        const [theirs] = latest(models$);
        fakeSocket.emit.mockClear();

        theirs.delete();

        expect(sent('model::delete')).toEqual([['del', { id: 'r1' }]]);
        expect(latest(models$)).toEqual([]);
    });

    it('sends the delete once, however often delete() is called', async () => {
        const { widget } = await connectedWithOwnWidget();

        widget.delete();
        widget.delete();

        expect(sent('model::delete')).toEqual([['del', { id: 'w1' }]]);
    });

    it('sends the delete once new Colibri() is constructed, when it is called before', () => {
        const [models$, registerModel] = RegisterModelSync({ name: 'del-early', type: Widget });
        const widget = new Widget('w1');
        registerModel(widget);
        widget.delete();
        expect(fakeSocket.emit).not.toHaveBeenCalled();

        new Colibri('app', 'localhost', 9211);

        expect(sent('model::delete')).toEqual([['del-early', { id: 'w1' }]]);
        // Nothing to ask for any more.
        expect(sent('model::request')).not.toContainEqual(['del-early', { id: 'w1' }]);
        expect(latest(models$)).toEqual([]);
    });

    it('sends no delete for a delete from another client, nor when registerModel replaces a listed copy', () => {
        new Colibri('app', 'localhost', 9211);
        const [models$, registerModel] = RegisterModelSync({ name: 'del', type: Widget });
        connectSocket();
        deliver(fakeSocket, 'del', { command: 'model::update', payload: { id: 'r1', label: 'theirs' } });
        deliver(fakeSocket, 'del', { command: 'model::update', payload: { id: 'r2', label: 'theirs' } });

        deliver(fakeSocket, 'del', { command: 'model::delete', payload: { id: 'r1' } });
        registerModel(new Widget('r2'));

        expect(sent('model::delete')).toEqual([]);
        expect(latest(models$).map(m => m.id)).toEqual(['r2']);
    });

    // Relayed before the server had the delete, another client's update comes after it.
    it('does not list a model it deleted again from an update in the next 60 s', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const { models$ } = await connectedWithOwnWidget();
        const [widget] = latest(models$);

        widget.delete();
        deliver(fakeSocket, 'del', { command: 'model::update', payload: { id: 'w1', label: 'late' } });
        expect(latest(models$)).toEqual([]);

        vi.setSystemTime(Date.now() + 60_000);
        deliver(fakeSocket, 'del', { command: 'model::update', payload: { id: 'w1', label: 'created again' } });
        expect(latest(models$).map(m => [m.id, m.label])).toEqual([['w1', 'created again']]);
    });

    // A fresh request, without `again`, lifts the server's memory of the delete.
    it('lists and asks for a model registered again with the id it deleted', async () => {
        const { models$, registerModel, widget } = await connectedWithOwnWidget();
        widget.delete();
        fakeSocket.emit.mockClear();

        const again = new Widget('w1');
        registerModel(again);
        deliver(fakeSocket, 'del', { command: 'model::update', payload: { id: 'w1', label: 'other' } });

        expect(sent('model::request').filter(([channel]) => channel === 'del')).toEqual([['del', { id: 'w1' }]]);
        expect(latest(models$)).toEqual([again]);
    });

    // A change still buffered goes out before the delete, never after it: with
    // MODEL_TOMBSTONE_SECONDS=0 that update created the object again on every client.
    it('sends a change made just before delete() ahead of the delete', async () => {
        const { widget } = await connectedWithOwnWidget();

        widget.label = 'last';
        widget.delete();
        await settle();

        expect(fakeSocket.emit.mock.calls.map(([, msg]) => (msg as Message).command)).toEqual([
            'model::update',
            'model::delete'
        ]);
    });

    // Socket.IO notices a connection that died without closing only after its ping timeout, and
    // what it sent until then is lost. colibri-unity sends such deletes again, and so does this.
    it('sends a delete again on a disconnect when nothing was heard from the server since', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const { widget } = await connectedWithOwnWidget();
        getAnyHandler(fakeSocket.onAny)('colibri', { command: 'latency', payload: '1' });
        vi.setSystemTime(Date.now() + 5_000);

        widget.delete();
        for (const [event, handler] of fakeSocket.on.mock.calls) {
            if (event === 'disconnect') handler('ping timeout');
        }

        expect(sent('model::delete')).toEqual([
            ['del', { id: 'w1' }],
            ['del', { id: 'w1' }]
        ]);
    });

    it('does not send a delete again that the server answered after', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const { widget } = await connectedWithOwnWidget();

        widget.delete();
        vi.setSystemTime(Date.now() + 5_000);
        getAnyHandler(fakeSocket.onAny)('colibri', { command: 'latency', payload: '1' });
        for (const [event, handler] of fakeSocket.on.mock.calls) {
            if (event === 'disconnect') handler('transport close');
        }

        expect(sent('model::delete')).toEqual([['del', { id: 'w1' }]]);
    });

    // An update another client sent before the server had the delete still comes after it. Taken
    // for the answer to registering the id again, it settled the new object with the deleted
    // one's values, and the new object was never sent.
    it('sends a model registered again with the id it deleted in full, and drops updates until the answer', async () => {
        const { models$, registerModel, widget } = await connectedWithOwnWidget();
        widget.delete();
        fakeSocket.emit.mockClear();

        const again = new Widget('w1');
        again.label = 'fresh';
        registerModel(again);
        deliver(fakeSocket, 'del', { command: 'model::update', payload: { id: 'w1', label: 'stale' } });
        deliver(fakeSocket, 'del', { command: 'model::update', payload: { id: 'w1' } });
        // What it sends is kept out of updates until the answers asked before are over.
        endOfAnswers(fakeSocket);
        deliver(fakeSocket, 'del', { command: 'model::update', payload: { id: 'w1', label: 'from another client' } });

        expect(sent('model::request').filter(([channel]) => channel === 'del')).toEqual([['del', { id: 'w1' }]]);
        expect(sent('model::update')).toEqual([['del', { id: 'w1', label: 'fresh' }]]);
        expect(latest(models$).map(m => m.label)).toEqual(['from another client']);
    });

    // Deleted by a subscriber of the list while the answer is applied: nothing goes out after the
    // delete for it.
    it('sends nothing more for a model a subscriber deletes as its answer is applied', async () => {
        class Pair extends SyncModel<Pair> {
            @Synced() accessor a = '';
            @Synced() accessor b = '';
        }
        new Colibri('app', 'localhost', 9211);
        const [models$, registerModel] = RegisterModelSync({ name: 'del', type: Pair });
        const pair = new Pair('p1');
        registerModel(pair);
        pair.a = 'held';
        connectSocket();
        const subscription = models$.subscribe(models => {
            if (models.some(m => m.b === 'server')) pair.delete();
        });

        deliver(fakeSocket, 'del', { command: 'model::update', payload: { id: 'p1', a: 'old', b: 'server' } });
        await settle();
        subscription.unsubscribe();

        const commands = fakeSocket.emit.mock.calls.map(([channel, msg]) => [channel, (msg as Message).command]);
        const afterDelete = commands.slice(commands.findIndex(([, c]) => c === 'model::delete') + 1);
        expect(afterDelete).not.toContainEqual(['del', 'model::update']);
        // Asking for every model still follows.
        expect(afterDelete).toContainEqual(['del', 'model::request']);
    });

    // Deleted while its answer is on its way: the answer settles nothing, and asking for every
    // model still follows.
    it('ignores the answer for a model deleted before it came, and still asks for every model', async () => {
        new Colibri('app', 'localhost', 9211);
        const [models$, registerModel] = RegisterModelSync({ name: 'del', type: Widget });
        const widget = new Widget('w1');
        widget.label = 'mine';
        registerModel(widget);
        connectSocket();
        expect(sent('model::request')).toContainEqual(['del', { id: 'w1' }]);

        widget.delete();
        deliver(fakeSocket, 'del', { command: 'model::update', payload: { id: 'w1' } });
        deliver(fakeSocket, 'del', { command: 'model::update', payload: { id: 'w1', label: 'server' } });
        await settle();

        expect(latest(models$)).toEqual([]);
        expect(sent('model::update')).toEqual([]);
        expect(sent('model::request')).toContainEqual(['del', {}]);
    });
});

// SyncModel's own update(), toJson() and detach() are used, whatever a model class has under those
// names: an update() of its own, to move the model each frame say, took over how other clients'
// changes were applied, and none of them arrived.
describe("a model class with methods named like SyncModel's", () => {
    class Mover extends SyncModel<Mover> {
        @Synced() accessor x = 0;
        public moves = 0;

        // TypeScript takes this as an override: it has fewer parameters than SyncModel's.
        public update(): void {
            this.moves += 1;
        }

        public toJson(): Partial<Mover> {
            return {};
        }
    }

    const connectSocket = () => {
        for (const [event, handler] of fakeSocket.on.mock.calls) {
            if (event === 'connect') handler();
        }
    };

    it("takes other clients' changes and sends its own all the same", async () => {
        new Colibri('app', 'localhost', 9211);
        const [movers$] = RegisterModelSync({ name: 'movers', type: Mover });
        connectSocket();

        deliver(fakeSocket, 'movers', { command: 'model::update', payload: { id: 'm1', x: 5 } });
        const [mover] = latest(movers$);
        expect(mover.x).toBe(5);
        expect(mover.moves).toBe(0);

        fakeSocket.emit.mockClear();
        mover.x = 7;
        await new Promise(resolve => setTimeout(resolve, 10));

        const updates = fakeSocket.emit.mock.calls
            .filter(([, msg]) => (msg as Message).command === 'model::update')
            .map(([, msg]) => (msg as Message).payload);
        expect(updates).toEqual([{ id: 'm1', x: 7 }]);
    });
});

// A change of a model another client created made the list emit, one of this client's own did not,
// so a page rendering the list never showed it.
describe('the list of models', () => {
    it('emits when this client changes one of its own models', async () => {
        new Colibri('app', 'localhost', 9211);
        const [widgets$, registerWidget] = RegisterModelSync({ name: 'own-changes', type: Widget });
        const widget = new Widget('w1');
        registerWidget(widget);
        const emitted: string[][] = [];
        widgets$.subscribe(list => emitted.push(list.map(w => w.label)));

        widget.label = 'changed';
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(emitted.at(-1)).toEqual(['changed']);
        expect(emitted.length).toBeGreaterThan(1);
    });
});

describe('keeping a change made after registerModel', () => {
    const connectSocket = () => {
        for (const [event, handler] of fakeSocket.on.mock.calls) {
            if (event === 'connect') handler();
        }
    };

    const disconnectSocket = () => {
        for (const [event, handler] of fakeSocket.on.mock.calls) {
            if (event === 'disconnect') handler('transport close');
        }
    };

    /** Everything emitted, as [command, payload], in the order it was. */
    const sentInOrder = () =>
        fakeSocket.emit.mock.calls.map(([, msg]) => [(msg as Message).command, (msg as Message).payload]);

    /** The same, without the requests on 'colibri::reconnect' (see endOfAnswers). */
    const sentOnChannel = () =>
        fakeSocket.emit.mock.calls
            .filter(([channel]) => channel !== 'colibri::reconnect')
            .map(([, msg]) => [(msg as Message).command, (msg as Message).payload]);

    // Long enough for a change a model reported to have been sent: SyncModel buffers for 1ms.
    const settle = () => new Promise(resolve => setTimeout(resolve, 10));

    class Pair extends SyncModel<Pair> {
        @Synced() accessor a = '';
        @Synced() accessor b = '';
    }

    const server = { id: 'p1', a: 'server-a', b: 'server-b' };

    let debugSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    });

    afterEach(() => {
        debugSpy.mockRestore();
    });

    /** A connected RegisterModelSync on `channel` that has asked for every model, then 'p1' registered. */
    const registeredLate = async (channel = 'reg') => {
        new Colibri('app', 'localhost', 9211);
        const [models$, registerModel] = RegisterModelSync({ name: channel, type: Pair });
        connectSocket();
        await nextTask();
        fakeSocket.emit.mockClear();
        const pair = new Pair('p1');
        registerModel(pair);
        return { models$, pair };
    };

    it('keeps it when the answer to the request for every model comes first, and the answer after it', async () => {
        const { pair } = await registeredLate();
        pair.a = 'changed';
        await settle();

        deliver(fakeSocket, 'reg', { command: 'model::update', payload: server });
        await settle();
        // The answer to the request for the id, made before the server had the change.
        deliver(fakeSocket, 'reg', { command: 'model::update', payload: server });
        await settle();

        expect([pair.a, pair.b]).toEqual(['changed', 'server-b']);
        expect(sentInOrder()).toEqual([
            ['model::request', { id: 'p1' }],
            ['model::update', { id: 'p1', a: 'changed' }],
            ['model::request', { id: 'p1', again: true }],
            endRequest
        ]);

        // The answer to asking again has it, and the answers are over: from now on a change goes out
        // as it is made.
        deliver(fakeSocket, 'reg', { command: 'model::update', payload: { ...server, a: 'changed' } });
        endOfAnswers(fakeSocket);
        fakeSocket.emit.mockClear();
        pair.b = 'changed too';
        await settle();
        expect(sentInOrder()).toEqual([['model::update', { id: 'p1', b: 'changed too' }]]);
        expect([pair.a, pair.b]).toEqual(['changed', 'changed too']);
    });

    // SyncModel reports a change 1 ms after it is made. Decided then, the change was not held, the
    // answer was applied over it, and the report sent the server's old value to every client.
    it('keeps it when the answer comes before SyncModel reports the change', async () => {
        const { pair } = await registeredLate();
        pair.a = 'changed';
        deliver(fakeSocket, 'reg', { command: 'model::update', payload: server });
        await settle();

        expect([pair.a, pair.b]).toEqual(['changed', 'server-b']);
        expect(sentInOrder()).toEqual([
            ['model::request', { id: 'p1' }],
            ['model::update', { id: 'p1', a: 'changed' }],
            ['model::request', { id: 'p1', again: true }],
            endRequest
        ]);

        deliver(fakeSocket, 'reg', { command: 'model::update', payload: { ...server, a: 'changed' } });
        endOfAnswers(fakeSocket);
        await settle();
        expect(sentInOrder()).toHaveLength(4);
        expect([pair.a, pair.b]).toEqual(['changed', 'server-b']);
    });

    // With nothing held when the update taken for the answer came, a change made after it went out at
    // once, and the answer, made before the server had the change, undid it here only.
    it("keeps a change made after another client's update came first, and the answer after it", async () => {
        const { pair } = await registeredLate();
        // The end of the answers to the request for every model, then another client's update.
        endOfAnswers(fakeSocket);
        deliver(fakeSocket, 'reg', { command: 'model::update', payload: { id: 'p1', b: 'theirs' } });
        pair.a = 'changed';
        await settle();
        expect(sentOnChannel()).toEqual([
            ['model::request', { id: 'p1' }],
            ['model::update', { id: 'p1', a: 'changed' }]
        ]);

        // The answer to the request for the id.
        deliver(fakeSocket, 'reg', { command: 'model::update', payload: { ...server, b: 'theirs' } });
        expect([pair.a, pair.b]).toEqual(['changed', 'theirs']);

        // Once the answers are over, an update is applied as it comes.
        endOfAnswers(fakeSocket);
        deliver(fakeSocket, 'reg', { command: 'model::update', payload: { id: 'p1', a: 'theirs too' } });
        expect(pair.a).toBe('theirs too');
    });

    // SyncModel reports a change 1 ms after it is made. The answer that came in between was applied
    // over it, and the report sent the server's old value in its place, to every client.
    it("keeps a change made after another client's update came first, when the answer comes before it is sent", async () => {
        const { pair } = await registeredLate();
        endOfAnswers(fakeSocket);
        deliver(fakeSocket, 'reg', { command: 'model::update', payload: { id: 'p1', b: 'theirs' } });
        pair.a = 'changed';
        // The answer to the request for the id.
        deliver(fakeSocket, 'reg', { command: 'model::update', payload: { ...server, b: 'theirs' } });
        await settle();

        expect([pair.a, pair.b]).toEqual(['changed', 'theirs']);
        expect(sentOnChannel()).toEqual([
            ['model::request', { id: 'p1' }],
            ['model::update', { id: 'p1', a: 'changed' }]
        ]);
    });

    // The server read the request for the id after the delete, so its answer is the bare id, which
    // was listed as a model with no fields that no other client has.
    it("does not list the bare answer that comes after another client's update and delete", async () => {
        const { models$ } = await registeredLate('reg-deleted');
        endOfAnswers(fakeSocket);
        deliver(fakeSocket, 'reg-deleted', { command: 'model::update', payload: { id: 'p1', b: 'theirs' } });
        deliver(fakeSocket, 'reg-deleted', { command: 'model::delete', payload: { id: 'p1' } });
        // The answer to the request for the id.
        deliver(fakeSocket, 'reg-deleted', { command: 'model::update', payload: { id: 'p1' } });
        await settle();

        expect(latest(models$)).toEqual([]);
        expect(sentOnChannel()).toEqual([['model::request', { id: 'p1' }]]);
    });

    it('keeps a change made after the answer for every model came first, and the answer after it', async () => {
        const { pair } = await registeredLate();
        deliver(fakeSocket, 'reg', { command: 'model::update', payload: server });
        // The end of the answers to the request for every model.
        endOfAnswers(fakeSocket, 1);
        pair.a = 'changed';
        await settle();
        expect(sentOnChannel()).toEqual([
            ['model::request', { id: 'p1' }],
            ['model::update', { id: 'p1', a: 'changed' }]
        ]);

        deliver(fakeSocket, 'reg', { command: 'model::update', payload: server });
        expect([pair.a, pair.b]).toEqual(['changed', 'server-b']);
    });

    // A change held that the server had anyway is not asked for once more, so the next one goes out at
    // once too.
    it('keeps a change made after a held one that the server had anyway', async () => {
        const { pair } = await registeredLate();
        endOfAnswers(fakeSocket);
        pair.a = 'server-a';
        // Another client's update.
        deliver(fakeSocket, 'reg', { command: 'model::update', payload: { id: 'p1', a: 'server-a' } });
        await settle();
        pair.a = 'changed';
        await settle();
        expect(sentOnChannel()).toEqual([
            ['model::request', { id: 'p1' }],
            ['model::update', { id: 'p1', a: 'server-a' }],
            ['model::update', { id: 'p1', a: 'changed' }]
        ]);

        deliver(fakeSocket, 'reg', { command: 'model::update', payload: server });
        expect([pair.a, pair.b]).toEqual(['changed', 'server-b']);
    });

    // A field sent before that request is kept out only until the answer to the request after asking
    // for every model: what another client sets once the server has it comes after that answer.
    it('takes what another client sets after a field sent before it, once the server has that', async () => {
        new Colibri('app', 'localhost', 9211);
        const [models$, registerModel] = RegisterModelSync({ name: 'reg', type: Pair });
        connectSocket();
        await nextTask();
        // The answer to the request for every model, in two parts: another client's model, and 'p1'.
        deliver(fakeSocket, 'reg', { command: 'model::update', payload: { id: 'theirs', a: 'A', b: 'B' } });
        const [theirs] = latest(models$);
        theirs.a = 'mine';
        await settle();
        const pair = new Pair('p1');
        registerModel(pair);
        deliver(fakeSocket, 'reg', { command: 'model::update', payload: server });
        endOfAnswers(fakeSocket, 1);
        pair.a = 'changed';
        await settle();

        deliver(fakeSocket, 'reg', { command: 'model::update', payload: { id: 'theirs', a: 'later' } });
        // The answer to the request for 'p1'.
        deliver(fakeSocket, 'reg', { command: 'model::update', payload: server });

        expect([theirs.a, pair.a]).toEqual(['later', 'changed']);
    });

    // Registered at the top of a module, before new Colibri(), the usual order.
    it('asks for a model registered before new Colibri() before asking for every model', async () => {
        const [, registerModel] = RegisterModelSync({ name: 'reg', type: Pair });
        const pair = new Pair('p1');
        registerModel(pair);
        pair.a = 'changed';
        new Colibri('app', 'localhost', 9211);
        connectSocket();
        await settle();
        expect(sentInOrder()).toEqual([['model::request', { id: 'p1' }]]);

        deliver(fakeSocket, 'reg', { command: 'model::update', payload: server });
        await settle();
        expect(sentInOrder().slice(1)).toEqual([
            ['model::update', { id: 'p1', a: 'changed' }],
            ['model::request', { id: 'p1', again: true }],
            endRequest
        ]);

        deliver(fakeSocket, 'reg', { command: 'model::update', payload: { ...server, a: 'changed' } });
        endOfAnswers(fakeSocket);
        expect(sentInOrder().slice(4)).toEqual(everything);
        // What that request is answered with has the change in it.
        deliver(fakeSocket, 'reg', { command: 'model::update', payload: { ...server, a: 'changed' } });
        expect([pair.a, pair.b]).toEqual(['changed', 'server-b']);
    });

    it('asks for a model registered in the same block as RegisterModelSync before asking for every model', async () => {
        new Colibri('app', 'localhost', 9211);
        connectSocket();
        const [, registerModel] = RegisterModelSync({ name: 'reg', type: Pair });
        const pair = new Pair('p1');
        pair.a = 'mine';
        registerModel(pair);
        await settle();
        expect(sentInOrder()).toEqual([['model::request', { id: 'p1' }]]);

        deliver(fakeSocket, 'reg', { command: 'model::update', payload: { id: 'p1' } });
        expect(sentInOrder().slice(1)).toEqual([['model::update', { id: 'p1', a: 'mine', b: '' }], ...everything]);
    });

    // Another client may change the same field meanwhile, after this client's change: what the
    // server has then is what the last update before the end of the answers showed.
    it('takes a value another client set after the change once the answers are over', async () => {
        const { pair } = await registeredLate();
        pair.a = 'mine';
        // The answer to the request for every model, and the end of its answers.
        deliver(fakeSocket, 'reg', { command: 'model::update', payload: server });
        endOfAnswers(fakeSocket, 1);
        await settle();

        // The answer to the request for the id, made before the server had the change, then the one to
        // asking again, and another client's change, relayed.
        deliver(fakeSocket, 'reg', { command: 'model::update', payload: server });
        deliver(fakeSocket, 'reg', { command: 'model::update', payload: { ...server, a: 'mine' } });
        deliver(fakeSocket, 'reg', { command: 'model::update', payload: { id: 'p1', a: 'theirs' } });
        expect(pair.a).toBe('mine');
        endOfAnswers(fakeSocket);
        expect(pair.a).toBe('theirs');

        fakeSocket.emit.mockClear();
        pair.b = 'mine';
        await settle();
        expect(sentInOrder()).toEqual([['model::update', { id: 'p1', b: 'mine' }]]);
    });

    it('holds back a change made while it asks again, and sends it once the answers are over', async () => {
        const { pair } = await registeredLate();
        pair.a = 'mine';
        deliver(fakeSocket, 'reg', { command: 'model::update', payload: server });
        pair.b = 'mine too';
        await settle();
        expect(sentInOrder()).toHaveLength(4);

        deliver(fakeSocket, 'reg', { command: 'model::update', payload: { ...server, a: 'mine' } });
        endOfAnswers(fakeSocket);
        await settle();
        expect(sentInOrder().slice(4)).toEqual([['model::update', { id: 'p1', b: 'mine too' }]]);
        expect([pair.a, pair.b]).toEqual(['mine', 'mine too']);
    });

    // The change may never have reached the server: it is sent again after the reconnect.
    it('sends the change again when the connection drops while it asks again', async () => {
        const { pair } = await registeredLate();
        pair.a = 'mine';
        deliver(fakeSocket, 'reg', { command: 'model::update', payload: server });
        await settle();
        disconnectSocket();
        connectSocket();
        fakeSocket.emit.mockClear();

        deliver(fakeSocket, 'reg', { command: 'model::update', payload: server });
        endOfAnswers(fakeSocket);
        await settle();

        expect(pair.a).toBe('mine');
        expect(sentInOrder()).toEqual([
            ['model::update', { id: 'p1', a: 'mine' }],
            ['model::request', { id: 'p1', again: true }],
            endRequest
        ]);
    });

    // A model that changes all the time from the start, a tracked pose say, changed again before
    // every answer: the changes made meanwhile went out with one more request each time, so the
    // model stayed asked for, one update a round trip went out, and everything else was never asked
    // for.
    it('asks for every model after asking again once, though the model changed before every answer', async () => {
        new Colibri('app', 'localhost', 9211);
        connectSocket();
        const [, registerModel] = RegisterModelSync({ name: 'reg', type: Pair });
        const pair = new Pair('p1');
        registerModel(pair);
        pair.a = 'a1';
        await settle();
        deliver(fakeSocket, 'reg', { command: 'model::update', payload: server });
        pair.a = 'a2';
        await settle();
        expect(sentOnChannel()).toEqual([
            ['model::request', { id: 'p1' }],
            ['model::update', { id: 'p1', a: 'a1' }],
            ['model::request', { id: 'p1', again: true }]
        ]);

        deliver(fakeSocket, 'reg', { command: 'model::update', payload: { ...server, a: 'a1' } });
        endOfAnswers(fakeSocket);
        pair.a = 'a3';
        await settle();
        expect(sentOnChannel().slice(3)).toEqual([
            ['model::update', { id: 'p1', a: 'a2' }],
            ['model::request', {}],
            ['model::update', { id: 'p1', a: 'a3' }]
        ]);
    });

    // Two updates from another client that changes the model all the time too came before the answer
    // to asking again, and the second was taken for it: the same again, every round trip.
    it('sends every change after asking again once, while another client changes the model all the time', async () => {
        const { pair } = await registeredLate();
        pair.a = 'a1';
        deliver(fakeSocket, 'reg', { command: 'model::update', payload: server });
        // The end of the answers to the request for every model.
        endOfAnswers(fakeSocket, 1);
        pair.a = 'a2';
        await settle();
        expect(sentOnChannel()).toHaveLength(3);

        deliver(fakeSocket, 'reg', { command: 'model::update', payload: { id: 'p1', b: 'b1' } });
        deliver(fakeSocket, 'reg', { command: 'model::update', payload: { id: 'p1', b: 'b2' } });
        deliver(fakeSocket, 'reg', { command: 'model::update', payload: { ...server, a: 'a1', b: 'b2' } });
        deliver(fakeSocket, 'reg', { command: 'model::update', payload: { id: 'p1', b: 'b3' } });
        endOfAnswers(fakeSocket);
        pair.a = 'a3';
        await settle();

        expect([pair.a, pair.b]).toEqual(['a3', 'b3']);
        expect(sentOnChannel().slice(3)).toEqual([
            ['model::update', { id: 'p1', a: 'a2' }],
            ['model::update', { id: 'p1', a: 'a3' }]
        ]);
    });

    // The server holds back the updates of a client over its limit (CLIENT_MESSAGE_RATE_LIMIT), but
    // never a request, so the answer to asking again may come without the change. Taken for the
    // answer, it undid the change here, while the server had it once it handled the update.
    it('sends the change again when the answers are over without it, with what it held since', async () => {
        const { pair } = await registeredLate();
        pair.a = 'mine';
        deliver(fakeSocket, 'reg', { command: 'model::update', payload: server });
        await settle();
        deliver(fakeSocket, 'reg', { command: 'model::update', payload: server });
        pair.b = 'later';
        await settle();
        expect(sentInOrder()).toHaveLength(4);
        expect([pair.a, pair.b]).toEqual(['mine', 'later']);

        endOfAnswers(fakeSocket);
        await settle();
        expect([pair.a, pair.b]).toEqual(['mine', 'later']);
        expect(sentInOrder().slice(4)).toEqual([['model::update', { id: 'p1', a: 'mine', b: 'later' }]]);

        fakeSocket.emit.mockClear();
        pair.b = 'now';
        await settle();
        expect(sentInOrder()).toEqual([['model::update', { id: 'p1', b: 'now' }]]);
    });

    // Sent while the connection was down, a change goes into Socket.IO's buffer, which sends it on
    // the reconnect ahead of asking for the model again: a server that had forgotten the model took
    // that one change for all of it, and the rest was never sent.
    it('holds a change made while disconnected as it asks again, and sends it all after the reconnect', async () => {
        const { pair } = await registeredLate();
        pair.a = 'mine';
        deliver(fakeSocket, 'reg', { command: 'model::update', payload: server });
        await settle();
        expect(sentInOrder()).toHaveLength(4);
        disconnectSocket();
        pair.b = 'later';
        await settle();
        expect(sentInOrder()).toHaveLength(4);

        connectSocket();
        // The server restarted meanwhile.
        deliver(fakeSocket, 'reg', { command: 'model::update', payload: { id: 'p1' } });
        endOfAnswers(fakeSocket);
        await settle();
        expect(sentInOrder().slice(4)).toEqual([
            ['model::request', { id: 'p1', again: true }],
            endRequest,
            ['model::update', { id: 'p1', a: 'mine', b: 'later' }],
            ...everything
        ]);
    });

    // A field set to undefined is left out of what is sent, so no update could ever show it.
    it('does not wait for an update to show a field set to undefined', async () => {
        class Note extends SyncModel<Note> {
            @Synced() accessor text: string | undefined = 'mine';
        }
        new Colibri('app', 'localhost', 9211);
        const [, registerModel] = RegisterModelSync({ name: 'notes', type: Note });
        connectSocket();
        await nextTask();
        fakeSocket.emit.mockClear();
        const note = new Note('n1');
        registerModel(note);

        note.text = undefined;
        deliver(fakeSocket, 'notes', { command: 'model::update', payload: { id: 'n1', text: 'server' } });
        await settle();

        expect(sentInOrder()).toEqual([
            ['model::request', { id: 'n1' }],
            ['model::update', { id: 'n1', text: undefined }],
            endRequest
        ]);
        fakeSocket.emit.mockClear();
        note.text = 'later';
        await settle();
        expect(sentInOrder()).toEqual([['model::update', { id: 'n1', text: 'later' }]]);
    });

    it('drops the model when the server answers asking again with model::delete', async () => {
        const { models$, pair } = await registeredLate();
        pair.a = 'mine';
        deliver(fakeSocket, 'reg', { command: 'model::update', payload: server });
        await settle();

        deliver(fakeSocket, 'reg', { command: 'model::delete', payload: { id: 'p1' } });
        pair.b = 'after the delete';
        endOfAnswers(fakeSocket);
        await settle();

        expect(latest(models$)).toEqual([]);
        expect(sentInOrder()).toHaveLength(4);
    });
});

// A connection that dies without closing (Wi-Fi dropping out, say) is noticed by Socket.IO only once
// its ping timeout has run out, and a change sent until then is lost. The answer to asking for the
// model again after the reconnect then had the value from before it, and applying it undid the
// change on this client alone: the server and every other client never saw it.
describe('sending again a change lost in a connection that died', () => {
    const connectSocket = () => {
        for (const [event, handler] of fakeSocket.on.mock.calls) {
            if (event === 'connect') handler();
        }
    };

    const disconnectSocket = () => {
        for (const [event, handler] of fakeSocket.on.mock.calls) {
            if (event === 'disconnect') handler('ping timeout');
        }
    };

    // What every message from the server goes through, the latency probe that comes every 100 ms
    // included: it is how the client knows when it last heard from the server.
    const hearFromServer = () => {
        getAnyHandler(fakeSocket.onAny)('colibri', { command: 'latency', payload: '1' });
    };

    /** Everything emitted on 'own', as [command, payload], in the order it was. */
    const sentInOrder = () =>
        fakeSocket.emit.mock.calls
            .filter(([channel]) => channel === 'own')
            .map(([, msg]) => [(msg as Message).command, (msg as Message).payload]);

    // Long enough for a change a model reported to have been sent: SyncModel buffers for 1ms.
    const settle = () => new Promise(resolve => setTimeout(resolve, 10));

    class Pair extends SyncModel<Pair> {
        @Synced() accessor a = '';
        @Synced() accessor b = '';
    }

    let clock = 1_000_000;
    let debugSpy: ReturnType<typeof vi.spyOn>;
    let nowSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        clock = 1_000_000;
        debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
        nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    });

    afterEach(() => {
        debugSpy.mockRestore();
        nowSpy.mockRestore();
    });

    /**
     * A Colibri with an own Pair 'p1' that the server had nothing for, so it was sent in full
     * (a: 'A', b: 'B'), and then the request for every model answered with it, and the answers
     * over.
     */
    const connectedWithOwnPair = async () => {
        new Colibri('app', 'localhost', 9211);
        const [models$, registerModel] = RegisterModelSync({ name: 'own', type: Pair });
        const pair = new Pair('p1');
        pair.a = 'A';
        pair.b = 'B';
        registerModel(pair);
        connectSocket();
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1' } });
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();
        fakeSocket.emit.mockClear();
        return { models$, pair };
    };

    /** Changes `a` while connected, so that it is sent, and the connection then dies. */
    const sendAndDie = async (pair: Pair, a: string) => {
        fakeSocket.emit.mockClear();
        pair.a = a;
        await settle();
        expect(sentInOrder()).toEqual([['model::update', { id: 'p1', a }]]);
        hearFromServer();
        disconnectSocket();
        connectSocket();
        fakeSocket.emit.mockClear();
    };

    it('keeps and sends again a change when the answer has the value from before it', async () => {
        const { models$, pair } = await connectedWithOwnPair();
        pair.a = 'A2';
        await settle();
        await sendAndDie(pair, 'A3');

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A2', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect([pair.a, pair.b]).toEqual(['A3', 'B']);
        expect(latest(models$)).toEqual([pair]);
        // Sent again, and asked for again to see that the server has it now.
        expect(sentInOrder()).toEqual([
            ['model::update', { id: 'p1', a: 'A3' }],
            ['model::request', { id: 'p1', again: true }]
        ]);

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A3', b: 'B' } });
        endOfAnswers(fakeSocket);
        expect(sentInOrder().slice(2)).toEqual([['model::request', {}]]);
        expect(pair.a).toBe('A3');
    });

    // A model that changes all the time, a tracked pose say, changed again before every answer: the
    // changes made meanwhile went out with one more request each time, so the model stayed asked
    // for, one update a round trip went out, and everything else was never asked for.
    it('asks for every model after asking again once, though the model changed before every answer', async () => {
        const { pair } = await connectedWithOwnPair();
        await sendAndDie(pair, 'A2');
        pair.b = 'B1';
        await settle();
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();
        expect(sentInOrder()).toEqual([
            ['model::update', { id: 'p1', a: 'A2', b: 'B1' }],
            ['model::request', { id: 'p1', again: true }]
        ]);

        pair.b = 'B2';
        await settle();
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A2', b: 'B1' } });
        endOfAnswers(fakeSocket);
        pair.b = 'B3';
        await settle();
        expect([pair.a, pair.b]).toEqual(['A2', 'B3']);
        expect(sentInOrder().slice(2)).toEqual([
            ['model::update', { id: 'p1', b: 'B2' }],
            ['model::request', {}],
            ['model::update', { id: 'p1', b: 'B3' }]
        ]);
    });

    // The value the server last showed this client counts as one from before the change, too.
    it('does so for the first change made after the server last showed the field', async () => {
        const { pair } = await connectedWithOwnPair();
        await sendAndDie(pair, 'A2');

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect(pair.a).toBe('A2');
        expect(sentInOrder()).toEqual([
            ['model::update', { id: 'p1', a: 'A2' }],
            ['model::request', { id: 'p1', again: true }]
        ]);
    });

    it('sends it in one update with a change made while disconnected', async () => {
        const { pair } = await connectedWithOwnPair();
        pair.a = 'A2';
        await settle();
        hearFromServer();
        disconnectSocket();
        pair.b = 'B2';
        await settle();
        connectSocket();
        fakeSocket.emit.mockClear();

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect([pair.a, pair.b]).toEqual(['A2', 'B2']);
        expect(sentInOrder()).toEqual([
            ['model::update', { id: 'p1', a: 'A2', b: 'B2' }],
            ['model::request', { id: 'p1', again: true }]
        ]);
    });

    it('sends nothing when the answer has the last change sent', async () => {
        const { pair } = await connectedWithOwnPair();
        await sendAndDie(pair, 'A2');

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A2', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect(pair.a).toBe('A2');
        expect(sentInOrder()).toEqual([['model::request', {}]]);
    });

    it('takes a value it never had: another client set it while this one was away', async () => {
        const { pair } = await connectedWithOwnPair();
        await sendAndDie(pair, 'A2');

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'theirs', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect(pair.a).toBe('theirs');
        expect(sentInOrder()).toEqual([['model::request', {}]]);
    });

    // The server showed that it had moved on from the change, so the older value is another
    // client's, set again.
    it('takes a value from before the change when the server showed a newer one since', async () => {
        const { pair } = await connectedWithOwnPair();
        pair.a = 'A2';
        await settle();
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'theirs' } });
        hearFromServer();
        disconnectSocket();
        connectSocket();
        fakeSocket.emit.mockClear();

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect(pair.a).toBe('A');
        expect(sentInOrder()).toEqual([['model::request', {}]]);
    });

    // A change followed by more than KNOWN_VALUES_MS of a working connection arrived for certain:
    // the server answering with the value from before it means another client set that again.
    it('takes a value from before a change sent long before the connection stopped working', async () => {
        const { pair } = await connectedWithOwnPair();
        pair.a = 'A2';
        await settle();
        clock += 11_000;
        hearFromServer();
        disconnectSocket();
        // However long Socket.IO took to notice.
        clock += 60_000;
        connectSocket();
        fakeSocket.emit.mockClear();

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect(pair.a).toBe('A');
        expect(sentInOrder()).toEqual([['model::request', {}]]);
    });

    it('counts back from when it last heard from the server, not from when it noticed', async () => {
        const { pair } = await connectedWithOwnPair();
        pair.a = 'A2';
        await settle();
        clock += 9_000;
        hearFromServer();
        // The default ping timeout, 25 s and 20 s, before Socket.IO noticed.
        clock += 45_000;
        disconnectSocket();
        connectSocket();
        fakeSocket.emit.mockClear();

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect(pair.a).toBe('A2');
        expect(sentInOrder()[0]).toEqual(['model::update', { id: 'p1', a: 'A2' }]);
    });

    // Only the answer to asking again after a reconnect: an update relayed from another client is
    // that client's change, made after this one's.
    it('applies an update another client made as it comes, whatever value it has', async () => {
        const { pair } = await connectedWithOwnPair();
        pair.a = 'A2';
        await settle();
        fakeSocket.emit.mockClear();

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A' } });
        await settle();

        expect(pair.a).toBe('A');
        expect(sentInOrder()).toEqual([]);
    });

    // The server relays another client's update to the new connection as it comes, so one made right
    // after the reconnect arrives ahead of the answer. Taken for the answer, it settled the model:
    // the field lost was not in it and never checked, and the answer that followed undid the change.
    it("checks every update until the answers are over, another client's that comes first included", async () => {
        const { pair } = await connectedWithOwnPair();
        await sendAndDie(pair, 'A2');

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', b: 'theirs' } });
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'theirs' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect([pair.a, pair.b]).toEqual(['A2', 'theirs']);
        expect(sentInOrder()).toEqual([
            ['model::update', { id: 'p1', a: 'A2' }],
            ['model::request', { id: 'p1', again: true }]
        ]);
    });

    // Nor may such an update end the outage the change is judged from, when the connection dies again
    // before the answer comes.
    it("still judges from the earlier outage when another client's update came before the next one", async () => {
        const { pair } = await connectedWithOwnPair();
        await sendAndDie(pair, 'A2');
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', b: 'theirs' } });
        clock += 15_000;
        hearFromServer();
        disconnectSocket();
        connectSocket();
        fakeSocket.emit.mockClear();

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'theirs' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect([pair.a, pair.b]).toEqual(['A2', 'theirs']);
        expect(sentInOrder()).toEqual([
            ['model::update', { id: 'p1', a: 'A2' }],
            ['model::request', { id: 'p1', again: true }]
        ]);
    });

    it('still drops the model when the answer is model::delete', async () => {
        const { models$, pair } = await connectedWithOwnPair();
        await sendAndDie(pair, 'A2');

        deliver(fakeSocket, 'own', { command: 'model::delete', payload: { id: 'p1' } });
        await settle();

        expect(latest(models$)).toEqual([]);
        expect(sentInOrder()).toEqual([['model::request', {}]]);
    });

    // Each RegisterModelSync sends its own request after its re-requests, so the answer to the one
    // sent first comes ahead of the answers to the next one's re-requests. Taken for the end of those,
    // it settled the model early, and the answer that came next undid the change.
    it('waits for the end of its own answers when another RegisterModelSync asked again first', async () => {
        new Colibri('app', 'localhost', 9211);
        const [, registerOther] = RegisterModelSync({ name: 'other', type: Pair });
        const [, registerModel] = RegisterModelSync({ name: 'own', type: Pair });
        registerOther(new Pair('q1'));
        const pair = new Pair('p1');
        pair.a = 'A';
        pair.b = 'B';
        registerModel(pair);
        connectSocket();
        deliver(fakeSocket, 'other', { command: 'model::update', payload: { id: 'q1' } });
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1' } });
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();
        await sendAndDie(pair, 'A2');
        expect(fakeSocket.endMarkers).toHaveLength(2);

        deliver(fakeSocket, 'other', { command: 'model::update', payload: { id: 'q1', a: '', b: '' } });
        endOfAnswers(fakeSocket, 1);
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect(pair.a).toBe('A2');
        expect(sentInOrder()).toEqual([
            ['model::update', { id: 'p1', a: 'A2' }],
            ['model::request', { id: 'p1', again: true }]
        ]);
    });

    // detach() stops this client sending the model's changes, a lost one sent again among them.
    it('sends nothing for a model whose detach() was called before the answers are over', async () => {
        const { models$, pair } = await connectedWithOwnPair();
        await sendAndDie(pair, 'A2');

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        pair.detach();
        endOfAnswers(fakeSocket);
        await settle();

        expect(latest(models$)).toEqual([pair]);
        expect(sentInOrder()).toEqual([['model::request', {}]]);
    });

    it('sends nothing for a model whose detach() was called before the answer came', async () => {
        const { models$, pair } = await connectedWithOwnPair();
        await sendAndDie(pair, 'A2');

        pair.detach();
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect(sentInOrder()).toEqual([['model::request', {}]]);
        expect(latest(models$)).toEqual([pair]);
        expect(pair.a).toBe('A');
    });

    it('sends it again after another reconnect when the update sending it again was lost too', async () => {
        const { pair } = await connectedWithOwnPair();
        await sendAndDie(pair, 'A2');
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();
        hearFromServer();
        disconnectSocket();
        connectSocket();
        fakeSocket.emit.mockClear();

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect(pair.a).toBe('A2');
        expect(sentInOrder()).toEqual([
            ['model::update', { id: 'p1', a: 'A2' }],
            ['model::request', { id: 'p1', again: true }]
        ]);
    });

    // The connection died again before the answer to asking again came, long after the change: the
    // change is still judged from when this client last heard from the server before the first.
    it('sends it again when the connection dies again before the answer comes', async () => {
        const { pair } = await connectedWithOwnPair();
        await sendAndDie(pair, 'A2');
        clock += 15_000;
        hearFromServer();
        disconnectSocket();
        connectSocket();
        fakeSocket.emit.mockClear();

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect(pair.a).toBe('A2');
        expect(sentInOrder()).toEqual([
            ['model::update', { id: 'p1', a: 'A2' }],
            ['model::request', { id: 'p1', again: true }]
        ]);
    });

    // The answer came only after a while, and the update sending the change again was lost in a
    // connection that died soon after: the value that answer had tells, however long before the
    // change itself was made.
    it('sends it again when the update sending it again is lost long after the change', async () => {
        const { pair } = await connectedWithOwnPair();
        await sendAndDie(pair, 'A2');
        clock += 15_000;
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();
        expect(sentInOrder()[0]).toEqual(['model::update', { id: 'p1', a: 'A2' }]);
        hearFromServer();
        disconnectSocket();
        connectSocket();
        fakeSocket.emit.mockClear();

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect(pair.a).toBe('A2');
        expect(sentInOrder()).toEqual([
            ['model::update', { id: 'p1', a: 'A2' }],
            ['model::request', { id: 'p1', again: true }]
        ]);
    });

    /** Changes `a` to each of `values` in turn, `apart` ms apart, hearing nothing from the server. */
    const changeWithoutHearing = async (pair: Pair, values: string[], apart: number) => {
        for (const a of values) {
            clock += apart;
            pair.a = a;
            await settle();
        }
    };

    /** Socket.IO noticing the dead connection, once its ping timeout has run out, and connecting again. */
    const noticeAndReconnect = () => {
        clock += 45_000;
        disconnectSocket();
        connectSocket();
        fakeSocket.emit.mockClear();
    };

    /** What a field shows while `word` is typed into it, one key at a time. */
    const typing = (word: string) => Array.from(word, (_, i) => word.slice(0, i + 1));
    const WORD = 'typed one key at a time';

    // Every change made until Socket.IO notices is sent into the dead link, each key typed included,
    // so the value the server has may be many changes back by then.
    it.each([
        ['as fast as they come', 1],
        ['one a second', 1_000]
    ])('does so after many more changes went into the dead link, %s', async (_, apart) => {
        const { pair } = await connectedWithOwnPair();
        pair.a = 'A2';
        await settle();
        hearFromServer();
        await changeWithoutHearing(pair, typing(WORD), apart);
        noticeAndReconnect();

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A2', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect(pair.a).toBe(WORD);
        expect(sentInOrder()).toEqual([
            ['model::update', { id: 'p1', a: WORD }],
            ['model::request', { id: 'p1', again: true }]
        ]);
    });

    // The latency probe comes every 100 ms, so a connection stops working at most about that long
    // after the server was last heard from, and a change sent in between may still have reached it.
    it('does so when the server got a change sent after it was last heard from', async () => {
        const { pair } = await connectedWithOwnPair();
        hearFromServer();
        await changeWithoutHearing(pair, ['A2'], 50);
        await changeWithoutHearing(pair, typing(WORD), 100);
        noticeAndReconnect();

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A2', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect(pair.a).toBe(WORD);
        expect(sentInOrder()).toEqual([
            ['model::update', { id: 'p1', a: WORD }],
            ['model::request', { id: 'p1', again: true }]
        ]);
    });
});
