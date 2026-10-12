import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { once } from 'events';
import { mkdtemp, rm } from 'fs/promises';
import * as net from 'net';
import { networkInterfaces, tmpdir } from 'os';
import * as path from 'path';
import * as tls from 'tls';
import { TCPServerWorker, TcpServerOptions } from '../../src/server/modules/networking/tcp-server-worker.js';
import {
    DecodedFrame,
    FrameReader,
    FrameType,
    PROTOCOL_VERSION,
    encodeHandshakeFrame,
    encodeHeartbeatFrame,
    encodeMessageFrame,
} from '../../src/server/modules/networking/protocol.js';
import { LogLevel } from '../../src/server/modules/core/log-message.js';
import { TestCertificate, createTestCertificate } from '../tls-test-certificate.js';

// See tcp-server-worker.test.ts: inert as a worker, so that it can run in the test's own thread.
vi.mock('worker_threads', async (importOriginal) => {
    const actual = await importOriginal<typeof import('worker_threads')>();
    return { ...actual, isMainThread: true, parentPort: null, workerData: null };
});

interface WorkerInternals {
    server: net.Server | undefined;
    tlsHandshakeTimeoutMillis: number;
    tlsPortSockets: Set<net.Socket>;
    handleParentMessage(msg: { channel: string; content: Record<string, unknown> }): void;
    postMessage(channel: string, content: Record<string, unknown>): void;
}

// A TCP client of the worker under test, encrypted or not, that collects what it is sent.
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

    public send(frame: Buffer): void {
        this.socket.write(frame);
    }

    public handshake(app = 'tls-app', name = 'tls-client'): void {
        this.send(encodeHandshakeFrame(PROTOCOL_VERSION, app, name));
    }

    public count(type: FrameType): number {
        return this.frames.filter(frame => frame.type === type).length;
    }
}

const hasIPv6Loopback = Object.values(networkInterfaces()).some(addresses => addresses?.some(a => a.address === '::1'));

const eventually = async function (condition: () => boolean, timeoutMillis = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMillis;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
};

describe('TCPServerWorker with TLS', () => {
    let fixtures: string;
    let first: TestCertificate;
    let second: TestCertificate;

    let worker: TCPServerWorker;
    let internals: WorkerInternals;
    let posted: { channel: string; content: Record<string, unknown> }[];
    let port: number;
    let peers: Peer[];

    const logs = (level: LogLevel): string[] =>
        posted.filter(p => p.channel === 'log' && p.content.level === level).map(p => String(p.content.msg));

    const start = async function (options: TcpServerOptions, host = '127.0.0.1'): Promise<void> {
        worker.configure({ idleTimeoutMillis: 0, ...options });
        worker.start(0, host);
        await once(internals.server!, 'listening');
        port = (internals.server!.address() as net.AddressInfo).port;
    };

    // Trusts both certificates, so that it connects whichever one it is served.
    const connectTls = async function (options: tls.ConnectionOptions = {}): Promise<Peer> {
        const socket = tls.connect({ host: '127.0.0.1', port, servername: 'localhost', ca: [ first.cert, second.cert ], ...options });
        const peer = new Peer(socket);
        peers.push(peer);
        await once(socket, 'secureConnect');
        return peer;
    };

    const connectPlain = async function (host = '127.0.0.1'): Promise<Peer> {
        const socket = net.connect(port, host);
        const peer = new Peer(socket);
        peers.push(peer);
        await once(socket, 'connect');
        return peer;
    };

    const fingerprintOf = (peer: Peer): string | undefined => (peer.socket as tls.TLSSocket).getPeerX509Certificate()?.fingerprint256;

    const clientMessages = (channel: string) =>
        posted.filter(p => p.channel === 'clientMessage$' && p.content.channel === channel);

    beforeAll(async () => {
        fixtures = await mkdtemp(path.join(tmpdir(), 'colibri-tcp-tls-'));
        first = createTestCertificate(fixtures, 'first');
        second = createTestCertificate(fixtures, 'second');
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

    describe('a TLS client', () => {
        beforeEach(async () => {
            await start({ tls: { cert: first.cert, key: first.key } });
        });

        it('is served the certificate, and speaks the same frames inside TLS', async () => {
            const peer = await connectTls();
            expect(fingerprintOf(peer)).toBe(first.fingerprint256);
            expect((peer.socket as tls.TLSSocket).authorized).toBe(true);

            peer.handshake('tls-app', 'quest');
            await eventually(() => peer.count(FrameType.Heartbeat) > 0);
            const [connected] = posted.filter(p => p.channel === 'clientConnected$');
            expect(connected?.content).toMatchObject({ app: 'tls-app', name: 'quest', version: PROTOCOL_VERSION });

            // From the client...
            peer.send(encodeMessageFrame({ channel: 'objects', command: 'broadcast::json', payload: Buffer.from('{"x":1}') }));
            await eventually(() => clientMessages('objects').length === 1);

            // ...and to it.
            internals.handleParentMessage({
                channel: 'm:broadcastToApp',
                content: { msg: { channel: 'objects', command: 'model::update', payload: Buffer.from('{"id":"a"}') }, app: 'tls-app' },
            });
            await eventually(() => peer.count(FrameType.Message) === 1);
            expect(peer.frames.find(f => f.type === FrameType.Message)).toMatchObject({ channel: 'objects', command: 'model::update' });
        });

        it('has its heartbeat echoes measured, as an unencrypted one does', async () => {
            const peer = await connectTls();
            peer.handshake();
            await eventually(() => peer.count(FrameType.Heartbeat) > 0);
            const heartbeat = peer.frames.find(f => f.type === FrameType.Heartbeat)!;

            peer.send(encodeHeartbeatFrame(heartbeat.pingTimestamp));

            await eventually(() => clientMessages('colibri').some(p => p.content.command === 'latency'));
        });

        // One byte is not enough to tell TLS from a client without it.
        it('is told apart from a client without TLS even when its first byte arrives on its own', async () => {
            const splitter = net.createServer(downstream => {
                const upstream = net.connect(port, '127.0.0.1');
                let first = true;
                downstream.on('data', (data: Buffer) => {
                    if (!first) {
                        upstream.write(data);
                        return;
                    }
                    first = false;
                    upstream.write(data.subarray(0, 1));
                    setTimeout(() => upstream.write(data.subarray(1)), 50);
                });
                upstream.pipe(downstream);
                for (const socket of [ downstream, upstream ]) socket.on('error', () => undefined);
                downstream.on('close', () => upstream.destroy());
                upstream.on('close', () => downstream.destroy());
            });
            splitter.listen(0, '127.0.0.1');
            await once(splitter, 'listening');
            try {
                const peer = await connectTls({ port: (splitter.address() as net.AddressInfo).port });

                expect(fingerprintOf(peer)).toBe(first.fingerprint256);
                expect(logs(LogLevel.Warn)).toEqual([]);
            } finally {
                for (const peer of peers) peer.socket.destroy();
                splitter.close();
            }
        });

        it('is logged as a TLS-only port at startup', () => {
            expect(logs(LogLevel.Info)).toContain('Starting Colibri TCP server on 127.0.0.1:0, TLS only');
        });

        it('leaves nothing behind once it has gone', async () => {
            const peer = await connectTls();
            peer.handshake();
            await eventually(() => peer.count(FrameType.Heartbeat) > 0);

            peer.socket.end();

            await eventually(() => internals.tlsPortSockets.size === 0);
            await eventually(() => posted.some(p => p.channel === 'clientDisconnected$'));
        });
    });

    describe('a client without TLS on the TLS port', () => {
        beforeEach(async () => {
            await start({ tls: { cert: first.cert, key: first.key } });
        });

        const withoutTlsWarnings = (): string[] => logs(LogLevel.Warn).filter(w => w.includes('TLS'));

        it('is refused and sent nothing, with a warning that names it and the setting to tick', async () => {
            const peer = await connectPlain();
            peer.handshake('MyApp', 'Quest-3');

            await peer.closed;
            expect(peer.received).toBe(0);
            const [warning] = withoutTlsWarnings();
            expect(warning).toContain('127.0.0.1');
            expect(warning).toContain('\'Quest-3\', app \'MyApp\'');
            expect(warning).toContain('does not use TLS');
            expect(warning).toContain('Server supports SSL/TLS?');
            expect(posted.filter(p => p.channel === 'clientConnected$')).toEqual([]);
            expect(logs(LogLevel.Error)).toEqual([]);
        });

        it('is warned about once a minute per address, and at debug level in between', async () => {
            for (let i = 0; i < 3; i++) {
                const peer = await connectPlain();
                peer.handshake();
                await peer.closed;
            }

            expect(withoutTlsWarnings()).toHaveLength(1);
            expect(logs(LogLevel.Debug).filter(l => l.includes('warned about this address already'))).toHaveLength(2);
        });

        it('is named as a Colibri 1.x client if it is one', async () => {
            const peer = await connectPlain();
            peer.send(Buffer.from('\0\0\0h\0' + '1::app::host\0', 'utf8'));

            await peer.closed;
            const [warning] = withoutTlsWarnings();
            expect(warning).toContain('Colibri 1.x client, which cannot use TLS');
            expect(warning).toContain('2.x');
        });

        it('is disconnected if it sends nothing at all', async () => {
            internals.tlsHandshakeTimeoutMillis = 100;
            const peer = await connectPlain();

            await peer.closed;
            expect(logs(LogLevel.Debug).some(l => l.includes('sent nothing within'))).toBe(true);
        });
    });

    describe('a failed TLS handshake', () => {
        const failures = (): string[] => logs(LogLevel.Info).filter(l => l.startsWith('TLS handshake with'));

        it('is logged at info level with the address, and what to check when the client refused the certificate', async () => {
            await start({ tls: { cert: first.cert, key: first.key } });
            // Trusts neither certificate: a client that does not accept a self-signed one.
            const socket = tls.connect({ host: '127.0.0.1', port, servername: 'localhost' });
            const peer = new Peer(socket);
            peers.push(peer);
            await peer.closed;

            await eventually(() => failures().length === 1);
            const [failure] = failures();
            expect(failure).toContain('TLS handshake with 127.0.0.1 failed');
            expect(failure).toContain('Allow self-signed certificate');
            expect(logs(LogLevel.Error)).toEqual([]);
            expect(logs(LogLevel.Warn)).toEqual([]);
        });

        it('is logged once a minute per address, and at debug level in between', async () => {
            await start({ tls: { cert: first.cert, key: first.key } });
            for (let i = 0; i < 3; i++) {
                const peer = new Peer(tls.connect({ host: '127.0.0.1', port, servername: 'localhost' }));
                peers.push(peer);
                await peer.closed;
            }

            await eventually(() => logs(LogLevel.Debug).filter(l => l.startsWith('TLS handshake with')).length === 2);
            expect(failures()).toHaveLength(1);
        });

        it('that never completes is ended, and logged', async () => {
            internals.tlsHandshakeTimeoutMillis = 200;
            await start({ tls: { cert: first.cert, key: first.key } });
            const peer = await connectPlain();
            // A TLS record header, and then nothing more.
            peer.send(Buffer.from([ 0x16, 0x03, 0x01, 0x00, 0x80 ]));

            await peer.closed;
            await eventually(() => failures().length === 1);
            expect(failures()[0]).toContain('did not complete within 0.2 s');
        });
    });

    describe('a renewed certificate', () => {
        it('is served to new connections, while open ones go on working', async () => {
            await start({ tls: { cert: first.cert, key: first.key } });
            const before = await connectTls();
            before.handshake('tls-app', 'before');
            await eventually(() => before.count(FrameType.Heartbeat) > 0);

            internals.handleParentMessage({ channel: 'm:tlsCredentials', content: { tls: { cert: second.cert, key: second.key } } });

            const after = await connectTls();
            expect(fingerprintOf(after)).toBe(second.fingerprint256);
            expect(fingerprintOf(before)).toBe(first.fingerprint256);

            // The open connection still works both ways.
            const heartbeats = before.count(FrameType.Heartbeat);
            await eventually(() => before.count(FrameType.Heartbeat) > heartbeats);
            before.send(encodeMessageFrame({ channel: 'after-renewal', command: 'broadcast::json', payload: Buffer.from('1') }));
            await eventually(() => clientMessages('after-renewal').length === 1);
        });

        it('that cannot be used leaves the one in use, and is logged', async () => {
            await start({ tls: { cert: first.cert, key: first.key } });

            internals.handleParentMessage({ channel: 'm:tlsCredentials', content: { tls: { cert: Buffer.from('nonsense'), key: second.key } } });

            expect(logs(LogLevel.Error)).toEqual([ expect.stringContaining('Could not switch the TCP server to the renewed TLS certificate') ]);
            expect(fingerprintOf(await connectTls())).toBe(first.fingerprint256);
        });
    });

    describe('stop', () => {
        it('ends connections still in their TLS handshake, or yet to start it', async () => {
            await start({ tls: { cert: first.cert, key: first.key } });
            const silent = await connectPlain();
            const halfway = await connectPlain();
            halfway.send(Buffer.from([ 0x16, 0x03, 0x01, 0x00, 0x80 ]));
            await eventually(() => internals.tlsPortSockets.size === 2);

            worker.stop();

            await silent.closed;
            await halfway.closed;
        });
    });

    // A message larger than HEARTBEAT_EVERY_BYTES has no heartbeat inside it, so a client reading one
    // echoes nothing until it is through. On a real socket the kernel takes all of this one at once,
    // so the server cannot see it being read either.
    describe('a client reading a large message over a slow link', () => {
        // Reads no faster than `bytesPerSecond`, and echoes every heartbeat it reads, as colibri-unity
        // does. Returns a function that stops the clock it reads by.
        const slowLink = function (peer: Peer, bytesPerSecond: number): () => void {
            const step = bytesPerSecond / 20;
            let budget = step;
            let echoed = 0;
            peer.socket.pause();
            peer.socket.on('data', (data: Buffer) => {
                // Peer's own listener has decoded the frames in it already.
                for (const frame of peer.frames.slice(echoed)) {
                    if (frame.type === FrameType.Heartbeat) peer.send(encodeHeartbeatFrame(frame.pingTimestamp));
                }
                echoed = peer.frames.length;
                budget -= data.length;
                if (budget <= 0) peer.socket.pause();
            });
            const clock = setInterval(() => {
                budget = Math.min(budget + step, step);
                if (budget > 0) peer.socket.resume();
            }, 50);
            peer.socket.resume();
            return () => clearInterval(clock);
        };

        const largeMessageArrives = async function (peer: Peer): Promise<void> {
            peer.handshake('slow-app', 'downloader');
            await eventually(() => peer.count(FrameType.Heartbeat) > 0);
            const stop = slowLink(peer, 512 * 1024);
            try {
                // 1 MiB: 2 s at 512 KiB/s, four times the idle timeout.
                internals.handleParentMessage({
                    channel: 'm:broadcastToApp',
                    content: { msg: { channel: 'big', command: 'broadcast::json', payload: Buffer.alloc(1024 * 1024, 0x31) }, app: 'slow-app' },
                });
                await eventually(() => peer.frames.some(frame => frame.type === FrameType.Message && frame.channel === 'big'), 10_000);

                // And it is still connected, echoing the heartbeats after it.
                const heartbeats = peer.count(FrameType.Heartbeat);
                await eventually(() => peer.count(FrameType.Heartbeat) > heartbeats + 5);
                expect(posted.filter(p => p.channel === 'clientDisconnected$')).toEqual([]);
                expect(peer.socket.destroyed).toBe(false);
            } finally {
                stop();
            }
        };

        it('is not disconnected while it reads it', async () => {
            await start({ idleTimeoutMillis: 500 });
            await largeMessageArrives(await connectPlain());
        }, 15_000);

        it('is not disconnected while it reads it through TLS', async () => {
            await start({ idleTimeoutMillis: 500, tls: { cert: first.cert, key: first.key } });
            await largeMessageArrives(await connectTls());
        }, 15_000);
    });

    describe('without TLS', () => {
        it('serves unencrypted clients as before', async () => {
            await start({});
            const peer = await connectPlain();
            peer.handshake();

            await eventually(() => peer.count(FrameType.Heartbeat) > 0);
            expect(logs(LogLevel.Info)).toContain('Starting Colibri TCP server on 127.0.0.1:0');
        });

        // TCP_HOST=:: for a server reached over IPv6, where Unity clients on IPv4 still connect.
        it.skipIf(!hasIPv6Loopback)('serves clients over IPv6 on an IPv6 TCP_HOST, and IPv4 clients too on ::', async () => {
            await start({}, '::');
            expect((internals.server!.address() as net.AddressInfo).family).toBe('IPv6');

            for (const [ host, name ] of [ [ '::1', 'over-ipv6' ], [ '127.0.0.1', 'over-ipv4' ] ]) {
                const peer = await connectPlain(host);
                peer.handshake('ipv6-app', name);
                await eventually(() => peer.count(FrameType.Heartbeat) > 0);
            }

            expect(posted.filter(p => p.channel === 'clientConnected$').map(p => p.content.name))
                .toEqual([ 'over-ipv6', 'over-ipv4' ]);
        });

        it('refuses a TLS client cleanly, saying what to change on either side', async () => {
            await start({});
            const socket = tls.connect({ host: '127.0.0.1', port, servername: 'localhost', ca: [ first.cert ] });
            const failed = new Promise<Error>(resolve => socket.once('error', resolve));
            const peer = new Peer(socket);
            peers.push(peer);

            expect((await failed).message).toMatch(/before secure TLS connection was established|ECONNRESET|socket hang up/);
            await peer.closed;
            const warnings = logs(LogLevel.Warn);
            expect(warnings).toEqual([ expect.stringContaining('it starts a TLS handshake, but this server\'s TCP port does not use TLS') ]);
            expect(logs(LogLevel.Error)).toEqual([]);
            expect(posted.filter(p => p.channel === 'clientConnected$')).toEqual([]);
        });
    });
});
