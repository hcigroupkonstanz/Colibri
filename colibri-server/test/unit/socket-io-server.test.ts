import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import { Subscription, filter, firstValueFrom, tap } from 'rxjs';
import { io as connectClient, Socket as ClientSocket } from 'socket.io-client';
import { SocketIoClient, SocketIOServer } from '../../src/server/modules/networking/socket-io-server.js';
import { MAX_FRAME_LENGTH, PROTOCOL_VERSION, encodeMessageFrame } from '../../src/server/modules/networking/protocol.js';
import { MAX_HELD_OBJECTS } from '../../src/server/modules/networking/inbound-limits.js';
import { Service } from '../../src/server/modules/core/service.js';
import { LogLevel, LogMessage } from '../../src/server/modules/core/log-message.js';
import { NetworkClient, NetworkMessage } from '../../src/server/modules/command-hooks/connection-pool.js';
import { TrustProxy, compileTrustedProxies } from '../../src/server/modules/networking/trusted-proxies.js';

interface ColibriEvent {
    command: string;
    payload: Record<string, unknown>;
}

// A real Socket.IO server on an ephemeral loopback port, and real socket.io-client connections:
// the behaviour under test is what a browser actually receives, in what order, and whether it
// stays connected - none of which a mocked Socket.IO would show.
describe('SocketIOServer', () => {
    let http: HttpServer;
    let server: SocketIOServer;
    let port: number;
    let clients: ClientSocket[];
    let logs: LogMessage[];
    let logSubscription: Subscription;
    let connected: NetworkClient[];

    beforeEach(async () => {
        http = createServer();
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        port = (http.address() as AddressInfo).port;

        server = new SocketIOServer();
        server.start(http);

        clients = [];
        logs = [];
        logSubscription = Service.output$.subscribe(msg => logs.push(msg));
        connected = [];
        server.clientConnected$.subscribe(c => connected.push(c));
    });

    afterEach(async () => {
        logSubscription.unsubscribe();
        for (const client of clients) client.disconnect();
        // Closes the HTTP server too.
        server.stop();
        await new Promise(resolve => http.once('close', resolve));
    });

    const connect = function (
        query: Record<string, string>,
        transport: 'websocket' | 'polling' = 'websocket'
    ): { socket: ClientSocket; colibri: ColibriEvent[] } {
        const socket = connectClient(`http://127.0.0.1:${port}`, {
            query,
            transports: [transport],
            reconnection: false,
            forceNew: true,
        });
        clients.push(socket);

        const colibri: ColibriEvent[] = [];
        socket.on('colibri', (msg: ColibriEvent) => colibri.push(msg));
        return { socket, colibri };
    };

    const disconnectReason = function (socket: ClientSocket): Promise<string> {
        return new Promise(resolve => socket.once('disconnect', reason => resolve(reason)));
    };

    const nextColibriEvent = function (socket: ClientSocket): Promise<ColibriEvent> {
        return new Promise(resolve => socket.once('colibri', (msg: ColibriEvent) => resolve(msg)));
    };

    const logged = (level: LogLevel): string[] => logs.filter(l => l.level === level).map(l => l.message);

    describe('a client announcing another protocol version', () => {
        it('is told why and then disconnected', async () => {
            const { socket, colibri } = connect({ app: 'appA', version: '1' });

            expect(await disconnectReason(socket)).toBe('io server disconnect');

            expect(colibri).toHaveLength(1);
            expect(colibri[0]?.command).toBe('protocol::rejected');
            expect(colibri[0]?.payload).toMatchObject({ serverVersion: PROTOCOL_VERSION, clientVersion: '1' });
            expect(String(colibri[0]?.payload.reason)).toContain(`v${PROTOCOL_VERSION}`);
        });

        it('never joins: not listed, not announced as connected', async () => {
            const { socket } = connect({ app: 'appA', version: '1' });
            await disconnectReason(socket);

            expect(server.currentClients).toEqual([]);
            expect(connected).toEqual([]);
            expect(server.hasRecipients('appA')).toBe(false);
            expect(logged(LogLevel.Error).some(m => m.includes('Refusing client'))).toBe(true);
        });

        // so that the admin UI lists the refusal under the app, also when it shows only that app
        it('is logged with its app', async () => {
            const { socket } = connect({ app: 'appA', version: '1' });
            await disconnectReason(socket);

            const refusal = logs.find(l => l.message.includes('Refusing client'));
            expect(refusal?.metadata).toMatchObject({ clientApp: 'appA', clientId: expect.any(String) });
        });
    });

    describe('a client announcing no protocol version', () => {
        it('is refused and disconnected', async () => {
            const { socket, colibri } = connect({ app: 'appA' });

            expect(await disconnectReason(socket)).toBe('io server disconnect');
            expect(colibri.map(e => e.command)).toEqual(['protocol::rejected']);
            expect(colibri[0]?.payload).toMatchObject({ serverVersion: PROTOCOL_VERSION });
            expect(connected).toEqual([]);
        });

        // protocol.md documents clientVersion as a string; an undefined version used to vanish
        // from the JSON, leaving a client that reads it with nothing to report.
        it('is sent its version back as an empty string, not left out', async () => {
            const { socket, colibri } = connect({ app: 'appA' });
            await disconnectReason(socket);

            expect(colibri[0]?.payload).toHaveProperty('clientVersion', '');
            expect(String(colibri[0]?.payload.reason)).toContain('(none)');
        });
    });

    // The admin UI ships with the server, so a mismatch there is a bug to be warned about, not a
    // reason to lock the operator out of their own console.
    describe('the admin UI', () => {
        it('is warned about but accepted when it announces another version', async () => {
            const { socket } = connect({ app: 'colibri', version: '1' });

            const announced = await nextColibriEvent(socket);

            expect(announced.command).toBe('protocol::accepted');
            expect(socket.connected).toBe(true);
            expect(server.currentClients.map(c => c.app)).toEqual(['colibri']);
            expect(logged(LogLevel.Warn).some(m => m.includes('Admin UI client') && m.includes(`v${PROTOCOL_VERSION}`))).toBe(true);
            expect(logged(LogLevel.Error)).toEqual([]);
        });
    });

    describe('a client announcing the supported version', () => {
        it('is told which version this server speaks, before anything else', async () => {
            const { socket } = connect({ app: 'appA', version: PROTOCOL_VERSION });

            const first = await nextColibriEvent(socket);

            expect(first).toEqual({ command: 'protocol::accepted', payload: { serverVersion: PROTOCOL_VERSION } });
            expect(socket.connected).toBe(true);
        });

        // engine.io's default inbound limit (1e6 bytes) disconnected a web client for sending a
        // fifth of what a TCP client may: a frame of up to MAX_FRAME_LENGTH.
        describe.each(['websocket', 'polling'] as const)('over %s', (transport) => {
            const channel = 'appA::big';
            const command = 'broadcast::string';

            // Whichever comes first: the server receiving the message, or the client being
            // dropped for it.
            const send = async function (payloadJsonBytes: number): Promise<{ msg?: NetworkMessage; disconnected?: string }> {
                const { socket } = connect({ app: 'appA', version: PROTOCOL_VERSION }, transport);
                await nextColibriEvent(socket);

                const received = firstValueFrom(server.messages$.pipe(filter(m => m.channel === channel)));
                const dropped = disconnectReason(socket);

                // A JSON string payload: its encoded form is the value plus two quotes.
                socket.emit(channel, { command, payload: 'x'.repeat(payloadJsonBytes - 2) });
                return Promise.race([
                    received.then(msg => ({ msg })),
                    dropped.then(disconnected => ({ disconnected })),
                ]);
            };

            it('accepts a message as large as a TCP client may send', async () => {
                // The payload that fills a TCP frame with this channel and command exactly.
                const payloadBytes = MAX_FRAME_LENGTH - 1 - (2 + channel.length) - (2 + command.length);
                expect(() => encodeMessageFrame({ channel, command, payload: Buffer.alloc(payloadBytes) })).not.toThrow();

                const outcome = await send(payloadBytes);

                expect(outcome.disconnected).toBeUndefined();
                expect(outcome.msg?.payload?.asString()).toHaveLength(payloadBytes);
            });

            it('still disconnects a client that sends far more', async () => {
                const outcome = await send(MAX_FRAME_LENGTH + 512 * 1024);

                expect(outcome.msg).toBeUndefined();
                expect(outcome.disconnected).toBeDefined();
            });
        });

        it('joins its app', async () => {
            const { socket } = connect({ app: 'appA', version: PROTOCOL_VERSION });
            await nextColibriEvent(socket);

            expect(connected.map(c => c.app)).toEqual(['appA']);
            expect(server.hasRecipients('appA')).toBe(true);
            expect(logged(LogLevel.Error)).toEqual([]);
        });

        // The admin log's Connections switch hides these.
        it('tags its connect and disconnect lines as connection lines', async () => {
            const { socket } = connect({ app: 'appA', version: PROTOCOL_VERSION });
            await nextColibriEvent(socket);
            const gone = firstValueFrom(server.clientDisconnected$);
            socket.disconnect();
            await gone;

            const tagged = logs.filter(l => l.metadata.connection === true).map(l => l.message);
            expect(tagged).toEqual([
                expect.stringMatching(/^New client '.+' \(.+\) connected to app "appA"/),
                expect.stringMatching(/^Colibri client '.+' \(.+\) disconnected$/),
            ]);
        });
    });
});

// The same per-client backstop as the TCP worker's, on the Socket.IO path: a web client's runaway
// send loop could otherwise saturate the main thread for everyone.
describe('SocketIOServer rate limit', () => {
    let http: HttpServer;
    let server: SocketIOServer;
    let port: number;
    let clients: ClientSocket[];
    let logs: LogMessage[];
    let logSubscription: Subscription;
    let received: NetworkMessage[];

    const start = async function (rateLimit: { messagesPerSecond: number; burst: number }): Promise<void> {
        http = createServer();
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        port = (http.address() as AddressInfo).port;

        server = new SocketIOServer();
        server.start(http, { rateLimit });
        server.messages$.subscribe(m => received.push(m));
    };

    beforeEach(() => {
        clients = [];
        logs = [];
        received = [];
        logSubscription = Service.output$.subscribe(msg => logs.push(msg));
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        logSubscription.unsubscribe();
        for (const client of clients) client.disconnect();
        server.stop();
        await new Promise(resolve => http.once('close', resolve));
    });

    const connect = async function (app = 'appA'): Promise<ClientSocket> {
        const socket = connectClient(`http://127.0.0.1:${port}`, {
            query: { app, version: PROTOCOL_VERSION },
            transports: ['websocket'],
            reconnection: false,
            forceNew: true,
        });
        clients.push(socket);
        await new Promise(resolve => socket.once('colibri', resolve));
        return socket;
    };

    // Socket.IO delivers a socket's events in order, so once this marker arrives everything sent
    // before it has been through the middleware.
    const flush = async function (socket: ClientSocket): Promise<void> {
        const marker = firstValueFrom(server.messages$.pipe(filter(m => m.channel === 'marker' && m.origin?.id === socket.id)));
        socket.emit('marker', { command: 'flush', payload: {} });
        await marker;
    };

    const from = (socket: ClientSocket, command: string): number =>
        received.filter(m => m.origin?.id === socket.id && m.command === command).length;
    const warnings = (): string[] => logs.filter(l => l.level === LogLevel.Warn).map(l => l.message);

    const eventually = async function (condition: () => boolean, timeoutMillis = 2000): Promise<void> {
        const deadline = Date.now() + timeoutMillis;
        while (!condition()) {
            if (Date.now() > deadline) throw new Error('condition not met in time');
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    };

    // flush() sends a message that is never limited, so it also passes on whatever is held back
    // first: what arrives before it is everything not dropped.
    it('holds back a client\'s model updates past its burst, merged per object, and drops its broadcasts', async () => {
        await start({ messagesPerSecond: 1, burst: 5 });
        const socket = await connect();

        for (let i = 0; i < 5; i++) socket.emit('objects', { command: 'model::update', payload: { id: `o${i}` } });
        socket.emit('objects', { command: 'model::update', payload: { id: 'cube', x: 1 } });
        socket.emit('objects', { command: 'model::update', payload: { id: 'cube', x: 2 } });
        socket.emit('objects', { command: 'model::update', payload: { id: 'cube', isOn: true } });
        for (let i = 0; i < 10; i++) socket.emit('myChannel', { command: 'broadcast::json', payload: { i } });
        await flush(socket);

        const updates = received.filter(m => m.command === 'model::update').map(m => m.payload?.asValue());
        expect(updates).toEqual([{ id: 'o0' }, { id: 'o1' }, { id: 'o2' }, { id: 'o3' }, { id: 'o4' }, { id: 'cube', x: 2, isOn: true }]);
        expect(from(socket, 'broadcast::json')).toBe(0);
        // A burst over in an instant is not worth a warning.
        expect(warnings().filter(w => w.includes('rate limit'))).toEqual([]);
    });

    // The clock the limiter reads is set by hand here: a real second of traffic would make the
    // test slow, and Socket.IO itself does not read performance.now().
    it('warns once a client has been over its limit for a second, naming it', async () => {
        let clock = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => clock);
        await start({ messagesPerSecond: 1, burst: 1 });
        const socket = await connect();

        for (let i = 0; i < 3; i++) socket.emit('myChannel', { command: 'broadcast::json', payload: { i } });
        await flush(socket);
        clock = 999;
        for (let i = 0; i < 2; i++) socket.emit('myChannel', { command: 'broadcast::json', payload: { i } });
        await flush(socket);
        expect(warnings().filter(w => w.includes('more than 1 model::update'))).toEqual([]);

        clock = 1000;
        for (let i = 0; i < 2; i++) socket.emit('myChannel', { command: 'broadcast::json', payload: { i } });
        await flush(socket);

        const limited = warnings().filter(w => w.includes('more than 1 model::update'));
        expect(limited).toHaveLength(1);
        expect(limited[0]).toContain(`Web client ${socket.id}`);
        expect(limited[0]).toContain('app \'appA\'');
    });

    it('passes held updates on as the client\'s rate allows', async () => {
        await start({ messagesPerSecond: 20, burst: 1 });
        const socket = await connect();

        for (let i = 0; i < 3; i++) socket.emit('objects', { command: 'model::update', payload: { id: `o${i}` } });

        await eventually(() => from(socket, 'model::update') === 3);
    });

    it('never limits a request or a delete - nor lets one overtake a held update - and not another client', async () => {
        await start({ messagesPerSecond: 1, burst: 2 });
        const runaway = await connect();
        const neighbour = await connect();

        for (let i = 0; i < 10; i++) runaway.emit('objects', { command: 'model::update', payload: { id: `o${i}` } });
        for (let i = 0; i < 10; i++) runaway.emit('objects', { command: 'model::request', payload: { id: `o${i}` } });
        for (let i = 0; i < 10; i++) runaway.emit('objects', { command: 'model::delete', payload: { id: `o${i}` } });
        neighbour.emit('objects', { command: 'model::update', payload: { id: 'n1' } });
        neighbour.emit('objects', { command: 'model::update', payload: { id: 'n2' } });
        await flush(runaway);
        await flush(neighbour);

        const commands = received.filter(m => m.origin?.id === runaway.id).map(m => m.command);
        expect(commands.slice(0, 10)).toEqual(Array(10).fill('model::update'));
        expect(from(runaway, 'model::request')).toBe(10);
        expect(from(runaway, 'model::delete')).toBe(10);
        expect(from(neighbour, 'model::update')).toBe(2);
    });

    it('limits nothing when turned off', async () => {
        await start({ messagesPerSecond: 0, burst: 1 });
        const socket = await connect();

        for (let i = 0; i < 50; i++) socket.emit('objects', { command: 'model::update', payload: { id: `o${i}` } });
        await flush(socket);

        expect(from(socket, 'model::update')).toBe(50);
        expect(warnings().filter(w => w.includes('rate limit'))).toEqual([]);
    });

    it('passes on what a client held back, and sums up its episode, when it disconnects over the limit', async () => {
        await start({ messagesPerSecond: 1, burst: 1 });
        const socket = await connect();
        const id = socket.id;
        const events: string[] = [];
        server.messages$.subscribe(m => events.push(`${m.command} ${String(m.payload?.asValue<{ id: string }>().id)}`));
        const gone = firstValueFrom(server.clientDisconnected$.pipe(tap(() => events.push('disconnected'))));

        for (let i = 0; i < 4; i++) socket.emit('objects', { command: 'model::update', payload: { id: `o${i}` } });
        socket.disconnect();
        await gone;

        expect(events).toEqual(['model::update o0', 'model::update o1', 'model::update o2', 'model::update o3', 'disconnected']);
        expect(received.every(m => m.origin?.id === id)).toBe(true);
        // Over in an instant, so summed up at debug level.
        expect(warnings().filter(w => w.includes('rate limit'))).toEqual([]);
        expect(logs.filter(l => l.level === LogLevel.Debug).some(l =>
            l.message.includes('disconnected while briefly over the message rate limit; held back 3 model::update(s)'))).toBe(true);
    });

    // Updates for more new objects than can be held back are lost for good; that used to be summed
    // up at debug level when it was over in under a second, below the default log level.
    it('warns about updates it lost, however short the episode', async () => {
        await start({ messagesPerSecond: 1, burst: 1 });
        const socket = await connect();
        const id = socket.id;
        const gone = firstValueFrom(server.clientDisconnected$);

        for (let i = 0; i < 1 + MAX_HELD_OBJECTS + 3; i++) socket.emit('objects', { command: 'model::update', payload: { id: `o${i}` } });
        await flush(socket);
        socket.disconnect();
        await gone;

        expect(received.filter(m => m.origin?.id === id && m.command === 'model::update')).toHaveLength(1 + MAX_HELD_OBJECTS);
        const lost = warnings().filter(w => w.includes('lost 3 model::update(s) for good'));
        expect(lost).toHaveLength(1);
        expect(lost[0]).toContain('disconnected while briefly over the message rate limit');
        expect(lost[0]).toContain(`more objects than the ${MAX_HELD_OBJECTS} one client can have held back at once`);
    });

    // The admin UI's client view. The clock is set by hand, as above: the rates are per second.
    describe('client activity for the admin UI', () => {
        let clock: number;
        const sweep = (now: number) => (server as unknown as { sweepRateLimit(now: number): void }).sweepRateLimit(now);
        const clientOf = (socket: ClientSocket) => server.getClient(socket.id!)!;

        beforeEach(() => {
            clock = 0;
            vi.spyOn(performance, 'now').mockImplementation(() => clock);
        });

        it('counts the messages a client sends, and those it is sent, alone or through its app\'s room', async () => {
            await start({ messagesPerSecond: 0, burst: 1 });
            const sender = await connect();
            const other = await connect();
            await connect('otherApp');

            for (let i = 0; i < 6; i++) sender.emit('objects', { command: 'model::request', payload: {} });
            // A latency echo is not a message, as a heartbeat is not on TCP.
            sender.emit('colibri', { command: 'latency', payload: 1 });
            await flush(sender);
            for (let i = 0; i < 4; i++) {
                server.broadcastToApp({ channel: 'objects', command: 'broadcast::x', origin: clientOf(sender) }, 'appA', sender.id);
            }
            server.broadcastToApp({ channel: 'objects', command: 'broadcast::x' }, 'appA');
            server.broadcast({ channel: 'objects', command: 'model::update' }, [ clientOf(sender), clientOf(sender) ]);
            server.broadcast({ channel: 'colibri', command: 'latency' }, server.currentClients);

            clock = 1000;
            sweep(clock);

            // flush() sent one more, the marker.
            expect(server.activityOf(clientOf(sender))).toEqual({ in: 7, out: 3, limit: null, held: 0 });
            expect(server.activityOf(clientOf(other))).toEqual({ in: 0, out: 5, limit: null, held: 0 });

            clock = 3000;
            sweep(clock);
            expect(server.activityOf(clientOf(sender))).toEqual({ in: 0, out: 0, limit: null, held: 0 });

            // each rate at the Date.now() of its sample
            vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
            expect(server.activityOf(clientOf(sender), true).history).toEqual([ [ 1_699_999_998_000, 7, 3 ], [ 1_700_000_000_000, 0, 0 ] ]);
        });

        it('has no rates for a client connected less than a second ago', async () => {
            await start({ messagesPerSecond: 0, burst: 1 });
            const socket = await connect();
            sweep(500);
            expect(server.activityOf(clientOf(socket))).toEqual({ in: null, out: null, limit: null, held: 0 });
        });

        it('names the rate limit while it holds a client\'s updates back', async () => {
            await start({ messagesPerSecond: 1, burst: 1 });
            const socket = await connect();

            for (let i = 0; i < 4; i++) socket.emit('objects', { command: 'model::update', payload: { id: `o${i}` } });
            socket.emit('myChannel', { command: 'broadcast::json', payload: {} });
            await new Promise(resolve => setTimeout(resolve, 50));
            expect(server.activityOf(clientOf(socket))).toMatchObject({ limit: 'rate', held: 3 });

            // One token a second passes them on; a second later the episode is over.
            for (clock = 1000; clock <= 5000; clock += 1000) sweep(clock);
            expect(server.activityOf(clientOf(socket))).toMatchObject({ limit: null, held: 0 });
        });
    });
});

// Behind a reverse proxy every client comes from the proxy's address; a trusted one names the client
// in X-Forwarded-For. These clients connect from 127.0.0.1, standing in for the proxy.
describe('SocketIOServer behind a reverse proxy', () => {
    let http: HttpServer;
    let server: SocketIOServer;
    let port: number;
    let clients: ClientSocket[];
    let logs: LogMessage[];
    let logSubscription: Subscription;
    let connected: NetworkClient[];

    const start = async function (trustProxy?: TrustProxy): Promise<void> {
        http = createServer();
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        port = (http.address() as AddressInfo).port;

        server = new SocketIOServer();
        server.start(http, { trustProxy });
        server.clientConnected$.subscribe(c => connected.push(c));
    };

    beforeEach(() => {
        clients = [];
        logs = [];
        connected = [];
        logSubscription = Service.output$.subscribe(msg => logs.push(msg));
    });

    afterEach(async () => {
        logSubscription.unsubscribe();
        for (const client of clients) client.disconnect();
        server.stop();
        await new Promise(resolve => http.once('close', resolve));
    });

    const connect = function (
        forwardedFor: string | undefined,
        transport: 'websocket' | 'polling' = 'websocket',
        version = PROTOCOL_VERSION,
        headers: Record<string, string> = {}
    ): Promise<ColibriEvent> {
        const socket = connectClient(`http://127.0.0.1:${port}`, {
            query: { app: 'appA', version },
            transports: [transport],
            extraHeaders: { ...(forwardedFor === undefined ? {} : { 'X-Forwarded-For': forwardedFor }), ...headers },
            reconnection: false,
            forceNew: true,
        });
        clients.push(socket);
        return new Promise(resolve => socket.once('colibri', (msg: ColibriEvent) => resolve(msg)));
    };

    const logged = (level: LogLevel): string[] => logs.filter(l => l.level === level).map(l => l.message);

    describe.each(['websocket', 'polling'] as const)('over %s', (transport) => {
        it('names a client by the right-most address in a trusted proxy\'s X-Forwarded-For', async () => {
            await start(compileTrustedProxies(['loopback']));

            await connect('6.6.6.6, 198.51.100.7', transport);

            expect(connected.map(c => c.name)).toEqual(['198.51.100.7']);
            expect(logged(LogLevel.Debug)).toContainEqual(expect.stringMatching(/^New client '.+' \(.+\) connected to app ".+" from 198\.51\.100\.7 through 127\.0\.0\.1$/));
        });

        it('counts a client as TLS at the proxy when a trusted proxy\'s X-Forwarded-Proto says https', async () => {
            await start(compileTrustedProxies(['loopback']));

            await connect('198.51.100.7', transport, PROTOCOL_VERSION, { 'X-Forwarded-Proto': 'https' });
            await connect('198.51.100.8', transport, PROTOCOL_VERSION, { 'X-Forwarded-Proto': 'http' });

            expect(tlsAtProxy()).toEqual({ '198.51.100.7': true, '198.51.100.8': false });
        });
    });

    const tlsAtProxy = (): Record<string, boolean> =>
        Object.fromEntries((connected as SocketIoClient[]).map(c => [c.name, c.tlsAtProxy]));

    it('ignores X-Forwarded-Proto from a peer it does not trust', async () => {
        await start(compileTrustedProxies(['10.0.0.1']));

        await connect(undefined, 'websocket', PROTOCOL_VERSION, { 'X-Forwarded-Proto': 'https' });

        expect(tlsAtProxy()).toEqual({ '127.0.0.1': false });
    });

    it('takes the scheme the proxy appended, not one the client sent ahead of it', async () => {
        await start(compileTrustedProxies(['loopback']));

        await connect('198.51.100.7', 'websocket', PROTOCOL_VERSION, { 'X-Forwarded-Proto': 'https, http' });
        await connect('198.51.100.8', 'websocket', PROTOCOL_VERSION, { 'X-Forwarded-Proto': 'http, HTTPS' });

        expect(tlsAtProxy()).toEqual({ '198.51.100.7': false, '198.51.100.8': true });
    });

    it('does not count a client as TLS at the proxy without X-Forwarded-Proto', async () => {
        await start(compileTrustedProxies(['loopback']));

        await connect('198.51.100.7');

        expect(tlsAtProxy()).toEqual({ '198.51.100.7': false });
    });

    it('ignores X-Forwarded-For from a peer it does not trust', async () => {
        await start(compileTrustedProxies(['10.0.0.1']));

        await connect('198.51.100.7');

        expect(connected.map(c => c.name)).toEqual(['127.0.0.1']);
        expect(logged(LogLevel.Debug)).toContainEqual(expect.stringMatching(/connected to app ".+" from 127\.0\.0\.1$/));
    });

    it('trusts no proxy unless told to', async () => {
        await start();

        await connect('198.51.100.7');

        expect(connected.map(c => c.name)).toEqual(['127.0.0.1']);
    });

    it('keeps a trusted proxy\'s own address for a client it sends no X-Forwarded-For for', async () => {
        await start(compileTrustedProxies(['loopback']));

        await connect(undefined);

        expect(connected.map(c => c.name)).toEqual(['127.0.0.1']);
    });

    it('names the forwarded address when it refuses a client', async () => {
        await start(compileTrustedProxies(['loopback']));

        const refusal = await connect('198.51.100.7', 'websocket', '1');

        expect(refusal.command).toBe('protocol::rejected');
        expect(logged(LogLevel.Error)).toContainEqual(expect.stringMatching(/^Refusing client .+ from 198\.51\.100\.7: /));
    });
});
