import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('socket.io-client', () => ({
    connect: vi.fn()
}));

import { connect } from 'socket.io-client';
import { PROTOCOL_VERSION } from '../src/Colibri';
import type * as ColibriModule from '../src/Colibri';
import type * as ColibriErrorModule from '../src/ColibriError';
import { type FakeSocket, getHandler, makeFakeSocket } from './support/fakeSocket';

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

let fakeSocket: FakeSocket;

beforeEach(async () => {
    vi.resetModules();
    ({ Colibri, DeleteRestApi, GetRestApi, PutRestApi, RegisterChannel, RegisterOnce, SendMessage, UnregisterChannel } =
        await import('../src/Colibri'));
    ({ ColibriError } = await import('../src/ColibriError'));
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
