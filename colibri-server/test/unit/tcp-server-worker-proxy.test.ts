import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { once } from 'events';
import { mkdtemp, rm } from 'fs/promises';
import * as net from 'net';
import { tmpdir } from 'os';
import * as path from 'path';
import * as tls from 'tls';
import type * as workerThreads from 'worker_threads';
import type { TcpServerOptions } from '../../src/server/modules/networking/tcp-server-worker.js';
import { TCPServerWorker } from '../../src/server/modules/networking/tcp-server-worker.js';
import type {
    DecodedFrame,
} from '../../src/server/modules/networking/protocol.js';
import {
    FrameReader,
    FrameType,
    PROTOCOL_VERSION,
    encodeHandshakeFrame,
} from '../../src/server/modules/networking/protocol.js';
import { LogLevel } from '../../src/server/modules/core/log-message.js';
import type { TestCertificate } from '../tls-test-certificate.js';
import { createTestCertificate } from '../tls-test-certificate.js';

// See tcp-server-worker.test.ts: inert as a worker, so that it can run in the test's own thread.
vi.mock('worker_threads', async (importOriginal) => {
    const actual = await importOriginal<typeof workerThreads>();
    return { ...actual, isMainThread: true, parentPort: null, workerData: null };
});

interface WorkerInternals {
    server: net.Server | undefined;
    proxyHeaderTimeoutMillis: number;
    proxyHeaderSockets: Set<net.Socket>;
    handleParentMessage(msg: { channel: string; content: Record<string, unknown> }): void;
    postMessage(channel: string, content: Record<string, unknown>): void;
}

// A connection to the worker under test, as a proxy in front of it would open it, that collects
// what it is sent. Every one comes from 127.0.0.1: trusted with TRUSTED_PROXIES=loopback.
class Peer {
    public readonly frames: DecodedFrame[] = [];
    public readonly closed: Promise<void>;
    public received = 0;
    private readonly reader = new FrameReader();

    public constructor(public readonly socket: net.Socket) {
        socket.on('data', (data: Buffer) => {
            this.received += data.length;
            this.frames.push(...this.reader.append(data));
        });
        socket.on('error', () => undefined);
        this.closed = new Promise(resolve => socket.once('close', () => resolve()));
    }

    public send(bytes: Buffer): void {
        this.socket.write(bytes);
    }

    public count(type: FrameType): number {
        return this.frames.filter(frame => frame.type === type).length;
    }
}

const eventually = async function (condition: () => boolean, timeoutMillis = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMillis;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
};

const sleep = (millis: number) => new Promise(resolve => setTimeout(resolve, millis));

const V2_SIGNATURE = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);

const v1 = (source: string, destination = '127.0.0.1'): Buffer =>
    Buffer.from(`PROXY ${net.isIPv6(source) ? 'TCP6' : 'TCP4'} ${source} ${destination} 51234 9212\r\n`, 'latin1');

const v2 = function (versionCommand: number, familyProtocol: number, addresses: Buffer): Buffer {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(addresses.length);
    return Buffer.concat([V2_SIGNATURE, Buffer.from([versionCommand, familyProtocol]), length, addresses]);
};
const v2Proxy4 = (source: number[]): Buffer => v2(0x21, 0x11, Buffer.from([...source, 127, 0, 0, 1, 0xc8, 0x22, 0x23, 0x34]));
const v2Proxy6 = (source: string): Buffer => v2(0x21, 0x21, Buffer.concat([
    Buffer.from(source, 'hex'), Buffer.alloc(15), Buffer.from([1, 0xc8, 0x22, 0x23, 0x34]),
]));
const v2Local = (): Buffer => v2(0x20, 0x00, Buffer.alloc(0));

const handshake = (name = 'quest-1', app = 'appA', version = PROTOCOL_VERSION): Buffer => encodeHandshakeFrame(version, app, name);

describe('TCPServerWorker with TCP_PROXY_PROTOCOL', () => {
    let fixtures: string;
    let certificate: TestCertificate;

    let worker: TCPServerWorker;
    let internals: WorkerInternals;
    let posted: { channel: string; content: Record<string, unknown> }[];
    let port: number;
    let peers: Peer[];

    const logs = (level: LogLevel): string[] =>
        posted.filter(p => p.channel === 'log' && p.content.level === level).map(p => String(p.content.msg));
    const connectedClients = () => posted.filter(p => p.channel === 'clientConnected$').map(p => p.content);
    const proxyWarnings = (): string[] => logs(LogLevel.Warn).filter(w => w.includes('PROXY protocol'));

    // Through 'm:start', as TCPServerProxy starts it.
    const start = async function (options: TcpServerOptions): Promise<void> {
        internals.handleParentMessage({
            channel: 'm:start',
            content: { port: 0, host: '127.0.0.1', options: { idleTimeoutMillis: 0, ...options } },
        });
        await once(internals.server!, 'listening');
        port = (internals.server!.address() as net.AddressInfo).port;
    };

    const connect = async function (): Promise<Peer> {
        const socket = net.connect(port, '127.0.0.1');
        socket.setNoDelay(true);
        const peer = new Peer(socket);
        peers.push(peer);
        await once(socket, 'connect');
        return peer;
    };

    // The log line handleConnection writes for a new client: whom it names and how it came.
    const newClientLines = (): string[] => logs(LogLevel.Debug).filter(l => l.startsWith('New client'));

    beforeAll(async () => {
        fixtures = await mkdtemp(path.join(tmpdir(), 'colibri-tcp-proxy-'));
        certificate = createTestCertificate(fixtures, 'proxied');
    });

    afterAll(async () => {
        await rm(fixtures, { recursive: true, force: true });
    });

    beforeEach(() => {
        worker = new TCPServerWorker();
        internals = worker as unknown as WorkerInternals;
        posted = [];
        peers = [];
        vi.spyOn(internals, 'postMessage').mockImplementation((channel, content) => {
            posted.push({ channel, content });
        });
    });

    afterEach(async () => {
        for (const peer of peers) peer.socket.destroy();
        const closed = internals.server ? once(internals.server, 'close') : Promise.resolve();
        worker.stop();
        await closed;
        vi.restoreAllMocks();
    });

    describe('from a trusted proxy', () => {
        beforeEach(async () => {
            await start({ proxyProtocol: true, trustedProxies: ['loopback'] });
        });

        it('says so at startup', () => {
            expect(logs(LogLevel.Info)).toContain(
                'Starting Colibri TCP server on 127.0.0.1:0, PROXY protocol header required from TRUSTED_PROXIES (loopback)'
            );
        });

        it('takes the client\'s address from a version 1 header, for every log line about it', async () => {
            const peer = await connect();
            peer.send(Buffer.concat([v1('198.51.100.7'), handshake('quest-1', 'appA', '1')]));

            await peer.closed;
            expect(newClientLines()).toHaveLength(1);
            expect(newClientLines()[0]).toMatch(/^New client \(.+\) connected from 198\.51\.100\.7 through 127\.0\.0\.1, waiting for app name$/);
            expect(logs(LogLevel.Error)).toContainEqual(expect.stringMatching(/^Refusing client 'quest-1' \(.+, 198\.51\.100\.7\): Unsupported protocol version/));
            expect(logs(LogLevel.Debug)).toContain('Colibri client 198.51.100.7 disconnected');
        });

        it('does not count its clients as TLS at the proxy without TCP_TLS_AT_PROXY', async () => {
            const peer = await connect();
            peer.send(Buffer.concat([v1('198.51.100.7'), handshake()]));

            await eventually(() => peer.count(FrameType.Heartbeat) > 0);
            expect(connectedClients()).toMatchObject([{ address: '198.51.100.7', tls: false, tlsAtProxy: false }]);
        });

        it('takes it from a version 2 header, IPv4 or IPv6', async () => {
            const ipv4 = await connect();
            ipv4.send(Buffer.concat([v2Proxy4([198, 51, 100, 8]), handshake('quest-4')]));
            const ipv6 = await connect();
            ipv6.send(Buffer.concat([v2Proxy6('20010db8000000000000000000000009'), handshake('quest-6')]));

            await eventually(() => ipv4.count(FrameType.Heartbeat) > 0 && ipv6.count(FrameType.Heartbeat) > 0);
            expect(connectedClients().map(c => c.name).sort()).toEqual(['quest-4', 'quest-6']);
            expect(newClientLines().map(l => l.replace(/\(.+?\) /, '')).sort()).toEqual([
                'New client connected from 198.51.100.8 through 127.0.0.1, waiting for app name',
                'New client connected from 2001:db8::9 through 127.0.0.1, waiting for app name',
            ]);
        });

        // A proxy on a dual-stack socket may put an IPv4 client into a version 2 IPv6 header.
        it('names a client by its IPv4 address from an IPv4-mapped address in a version 2 header', async () => {
            const mapped = await connect();
            mapped.send(Buffer.concat([v2Proxy6('00000000000000000000ffffc6336407'), handshake('quest-mapped')]));

            await eventually(() => mapped.count(FrameType.Heartbeat) > 0);
            expect(connectedClients().map(c => c.address)).toEqual(['198.51.100.7']);
            expect(newClientLines().map(l => l.replace(/\(.+?\) /, ''))).toEqual([
                'New client connected from 198.51.100.7 through 127.0.0.1, waiting for app name',
            ]);
        });

        it('reads a header that arrives a few bytes at a time, and what follows it in the same read', async () => {
            const peer = await connect();
            const bytes = Buffer.concat([v1('198.51.100.7'), handshake()]);
            // Splits the header, and the last chunk holds its end and the start of the handshake.
            for (const [from, to] of [[0, 1], [1, 6], [6, 20], [20, 50], [50, bytes.length]] as const) {
                peer.send(bytes.subarray(from, to));
                await sleep(20);
            }

            await eventually(() => peer.count(FrameType.Heartbeat) > 0);
            expect(connectedClients()).toMatchObject([{ app: 'appA', name: 'quest-1' }]);
            expect(newClientLines()[0]).toContain('connected from 198.51.100.7 through 127.0.0.1');
            expect(proxyWarnings()).toEqual([]);
        });

        it('keeps the proxy\'s own address for a version 2 LOCAL header or a version 1 UNKNOWN one', async () => {
            const local = await connect();
            local.send(Buffer.concat([v2Local(), handshake('local')]));
            const unknown = await connect();
            unknown.send(Buffer.concat([Buffer.from('PROXY UNKNOWN\r\n', 'latin1'), handshake('unknown')]));

            await eventually(() => local.count(FrameType.Heartbeat) > 0 && unknown.count(FrameType.Heartbeat) > 0);
            expect(newClientLines().map(l => l.replace(/\(.+?\) /, ''))).toEqual([
                'New client connected from 127.0.0.1, waiting for app name',
                'New client connected from 127.0.0.1, waiting for app name',
            ]);
        });

        it('is refused without a header, with a warning once a minute that says what to change', async () => {
            for (let i = 0; i < 3; i++) {
                const peer = await connect();
                peer.send(handshake());
                await peer.closed;
                expect(peer.received).toBe(0);
            }

            expect(connectedClients()).toEqual([]);
            expect(proxyWarnings()).toHaveLength(1);
            expect(proxyWarnings()[0]).toBe(
                'Refusing a connection from 127.0.0.1: it is in TRUSTED_PROXIES and TCP_PROXY_PROTOCOL is true, but the ' +
                    'connection does not start with a PROXY protocol header. Turn on the PROXY protocol for this port in the ' +
                    'proxy (nginx: proxy_protocol on; in its stream server). A client that connects directly from an address ' +
                    'in TRUSTED_PROXIES is refused like this too. This is logged at most once a minute per address.'
            );
            expect(logs(LogLevel.Debug).filter(l => l.includes('warned about this address already'))).toHaveLength(2);
            expect(logs(LogLevel.Error)).toEqual([]);
        });

        it.each([
            ['malformed', Buffer.from('PROXY TCP4 198.51.100.7 127.0.0.1 51234\r\n', 'latin1'), 'malformed version 1 header'],
            ['a version 1 header without CRLF', Buffer.from(`PROXY UNKNOWN ${'x'.repeat(200)}`, 'latin1'), 'CRLF within 107 bytes'],
            ['a version 2 header over 4 KiB', v2(0x21, 0x11, Buffer.alloc(4097)), '4097 bytes after the first 16'],
        ])('is refused for a header that is %s', async (_what, header, problem) => {
            const peer = await connect();
            peer.send(Buffer.concat([header, handshake()]));

            await peer.closed;
            expect(peer.received).toBe(0);
            expect(connectedClients()).toEqual([]);
            expect(proxyWarnings()).toHaveLength(1);
            expect(proxyWarnings()[0]).toMatch(/^Refusing a connection from 127\.0\.0\.1: its PROXY protocol header is invalid: /);
            expect(proxyWarnings()[0]).toContain(problem);
        });

        it('is refused when the header does not arrive in time', async () => {
            internals.proxyHeaderTimeoutMillis = 200;
            const peer = await connect();
            peer.send(v1('198.51.100.7').subarray(0, 20));

            await peer.closed;
            expect(proxyWarnings()).toHaveLength(1);
            expect(proxyWarnings()[0]).toContain('sent no complete PROXY protocol header within 0.2 s');
        });

        it('leaves nothing behind, and is ended on stop', async () => {
            const gone = await connect();
            gone.send(v1('198.51.100.7').subarray(0, 10));
            await eventually(() => internals.proxyHeaderSockets.size === 1);
            gone.socket.destroy();
            await eventually(() => internals.proxyHeaderSockets.size === 0);

            const waiting = await connect();
            await eventually(() => internals.proxyHeaderSockets.size === 1);
            worker.stop();

            await waiting.closed;
            expect(internals.proxyHeaderSockets.size).toBe(0);
        });
    });

    describe('with TCP_TLS_AT_PROXY', () => {
        const tlsAtProxy = () => Object.fromEntries(connectedClients().map(c => [ c.name, c.tlsAtProxy ]));

        it('counts a client through a trusted proxy as TLS at the proxy, whatever address its header names', async () => {
            await start({ proxyProtocol: true, trustedProxies: ['loopback'], tlsAtProxy: true });
            expect(logs(LogLevel.Info)).toContain(
                'Starting Colibri TCP server on 127.0.0.1:0, PROXY protocol header required from TRUSTED_PROXIES (loopback), ' +
                    'TLS terminated by proxy (TCP_TLS_AT_PROXY)'
            );

            const named = await connect();
            named.send(Buffer.concat([v1('198.51.100.7'), handshake('named')]));
            const unknown = await connect();
            unknown.send(Buffer.concat([Buffer.from('PROXY UNKNOWN\r\n', 'latin1'), handshake('unknown')]));

            await eventually(() => named.count(FrameType.Heartbeat) > 0 && unknown.count(FrameType.Heartbeat) > 0);
            expect(tlsAtProxy()).toEqual({ named: true, unknown: true });
            expect(connectedClients().every(c => c.tls === false)).toBe(true);
        });

        it('does not count a direct connection from a peer that is not a trusted proxy', async () => {
            await start({ proxyProtocol: true, trustedProxies: ['10.0.0.1'], tlsAtProxy: true });

            const direct = await connect();
            direct.send(handshake('direct'));

            await eventually(() => direct.count(FrameType.Heartbeat) > 0);
            expect(tlsAtProxy()).toEqual({ direct: false });
        });

        it('counts nobody without TCP_PROXY_PROTOCOL, and does not say so at startup', async () => {
            await start({ trustedProxies: ['loopback'], tlsAtProxy: true });
            expect(logs(LogLevel.Info)).toContain('Starting Colibri TCP server on 127.0.0.1:0');

            const peer = await connect();
            peer.send(handshake('plain'));

            await eventually(() => peer.count(FrameType.Heartbeat) > 0);
            expect(tlsAtProxy()).toEqual({ plain: false });
        });

        // A proxy that passes TLS through to the server's own, or ends it and starts it again.
        it('counts a TLS client through the proxy too, by the TCP connection underneath', async () => {
            await start({ proxyProtocol: true, trustedProxies: ['loopback'], tlsAtProxy: true, tls: { cert: certificate.cert, key: certificate.key } });

            const tcp = await connect();
            tcp.send(v1('198.51.100.7'));
            const socket = tls.connect({ socket: tcp.socket, servername: 'localhost', ca: [ certificate.cert ] });
            const peer = new Peer(socket);
            peers.push(peer);
            await once(socket, 'secureConnect');
            peer.send(handshake('tls-quest'));

            await eventually(() => peer.count(FrameType.Heartbeat) > 0);
            expect(connectedClients()).toMatchObject([{ name: 'tls-quest', tls: true, tlsAtProxy: true }]);
        });
    });

    describe('from a peer that is not a trusted proxy', () => {
        beforeEach(async () => {
            await start({ proxyProtocol: true, trustedProxies: ['10.0.0.1', 'uniquelocal'] });
        });

        it('is refused when it sends a header, so that it cannot choose its own address', async () => {
            for (const header of [v1('198.51.100.7'), v2Proxy4([198, 51, 100, 7]), Buffer.from('PROXY nonsense\r\n', 'latin1')]) {
                const peer = await connect();
                peer.send(Buffer.concat([header, handshake()]));
                await peer.closed;
            }

            expect(connectedClients()).toEqual([]);
            expect(newClientLines()).toEqual([]);
            expect(proxyWarnings()).toEqual([
                'Refusing a connection from 127.0.0.1: it starts with a PROXY protocol header, but its address is not in ' +
                    'TRUSTED_PROXIES. If it is the proxy in front of this server, add its address to TRUSTED_PROXIES. This is ' +
                    'logged at most once a minute per address.',
            ]);
        });

        it('connects without a header as it would without TCP_PROXY_PROTOCOL, its first byte on its own or not', async () => {
            const whole = await connect();
            whole.send(handshake('whole'));
            // A handshake frame 0x50 bytes long, which starts with a P, as PROXY does.
            const name = 'p'.repeat(0x50 - 1 - `${PROTOCOL_VERSION}::appA::`.length);
            const bytes = handshake(name);
            expect(bytes.subarray(0, 2)).toEqual(Buffer.from('P\0', 'latin1'));
            const split = await connect();
            split.send(bytes.subarray(0, 1));
            await sleep(20);
            split.send(bytes.subarray(1));

            await eventually(() => whole.count(FrameType.Heartbeat) > 0 && split.count(FrameType.Heartbeat) > 0);
            expect(connectedClients().map(c => c.name).sort()).toEqual([name, 'whole']);
            expect(newClientLines().every(l => l.endsWith('connected from 127.0.0.1, waiting for app name'))).toBe(true);
            expect(logs(LogLevel.Warn)).toEqual([]);
        });

        it('is disconnected quietly when it sends nothing in time', async () => {
            internals.proxyHeaderTimeoutMillis = 200;
            const peer = await connect();

            await peer.closed;
            expect(logs(LogLevel.Debug)).toContain('Disconnecting 127.0.0.1: it sent nothing within 0.2 s of connecting');
            expect(logs(LogLevel.Warn)).toEqual([]);
        });
    });

    describe('without TCP_PROXY_PROTOCOL', () => {
        it('reads no header even from a trusted proxy, as before', async () => {
            await start({ trustedProxies: ['loopback'] });
            expect(logs(LogLevel.Info)).toContain('Starting Colibri TCP server on 127.0.0.1:0');

            const plain = await connect();
            plain.send(handshake());
            await eventually(() => plain.count(FrameType.Heartbeat) > 0);
            const proxied = await connect();
            proxied.send(Buffer.concat([v1('198.51.100.7'), handshake()]));
            await proxied.closed;

            expect(newClientLines().every(l => l.endsWith('connected from 127.0.0.1, waiting for app name'))).toBe(true);
            expect(logs(LogLevel.Error)).toContainEqual(expect.stringMatching(/^Invalid frame from client .+: Invalid frame length: 1481593424$/));
            expect(internals.proxyHeaderSockets.size).toBe(0);
        });
    });

    describe('with TLS', () => {
        beforeEach(async () => {
            await start({ proxyProtocol: true, trustedProxies: ['loopback'], tls: { cert: certificate.cert, key: certificate.key } });
        });

        // Over a connection that has sent the header already, as a proxy does before it relays the
        // client's ClientHello.
        const connectTls = async function (header: Buffer, options: tls.ConnectionOptions = { ca: [ certificate.cert ] }): Promise<Peer> {
            const tcp = await connect();
            tcp.send(header);
            const socket = tls.connect({ socket: tcp.socket, servername: 'localhost', ...options });
            const peer = new Peer(socket);
            peers.push(peer);
            return peer;
        };

        it('reads the header ahead of the TLS handshake', async () => {
            const peer = await connectTls(v1('198.51.100.7'));
            await once(peer.socket, 'secureConnect');
            peer.send(handshake('tls-quest'));

            await eventually(() => peer.count(FrameType.Heartbeat) > 0);
            expect(connectedClients()).toMatchObject([{ name: 'tls-quest' }]);
            expect(newClientLines()[0]).toContain('connected from 198.51.100.7 through 127.0.0.1');
            expect(logs(LogLevel.Info)).toContain(
                'Starting Colibri TCP server on 127.0.0.1:0, TLS only, PROXY protocol header required from TRUSTED_PROXIES (loopback)'
            );
        });

        it('names the client when its TLS handshake fails', async () => {
            // Trusts no self-signed certificate.
            const peer = await connectTls(v1('198.51.100.7'), {});
            await peer.closed;

            await eventually(() => logs(LogLevel.Info).some(l => l.startsWith('TLS handshake with')));
            expect(logs(LogLevel.Info).find(l => l.startsWith('TLS handshake with'))).toContain('TLS handshake with 198.51.100.7 failed');
        });

        it('names the client when it does not use TLS', async () => {
            const peer = await connect();
            peer.send(Buffer.concat([v1('198.51.100.7'), handshake('plain-quest', 'MyApp')]));

            await peer.closed;
            const [warning] = logs(LogLevel.Warn);
            expect(warning).toContain('Refusing a connection from 198.51.100.7 (Unity client \'plain-quest\', app \'MyApp\'): it does not use TLS');
        });

        it('is refused for a TLS handshake without a header', async () => {
            const tcp = await connect();
            const socket = tls.connect({ socket: tcp.socket, servername: 'localhost', ca: [ certificate.cert ] });
            const peer = new Peer(socket);
            peers.push(peer);

            await peer.closed;
            expect(proxyWarnings()).toHaveLength(1);
            expect(proxyWarnings()[0]).toContain('does not start with a PROXY protocol header');
        });
    });
});
