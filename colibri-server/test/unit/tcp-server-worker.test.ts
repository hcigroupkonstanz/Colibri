import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type * as net from 'net';
import { HEARTBEAT_EVERY_BYTES, MAX_REPLY_BACKLOG_BYTES, TCPServerWorker, TcpServerOptions, WireNetworkMessage } from '../../src/server/modules/networking/tcp-server-worker.js';
import { MAX_HELD_OBJECTS } from '../../src/server/modules/networking/inbound-limits.js';
import { FrameReader, FrameType, MAX_FRAME_LENGTH, PROTOCOL_VERSION, encodeHandshakeFrame, encodeHeartbeatFrame, encodeMessageFrame } from '../../src/server/modules/networking/protocol.js';
import { LogLevel } from '../../src/server/modules/core/log-message.js';

// Vitest runs suites inside worker threads, so the real `parentPort` here is the test
// runner's own channel: WorkerService would subscribe to it and the module bootstrap would
// try to start a second server. Pretending to be the main thread makes both inert - the
// worker's outgoing messages are captured by spying on postMessage instead.
vi.mock('worker_threads', async (importOriginal) => {
    const actual = await importOriginal<typeof import('worker_threads')>();
    return { ...actual, isMainThread: true, parentPort: null, workerData: null };
});

// A net.Socket stand-in: the worker only ever uses these members, and driving it directly
// keeps the tests free of real ports and timing.
class FakeSocket extends EventEmitter {
    public writableLength = 0;
    public readonly written: Buffer[] = [];
    // Writes attempted after end() or destroy(), which a real socket fails.
    public readonly writtenAfterEnd: Buffer[] = [];
    public destroyed = false;
    public ended = false;
    public remoteAddress = '127.0.0.1';

    public get writableEnded(): boolean {
        return this.ended;
    }

    public setNoDelay(): this {
        return this;
    }

    public keepAlive: [boolean, number] | undefined;
    public setKeepAlive(enable: boolean, initialDelay: number): this {
        this.keepAlive = [enable, initialDelay];
        return this;
    }

    // Set to fail every write's callback with this error, the way a real socket fails the writes
    // queued for a peer that has gone.
    public failWritesWith: Error | undefined;

    // Set for a peer that reads slower than it is sent to: each write then waits, counted in
    // writableLength, until flush() or take() hands it to the kernel, as a real socket's writes do.
    public holdWrites = false;
    private readonly heldWrites: { data: Buffer; taken: number; callback?: (err?: Error) => void }[] = [];

    // Lets the oldest `count` held writes go, as the kernel takes them, and returns what take() had
    // left of them.
    public flush(count = this.heldWrites.length): Buffer[] {
        const flushed = this.heldWrites.splice(0, count);
        for (const write of flushed) {
            this.writableLength -= write.data.length;
            write.callback?.();
        }
        return flushed.map(write => write.data.subarray(write.taken));
    }

    // Lets `bytes` more of the held writes go, oldest first, as a slow link takes them: a large write
    // a part at a time. As with a real socket, a write is done, and leaves writableLength, only once
    // all of it has gone. Returns what went.
    public take(bytes: number): Buffer[] {
        const taken: Buffer[] = [];
        while (bytes > 0 && this.heldWrites.length > 0) {
            const write = this.heldWrites[0]!;
            const part = write.data.subarray(write.taken, write.taken + bytes);
            write.taken += part.length;
            bytes -= part.length;
            taken.push(part);
            if (write.taken === write.data.length) this.flush(1);
        }
        return taken;
    }

    // Modelled on what a real net.Socket does with a write after end(): the write fails, the
    // socket emits 'error' and destroys itself - which is how a heartbeat to a refused client
    // used to log twice and could cut off the refusal frame still being flushed.
    public write(data: Buffer, callback?: (err?: Error) => void): boolean {
        if (this.failWritesWith) {
            callback?.(this.failWritesWith);
            return false;
        }

        if (this.ended || this.destroyed) {
            const err = new Error('write after end');
            this.writtenAfterEnd.push(data);
            callback?.(err);
            this.emit('error', err);
            this.destroy();
            return false;
        }

        this.written.push(data);
        if (this.holdWrites) {
            this.writableLength += data.length;
            this.heldWrites.push({ data, taken: 0, callback });
            return false;
        }
        callback?.();
        return true;
    }

    // end(data) is how the worker sends a protocol rejection: the frame and the FIN are
    // queued together so the refusal cannot be lost to a close racing the write callback.
    public end(data?: Buffer): this {
        if (data) this.written.push(data);
        this.ended = true;
        return this;
    }

    public destroy(): this {
        this.destroyed = true;
        return this;
    }

    public asSocket(): net.Socket {
        return this as unknown as net.Socket;
    }
}

// The members under test are private; naming them here (rather than reaching through `any`)
// keeps the test honest about exactly which internals it depends on.
interface WorkerInternals {
    handleConnection(socket: net.Socket): void;
    handleParentMessage(msg: { channel: string; content: Record<string, unknown> }): void;
    handleHeartbeat(): void;
    tick(): void;
    postMessage(channel: string, content: Record<string, unknown>): void;
    clients: Map<string, { id: string; app: string; socket: net.Socket }>;
    waitingClients: Map<string, { id: string; socket: net.Socket }>;
    clientsByApp: Map<string, Set<{ id: string }>>;
    v1WarnedAt: { size: number };
    stop(): void;
}

const wireMessage = function (channel: string, command: string, payload = ''): WireNetworkMessage {
    return { channel, command, payload: Buffer.from(payload, 'utf8') };
};

describe('TCPServerWorker', () => {
    let worker: TCPServerWorker;
    let internals: WorkerInternals;
    let posted: { channel: string; content: Record<string, unknown> }[];

    // Every log call goes through postMessage too, so the spy doubles as the log sink.
    const logs = (): string[] =>
        posted.filter(p => p.channel === 'log').map(p => String(p.content.msg));

    const connect = function (remoteAddress = '127.0.0.1'): { socket: FakeSocket; id: string } {
        const socket = new FakeSocket();
        socket.remoteAddress = remoteAddress;
        internals.handleConnection(socket.asSocket());
        const entry = Array.from(internals.waitingClients.values()).find(c => c.socket === socket.asSocket());
        return { socket, id: entry!.id };
    };

    beforeEach(() => {
        worker = new TCPServerWorker();
        internals = worker as unknown as WorkerInternals;
        posted = [];
        vi.spyOn(internals, 'postMessage').mockImplementation((channel, content) => {
            posted.push({ channel, content });
        });
    });

    afterEach(() => {
        internals.stop();
        vi.restoreAllMocks();
    });

    describe('handshake and the per-app index', () => {
        it('moves a client from waiting to connected and indexes it by app', () => {
            const { socket, id } = connect();
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'client-a'));

            expect(internals.waitingClients.has(id)).toBe(false);
            expect(internals.clients.has(id)).toBe(true);
            expect(Array.from(internals.clientsByApp.get('appA') ?? []).map(c => c.id)).toEqual([id]);
            expect(posted.filter(p => p.channel === 'clientConnected$')).toHaveLength(1);
        });

        // Regression: assignApp used to overwrite client.app before removing the client from
        // its previous app's Set, and removeFromAppIndex only ever looks at the *current*
        // app - so the stale entry survived even the client's disconnect.
        it('does not leave a stale index entry when a client re-handshakes with another app', () => {
            const { socket, id } = connect();
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'client-a'));
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appB', 'client-a'));

            expect(internals.clientsByApp.has('appA')).toBe(false);
            expect(Array.from(internals.clientsByApp.get('appB') ?? []).map(c => c.id)).toEqual([id]);
        });

        it('drops the client from every index on disconnect', () => {
            const { socket, id } = connect();
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'client-a'));
            socket.emit('close');

            expect(internals.clients.has(id)).toBe(false);
            expect(internals.clientsByApp.has('appA')).toBe(false);
        });

        it('refuses a handshake whose app ends in a colon instead of moving the colon into the name', () => {
            const { socket, id } = connect();
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'app:', 'name'));

            expect(socket.ended).toBe(true);
            expect(internals.clients.has(id)).toBe(false);
            expect(internals.clientsByApp.has('app')).toBe(false);
            expect(posted.filter(p => p.channel === 'clientConnected$')).toHaveLength(0);
            expect(logs().some(l => l.includes('Malformed handshake frame'))).toBe(true);
        });

        it('terminates the connection on a malformed handshake', () => {
            const { socket } = connect();
            const bad = Buffer.alloc(5);
            bad.writeUInt32LE(1, 0);
            bad.writeUInt8(0xff, 4); // unknown frame type

            socket.emit('data', bad);

            expect(socket.ended).toBe(true);
        });
    });

    describe('protocol version check', () => {
        // Decodes whatever the worker wrote back, so the assertions are about the bytes a
        // real client would receive rather than about an internal call.
        const framesWrittenTo = function (socket: FakeSocket) {
            const reader = new FrameReader();
            return socket.written.flatMap(chunk => reader.append(chunk));
        };

        it('refuses a client announcing a different protocol version', () => {
            const { socket, id } = connect();
            socket.emit('data', encodeHandshakeFrame('1', 'appA', 'old-client'));

            expect(socket.ended).toBe(true);
            expect(internals.clients.has(id)).toBe(false);
            expect(internals.clientsByApp.has('appA')).toBe(false);
            // A refused client must never look connected to anything downstream - the admin
            // UI would otherwise list a client that is already gone.
            expect(posted.filter(p => p.channel === 'clientConnected$')).toHaveLength(0);
            expect(logs().some(l => l.includes('old-client') && l.includes(`v${PROTOCOL_VERSION}`))).toBe(true);
        });

        it('tells the refused client why, on the colibri channel', () => {
            const { socket } = connect();
            socket.emit('data', encodeHandshakeFrame('1', 'appA', 'old-client'));

            const frame = framesWrittenTo(socket).find(
                f => f.type === FrameType.Message && f.command === 'protocol::rejected'
            );
            expect(frame).toBeDefined();
            if (frame?.type !== FrameType.Message) throw new Error('expected a message frame');

            expect(frame.channel).toBe('colibri');
            expect(JSON.parse(frame.payload.toString('utf8'))).toMatchObject({
                serverVersion: PROTOCOL_VERSION,
                clientVersion: '1',
            });
        });

        it('accepts a client announcing the supported version', () => {
            const { socket, id } = connect();
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'current-client'));

            expect(socket.ended).toBe(false);
            expect(internals.clients.has(id)).toBe(true);
            expect(posted.filter(p => p.channel === 'clientConnected$')).toHaveLength(1);
        });

        it('ignores messages from a client refused for its version', () => {
            const { socket } = connect();
            socket.emit('data', encodeHandshakeFrame('1', 'appA', 'old-client'));
            posted.length = 0;

            socket.emit('data', encodeMessageFrame(wireMessage('chan', 'broadcast::json', '{}')));

            expect(posted.filter(p => p.channel === 'clientMessage$')).toHaveLength(0);
        });
    });

    // A refused or cut-off client used to stay in waitingClients/clients until its 'close'
    // event, so the next 100ms heartbeat wrote to the ended socket: a "Failed to send" warning,
    // a "write after end" error, and a destroy racing the refusal frame still being flushed.
    describe('a connection this server ends', () => {
        const badLength = function (): Buffer {
            const bad = Buffer.alloc(5);
            bad.writeUInt32LE(1, 0);
            bad.writeUInt8(0xff, 4); // unknown frame type
            return bad;
        };

        const writeErrors = (): string[] =>
            logs().filter(l => l.includes('write after end') || l.includes('Failed to send'));

        it('is no longer heartbeated after a protocol refusal', () => {
            const { socket } = connect();
            socket.emit('data', encodeHandshakeFrame('1', 'appA', 'old-client'));
            const writtenBeforeHeartbeat = socket.written.length;

            internals.handleHeartbeat();

            expect(socket.writtenAfterEnd).toHaveLength(0);
            expect(socket.written).toHaveLength(writtenBeforeHeartbeat);
            expect(socket.destroyed).toBe(false);
            expect(writeErrors()).toEqual([]);
        });

        it('is no longer heartbeated after a framing error', () => {
            const { socket } = connect();
            socket.emit('data', badLength());

            internals.handleHeartbeat();

            expect(socket.ended).toBe(true);
            expect(socket.writtenAfterEnd).toHaveLength(0);
            expect(writeErrors()).toEqual([]);
        });

        it('leaves the refusal frame as the last thing written before the FIN', () => {
            const { socket } = connect();
            socket.emit('data', encodeHandshakeFrame('1', 'appA', 'old-client'));
            internals.handleHeartbeat();

            const reader = new FrameReader();
            const frames = socket.written.flatMap(chunk => reader.append(chunk));
            const last = frames[frames.length - 1];
            expect(last?.type === FrameType.Message && last.command).toBe('protocol::rejected');
            expect(socket.ended).toBe(true);
        });

        it('drops a refused client from every index immediately, not on close', () => {
            const { socket, id } = connect();
            socket.emit('data', encodeHandshakeFrame('1', 'appA', 'old-client'));

            expect(internals.waitingClients.has(id)).toBe(false);
            expect(internals.clients.has(id)).toBe(false);
        });

        it('drops a connected client that sends a bad frame and reports it gone once', () => {
            const { socket, id } = connect();
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'client-a'));

            socket.emit('data', badLength());

            expect(internals.clients.has(id)).toBe(false);
            expect(internals.clientsByApp.has('appA')).toBe(false);
            expect(posted.filter(p => p.channel === 'clientDisconnected$')).toHaveLength(1);

            socket.emit('close');
            expect(posted.filter(p => p.channel === 'clientDisconnected$')).toHaveLength(1);
        });

        it('ignores frames queued behind a refused handshake in the same chunk', () => {
            const { socket } = connect();
            socket.emit('data', Buffer.concat([
                encodeHandshakeFrame('1', 'appA', 'old-client'),
                encodeMessageFrame(wireMessage('chan', 'broadcast::json', '{}')),
                encodeHeartbeatFrame(1n),
            ]));

            expect(posted.filter(p => p.channel === 'clientMessage$')).toHaveLength(0);
            expect(logs().filter(l => l.includes('without app'))).toEqual([]);
        });

        it('ignores anything the peer sends after being refused', () => {
            const { socket } = connect();
            socket.emit('data', encodeHandshakeFrame('1', 'appA', 'old-client'));
            posted.length = 0;

            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'old-client'));
            socket.emit('data', encodeMessageFrame(wireMessage('chan', 'broadcast::json', '{}')));

            expect(posted.filter(p => p.channel === 'clientConnected$' || p.channel === 'clientMessage$')).toHaveLength(0);
            expect(logs().filter(l => l.includes('without app'))).toEqual([]);
        });

        // With allowHalfOpen off, a peer's FIN ends our side too, a little before 'close'.
        it('skips a socket whose writable side has already ended', () => {
            const { socket } = connect();
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'client-a'));
            socket.ended = true;

            internals.handleHeartbeat();
            internals.handleParentMessage({
                channel: 'm:broadcastToApp',
                content: { msg: wireMessage('c', 'model::update'), app: 'appA' },
            });

            expect(socket.writtenAfterEnd).toHaveLength(0);
            expect(writeErrors()).toEqual([]);
        });

        it('destroys the socket if the peer never closes its side', () => {
            vi.useFakeTimers();
            try {
                const { socket } = connect();
                socket.emit('data', encodeHandshakeFrame('1', 'appA', 'old-client'));

                vi.advanceTimersByTime(4999);
                expect(socket.destroyed).toBe(false);
                vi.advanceTimersByTime(1);
                expect(socket.destroyed).toBe(true);
            } finally {
                vi.useRealTimers();
            }
        });

        it('leaves a socket alone once the peer has closed it', () => {
            vi.useFakeTimers();
            try {
                const { socket } = connect();
                socket.emit('data', encodeHandshakeFrame('1', 'appA', 'old-client'));
                socket.emit('close');

                vi.advanceTimersByTime(10_000);
                expect(socket.destroyed).toBe(false);
            } finally {
                vi.useRealTimers();
            }
        });
    });

    // A real colibri-unity 1.x client used to produce nothing but an anonymous "Invalid frame
    // from client <uuid> ... Invalid frame length: 1744830464", once a second, forever.
    describe('a Colibri 1.x client', () => {
        // Byte for byte what colibri-unity 1.x's WebServerConnection.SendHandshake writes.
        const v1Handshake = Buffer.from('\0\0\0h\0' + '1::app::host\0', 'utf8');

        const warnings = (): string[] =>
            posted.filter(p => p.channel === 'log' && p.content.level === LogLevel.Warn).map(p => String(p.content.msg));
        const v1Warnings = (): string[] => warnings().filter(w => w.includes('Colibri 1.x'));

        it('is named as one, with its address, the version spoken here and the fix', () => {
            const { socket } = connect('10.0.0.17');
            socket.emit('data', v1Handshake);

            expect(socket.ended).toBe(true);
            const [warning] = v1Warnings();
            expect(warning).toContain('10.0.0.17');
            expect(warning).toContain(`v${PROTOCOL_VERSION}`);
            expect(warning).toContain('Unity package');
            expect(logs().filter(l => l.includes('Invalid frame'))).toEqual([]);
        });

        it('is warned about at most once a minute per address', () => {
            vi.useFakeTimers();
            try {
                for (let i = 0; i < 30; i++) {
                    connect('10.0.0.17').socket.emit('data', v1Handshake);
                    vi.advanceTimersByTime(1000);
                }
                expect(v1Warnings()).toHaveLength(1);

                connect('10.0.0.18').socket.emit('data', v1Handshake);
                expect(v1Warnings()).toHaveLength(2);

                vi.advanceTimersByTime(30_000);
                connect('10.0.0.17').socket.emit('data', v1Handshake);
                expect(v1Warnings()).toHaveLength(3);
            } finally {
                vi.useRealTimers();
            }
        });

        it('keeps a bounded amount of memory per address', () => {
            for (let i = 0; i < 3000; i++) {
                connect(`10.${(i >> 8) & 0xff}.${i & 0xff}.1`).socket.emit('data', v1Handshake);
            }

            expect(v1Warnings()).toHaveLength(3000);
            expect(internals.v1WarnedAt.size).toBeLessThanOrEqual(1024);
        });

        it('still reports other garbage as an invalid frame', () => {
            const { socket } = connect();
            const bad = Buffer.alloc(5);
            bad.writeUInt32LE(0xffffffff, 0);
            socket.emit('data', bad);

            expect(socket.ended).toBe(true);
            expect(v1Warnings()).toEqual([]);
            expect(logs().some(l => l.includes('Invalid frame length: 4294967295'))).toBe(true);
        });
    });

    // A Unity app with 'Server supports SSL/TLS?' ticked, against a server without TLS_CERT and
    // TLS_KEY. Its ClientHello used to go into the frame reader, which read a length field of 66326
    // from it and waited, silently, for the rest of a frame that never came.
    describe('a TLS client on this unencrypted port', () => {
        // The start of a TLS 1.2/1.3 ClientHello record: handshake (0x16), TLS 1.0 record layer, 200 bytes.
        const clientHello = Buffer.concat([ Buffer.from([ 0x16, 0x03, 0x01, 0x00, 0xc8, 0x01 ]), Buffer.alloc(199) ]);

        const tlsWarnings = (): string[] =>
            posted.filter(p => p.channel === 'log' && p.content.level === LogLevel.Warn).map(p => String(p.content.msg))
                .filter(w => w.includes('TLS handshake'));

        it('is refused at once, with a warning that names it and both ways to fix it', () => {
            const { socket } = connect('10.0.0.42');
            socket.emit('data', clientHello);

            expect(socket.ended).toBe(true);
            expect(socket.written).toEqual([]);
            const [warning] = tlsWarnings();
            expect(warning).toContain('10.0.0.42');
            expect(warning).toContain('Server supports SSL/TLS?');
            expect(warning).toContain('TLS_CERT and TLS_KEY');
            expect(logs().filter(l => l.includes('Invalid frame'))).toEqual([]);
            expect(posted.filter(p => p.channel === 'clientConnected$')).toEqual([]);
        });

        it('is warned about at most once a minute per address', () => {
            vi.useFakeTimers();
            try {
                for (let i = 0; i < 5; i++) connect('10.0.0.42').socket.emit('data', clientHello);
                expect(tlsWarnings()).toHaveLength(1);

                vi.advanceTimersByTime(60_000);
                connect('10.0.0.42').socket.emit('data', clientHello);
                expect(tlsWarnings()).toHaveLength(2);
            } finally {
                vi.useRealTimers();
            }
        });

        // Only the first bytes a client sends can be a TLS handshake.
        it('is not looked for in the middle of a connection', () => {
            const { socket, id } = connect();
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'a'));
            const message = encodeMessageFrame({ channel: 'c', command: 'broadcast::string', payload: Buffer.from([ 0x16, 0x03, 0x01 ]) });

            // The second chunk starts like a TLS handshake.
            socket.emit('data', message.subarray(0, message.length - 3));
            socket.emit('data', message.subarray(message.length - 3));

            expect(socket.ended).toBe(false);
            expect(internals.clients.has(id)).toBe(true);
            expect(posted.filter(p => p.channel === 'clientMessage$' && p.content.channel === 'c')).toHaveLength(1);
        });
    });

    // Item 28: 'error' is always followed by the socket's own 'close', so without the
    // disconnected flag both paths would report the same client as gone.
    describe('disconnect deduplication', () => {
        it('reports clientDisconnected$ once when an error is followed by close', () => {
            const { socket } = connect();
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'client-a'));

            socket.emit('error', new Error('ECONNRESET while reading'));
            socket.emit('close');
            socket.emit('close');

            expect(posted.filter(p => p.channel === 'clientDisconnected$')).toHaveLength(1);
        });
    });

    // A headset whose app is killed, or that drops off the Wi-Fi, resets its connection or leaves
    // writes to it failing. That is normal operation, and used to be logged at ERROR (EPIPE), and
    // as one warning per write still queued for the client.
    describe('a peer that is gone', () => {
        const errnoError = (code: string, message = `read ${code}`): Error =>
            Object.assign(new Error(message), { code });

        const logsAt = (level: LogLevel): string[] =>
            posted.filter(p => p.channel === 'log' && p.content.level === level).map(p => String(p.content.msg));

        const handshaked = function (): { socket: FakeSocket; id: string } {
            const client = connect('10.0.0.42');
            client.socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'quest-1'));
            return client;
        };

        it.each(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH'])('is logged at debug for %s, not as an error', (code) => {
            const { socket, id } = handshaked();

            socket.emit('error', errnoError(code));
            socket.emit('close');

            expect(logsAt(LogLevel.Error)).toEqual([]);
            expect(logsAt(LogLevel.Warn)).toEqual([]);
            const lost = logsAt(LogLevel.Debug).filter(l => l.includes(code));
            expect(lost).toHaveLength(1);
            expect(lost[0]).toContain(id);
            expect(lost[0]).toContain('10.0.0.42');
        });

        it('leaves any other socket error an error, naming the client', () => {
            const { socket, id } = handshaked();

            socket.emit('error', errnoError('EINVAL', 'something unexpected'));

            const errors = logsAt(LogLevel.Error);
            expect(errors).toHaveLength(1);
            expect(errors[0]).toContain('something unexpected');
            expect(errors[0]).toContain(id);
        });

        it.each(['ECONNRESET', 'EPIPE', 'ECANCELED', 'ERR_STREAM_DESTROYED'])('does not warn once per queued write that fails with %s', (code) => {
            const { socket } = handshaked();
            socket.failWritesWith = errnoError(code, `write ${code}`);

            for (let i = 0; i < 5; i++) {
                internals.handleParentMessage({
                    channel: 'm:broadcastToApp',
                    content: { msg: wireMessage('objects', 'model::update', '{"id":"a"}'), app: 'appA' },
                });
            }
            internals.handleHeartbeat();

            expect(logsAt(LogLevel.Warn)).toEqual([]);
            expect(logsAt(LogLevel.Error)).toEqual([]);
        });

        it('still warns about a write that fails for another reason', () => {
            const { socket } = handshaked();
            socket.failWritesWith = errnoError('EINVAL', 'write EINVAL');

            internals.handleHeartbeat();

            expect(logsAt(LogLevel.Warn).filter(w => w.includes('Failed to send message') && w.includes('EINVAL'))).toHaveLength(1);
        });
    });

    describe('inbound messages', () => {
        it('posts each payload to the main thread in a buffer of its own', () => {
            const { socket } = connect();
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'a'));

            socket.emit('data', Buffer.concat([
                encodeMessageFrame(wireMessage('chan', 'model::update', '{"id":"a"}')),
                encodeMessageFrame(wireMessage('chan', 'model::update', '{"id":"b"}')),
            ]));

            const payloads = posted.filter(p => p.channel === 'clientMessage$').map(p => p.content.payload as Buffer);
            expect(payloads.map(p => p.toString())).toEqual(['{"id":"a"}', '{"id":"b"}']);
            for (const payload of payloads) expect(payload.buffer.byteLength).toBe(payload.length);
        });
    });

    describe('broadcastToApp', () => {
        it('writes to every client of the app except the excluded one', () => {
            const a = connect();
            const b = connect();
            const other = connect();
            a.socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'a'));
            b.socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'b'));
            other.socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appB', 'o'));

            a.socket.written.length = 0;
            b.socket.written.length = 0;
            other.socket.written.length = 0;

            internals.handleParentMessage({
                channel: 'm:broadcastToApp',
                content: { msg: wireMessage('appA::chan', 'model::update', '{"x":1}'), app: 'appA', exclude: a.id },
            });

            expect(a.socket.written).toHaveLength(0);
            expect(other.socket.written).toHaveLength(0);
            expect(b.socket.written).toEqual([
                encodeMessageFrame({ channel: 'appA::chan', command: 'model::update', payload: Buffer.from('{"x":1}', 'utf8') }),
            ]);
        });

        it('does nothing for an app with no clients', () => {
            const { socket } = connect();
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'a'));
            socket.written.length = 0;

            internals.handleParentMessage({
                channel: 'm:broadcastToApp',
                content: { msg: wireMessage('c', 'model::update'), app: 'nobody-here' },
            });

            expect(socket.written).toHaveLength(0);
        });
    });

    // §3: an unrepresentable frame used to throw ERR_OUT_OF_RANGE out of the subscription
    // and take the whole worker thread - and with it the entire TCP transport - down.
    describe('unencodable messages', () => {
        it('drops the message and keeps serving instead of throwing', () => {
            const { socket } = connect();
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'a'));
            socket.written.length = 0;

            expect(() => internals.handleParentMessage({
                channel: 'm:broadcastToApp',
                content: { msg: wireMessage('c'.repeat(0x10000), 'model::update'), app: 'appA' },
            })).not.toThrow();

            expect(socket.written).toHaveLength(0);
            expect(logs().some(msg => msg.includes('Dropping unencodable message'))).toBe(true);

            // Still alive: a well-formed message afterwards is delivered normally.
            internals.handleParentMessage({
                channel: 'm:broadcastToApp',
                content: { msg: wireMessage('c', 'model::update'), app: 'appA' },
            });
            expect(socket.written).toHaveLength(1);
        });
    });

    // Item 21, plus the log volume fix: a stalled client drops at least ten heartbeats a
    // second, and every warning is forwarded to the main thread and re-broadcast to the
    // admin UI, so only the state transitions may be logged.
    describe('backpressure', () => {
        it('drops writes past the high-water mark and logs only the transitions', () => {
            const { socket } = connect();
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'a'));
            socket.written.length = 0;
            posted = [];

            socket.writableLength = 2 * 1024 * 1024;
            for (let i = 0; i < 5; i++) {
                internals.handleParentMessage({
                    channel: 'm:broadcastToApp',
                    content: { msg: wireMessage('c', 'model::update'), app: 'appA' },
                });
            }

            expect(socket.written).toHaveLength(0);
            expect(logs().filter(msg => msg.includes('Dropping messages to client'))).toHaveLength(1);

            socket.writableLength = 0;
            internals.handleParentMessage({
                channel: 'm:broadcastToApp',
                content: { msg: wireMessage('c', 'model::update'), app: 'appA' },
            });

            expect(socket.written).toHaveLength(1);
            expect(logs().some(msg => msg.includes('caught up; dropped 5 message(s)'))).toBe(true);
        });

        // The answer to a model::request for a whole channel is one frame per model, written all at
        // once. A store over 1 MiB used to reach a late joiner only up to the high-water mark; the
        // rest was dropped, and nothing ever sent it again.
        describe('replies to a client\'s own request', () => {
            const handshaked = function (): FakeSocket {
                const { socket } = connect();
                socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'late-joiner'));
                socket.written.length = 0;
                socket.holdWrites = true;
                posted = [];
                return socket;
            };

            const clientId = (): string => Array.from(internals.clients.keys())[0]!;

            const reply = function (payload: string): void {
                internals.handleParentMessage({
                    channel: 'm:broadcast',
                    content: { msg: wireMessage('store', 'model::update', payload), clients: [clientId()], reply: true },
                });
            };

            const relay = function (payload: string): void {
                internals.handleParentMessage({
                    channel: 'm:broadcastToApp',
                    content: { msg: wireMessage('store', 'model::update', payload), app: 'appA' },
                });
            };

            const commandsWritten = (socket: FakeSocket): string[] => {
                const reader = new FrameReader();
                return socket.written.flatMap(chunk => reader.append(chunk)).map(f => (f.type === FrameType.Message ? f.payload.toString() : 'heartbeat'));
            };

            const model = (i: number): string => JSON.stringify({ id: `m${i}`, data: 'x'.repeat(2000) });

            // Each write is one frame; heartbeats are written between messages too.
            const messagesWritten = (socket: FakeSocket): number => socket.written.filter(chunk => chunk[4] === FrameType.Message).length;

            it('are all written, however far over the high-water mark the client is', () => {
                const socket = handshaked();

                for (let i = 0; i < 3000; i++) reply(model(i));

                expect(messagesWritten(socket)).toBe(3000);
                expect(socket.writableLength).toBeGreaterThan(5 * 1024 * 1024);
                expect(logs().filter(msg => msg.includes('Dropping'))).toEqual([]);
            });

            // Relayed traffic is still dropped past the mark, but replies waiting ahead of it do not
            // count: a late joiner still reading its answer gets the changes made meanwhile too.
            it('do not count towards the high-water mark for relayed traffic, which is still dropped past it', () => {
                const socket = handshaked();
                for (let i = 0; i < 3000; i++) reply(model(i));

                relay(model(9000));
                internals.handleHeartbeat();
                expect(messagesWritten(socket)).toBe(3001);

                // 1 MiB of relayed traffic behind the replies, and the next is dropped.
                for (let i = 0; i < 600; i++) relay(model(10_000 + i));
                internals.handleHeartbeat();
                const relayedWritten = messagesWritten(socket) - 3001;
                expect(relayedWritten).toBeGreaterThan(500);
                expect(relayedWritten).toBeLessThan(600);
                expect(logs().filter(msg => msg.includes('Dropping messages to client'))).toHaveLength(1);

                // Once the client has read it all, relayed traffic goes out again.
                socket.flush();
                relay(model(20_000));
                expect(commandsWritten(socket).at(-1)).toContain('"m20000"');
                expect(logs().some(msg => msg.includes('caught up; dropped'))).toBe(true);
            });

            it('are counted off once the socket has flushed them', () => {
                const socket = handshaked();
                for (let i = 0; i < 1000; i++) reply(model(i));
                socket.flush();
                socket.writableLength = 2 * 1024 * 1024;

                relay(model(9000));

                expect(messagesWritten(socket)).toBe(1000);
                expect(logs().filter(msg => msg.includes('Dropping messages to client'))).toHaveLength(1);
            });

            it('are dropped past MAX_REPLY_BACKLOG_BYTES, with a warning when it starts and a summary when it ends', () => {
                const socket = handshaked();
                const big = 'y'.repeat(4 * 1024 * 1024);
                const fitting = MAX_REPLY_BACKLOG_BYTES / big.length;

                for (let i = 0; i < fitting + 2; i++) reply(big);

                expect(messagesWritten(socket)).toBe(fitting);
                const started = logs().filter(msg => msg.includes('Dropping answers to Unity client'));
                expect(started).toHaveLength(1);
                expect(started[0]).toContain('\'late-joiner\'');
                expect(started[0]).toContain(`${MAX_REPLY_BACKLOG_BYTES / (1024 * 1024)} MiB`);

                socket.flush();
                reply(model(1));

                expect(messagesWritten(socket)).toBe(fitting + 1);
                expect(logs().filter(msg => msg.includes('is taking answers again; dropped 2 answer(s)'))).toHaveLength(1);
            });
        });

        // A client that sends nothing of its own is kept connected by echoing the heartbeats it
        // reads; see the idle timeout tests.
        describe('heartbeats', () => {
            const framesOf = function (socket: FakeSocket) {
                const reader = new FrameReader();
                return socket.written.flatMap(chunk => reader.append(chunk));
            };

            it('are written between messages, one after every 64 KiB of them', () => {
                const { socket, id } = connect();
                socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'late-joiner'));
                socket.written.length = 0;

                for (let i = 0; i < 3000; i++) {
                    internals.handleParentMessage({
                        channel: 'm:broadcast',
                        content: { msg: wireMessage('store', 'model::update', `{"id":"m${i}","data":"${'x'.repeat(1000)}"}`), clients: [id], reply: true },
                    });
                }

                // The bytes of messages before each heartbeat, and after the last.
                const runs: number[] = [0];
                for (const chunk of socket.written) {
                    if (chunk[4] === FrameType.Heartbeat) runs.push(0);
                    else runs[runs.length - 1]! += chunk.length;
                }
                // About 3 MB of messages, at most one message (~1 KB) past each 64 KiB.
                expect(runs.length - 1).toBeGreaterThanOrEqual(45);
                for (const between of runs.slice(0, -1)) {
                    expect(between).toBeGreaterThanOrEqual(HEARTBEAT_EVERY_BYTES);
                    expect(between).toBeLessThan(HEARTBEAT_EVERY_BYTES + 1100);
                }
                expect(runs.at(-1)).toBeLessThan(HEARTBEAT_EVERY_BYTES + 1100);
                expect(framesOf(socket).filter(f => f.type === FrameType.Message)).toHaveLength(3000);
            });

            it('are still written to a client past the high-water mark, where relayed traffic is dropped', () => {
                const { socket } = connect();
                socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'a'));
                socket.written.length = 0;
                socket.writableLength = 2 * 1024 * 1024;

                internals.handleParentMessage({
                    channel: 'm:broadcastToApp',
                    content: { msg: wireMessage('c', 'model::update'), app: 'appA' },
                });
                internals.handleHeartbeat();

                expect(framesOf(socket).map(f => f.type)).toEqual([FrameType.Heartbeat]);
            });
        });
    });

    // colibri-unity counts a session as connected from the first frame it decodes. A heartbeat
    // sent before the handshake was checked made a client about to be refused fire OnConnected
    // first, and ProtocolMismatch a moment later.
    describe('heartbeats before the handshake', () => {
        const framesWrittenTo = function (socket: FakeSocket) {
            const reader = new FrameReader();
            return socket.written.flatMap(chunk => reader.append(chunk));
        };

        it('are not sent to a client that has not handshaked yet', () => {
            const { socket } = connect();

            internals.handleHeartbeat();
            internals.handleHeartbeat();

            expect(socket.written).toEqual([]);
        });

        it('start once the handshake is accepted', () => {
            const { socket } = connect();
            internals.handleHeartbeat();
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'a'));

            internals.handleHeartbeat();

            expect(framesWrittenTo(socket).map(f => f.type)).toEqual([FrameType.Heartbeat]);
        });

        it('never reach a refused client: the first frame it sees is the refusal', () => {
            const { socket } = connect();
            internals.handleHeartbeat();
            socket.emit('data', encodeHandshakeFrame('1', 'appA', 'old-client'));
            internals.handleHeartbeat();

            const frames = framesWrittenTo(socket);
            expect(frames).toHaveLength(1);
            expect(frames[0]?.type === FrameType.Message && frames[0].command).toBe('protocol::rejected');
        });
    });

    // The worker->main MessagePort queue used to grow without bound once the main thread fell
    // behind: every message a structured clone held in memory, seconds old by the time it was
    // handled, until the process ran out of memory - and nothing was logged on the way.
    describe('inbound backlog', () => {
        let backlog: Int32Array;

        const configure = function (options: Omit<TcpServerOptions, 'inboundBacklog'>): void {
            backlog = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
            worker.configure({ ...options, inboundBacklog: backlog });
        };

        const handshaked = function (name = 'quest-1'): FakeSocket {
            const { socket } = connect();
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', name));
            posted = [];
            return socket;
        };

        const send = function (socket: FakeSocket, channel: string, command: string, payload = '{"id":"a"}'): void {
            socket.emit('data', encodeMessageFrame(wireMessage(channel, command, payload)));
        };

        // What TCPServerProxy does once it has dispatched everything.
        const caughtUp = function (): void {
            Atomics.store(backlog, 0, 0);
        };

        const relayed = (): string[] =>
            posted.filter(p => p.channel === 'clientMessage$').map(p => `${String(p.content.channel)} ${String(p.content.command)}`);
        const relayedUpdates = (): unknown[] =>
            posted
                .filter(p => p.channel === 'clientMessage$' && p.content.command === 'model::update')
                .map(p => JSON.parse((p.content.payload as Buffer).toString('utf8')) as unknown);
        const warnings = (): string[] =>
            posted.filter(p => p.channel === 'log' && p.content.level === LogLevel.Warn).map(p => String(p.content.msg));
        const debugLines = (): string[] =>
            posted.filter(p => p.channel === 'log' && p.content.level === LogLevel.Debug).map(p => String(p.content.msg));

        it('counts every message posted to the main thread, heartbeat replies included', () => {
            configure({ inboundBacklogLimit: 100 });
            const socket = handshaked();

            send(socket, 'objects', 'model::update');
            send(socket, 'objects', 'model::request');
            socket.emit('data', encodeHeartbeatFrame(1n));

            expect(relayed()).toEqual(['objects model::update', 'objects model::request', 'colibri latency']);
            expect(Atomics.load(backlog, 0)).toBe(3);
        });

        // A model::update is a delta of the fields that changed: dropping one could lose a field
        // change for good, in every other client and in the store.
        it('holds model updates back while the main thread is at the limit, merged per object, and passes them on once it caught up', () => {
            configure({ inboundBacklogLimit: 2 });
            const socket = handshaked();
            send(socket, 'objects', 'model::update', '{"id":"a","x":1}');
            send(socket, 'objects', 'model::update', '{"id":"a","x":2}');

            send(socket, 'objects', 'model::update', '{"id":"a","isOn":true}');
            send(socket, 'objects', 'model::update', '{"id":"b","x":1}');
            send(socket, 'objects', 'model::update', '{"id":"a","x":3}');
            expect(relayed()).toHaveLength(2);
            expect(Atomics.load(backlog, 0)).toBe(2);

            caughtUp();
            internals.tick();

            expect(relayedUpdates()).toEqual([
                { id: 'a', x: 1 },
                { id: 'a', x: 2 },
                { id: 'a', isOn: true, x: 3 },
                { id: 'b', x: 1 },
            ]);
        });

        it('passes held updates on ahead of the next message once there is room', () => {
            configure({ inboundBacklogLimit: 1 });
            const socket = handshaked();
            send(socket, 'objects', 'model::update', '{"id":"a","x":1}');
            send(socket, 'objects', 'model::update', '{"id":"b","x":1}');

            caughtUp();
            send(socket, 'objects', 'model::update', '{"id":"c","x":1}');

            expect(relayedUpdates()).toEqual([{ id: 'a', x: 1 }, { id: 'b', x: 1 }]);
            caughtUp();
            internals.tick();
            expect(relayedUpdates()).toEqual([{ id: 'a', x: 1 }, { id: 'b', x: 1 }, { id: 'c', x: 1 }]);
        });

        it('drops broadcasts while the main thread is at the limit', () => {
            configure({ inboundBacklogLimit: 1 });
            const socket = handshaked();
            send(socket, 'objects', 'model::update');

            send(socket, 'myChannel', 'broadcast::json', '{"x":1}');
            caughtUp();
            internals.tick();

            expect(relayed()).toEqual(['objects model::update']);
        });

        it('drops an update it could not merge: not a JSON object with an id', () => {
            vi.useFakeTimers();
            try {
                configure({ inboundBacklogLimit: 1 });
                const socket = handshaked();
                send(socket, 'objects', 'model::update');

                send(socket, 'objects', 'model::update', 'not json');
                send(socket, 'objects', 'model::update', '{"x":1}');
                caughtUp();
                vi.advanceTimersByTime(1000);
                internals.tick();

                expect(relayed()).toEqual(['objects model::update']);
                expect(debugLines().filter(l => l.includes('briefly 1 TCP messages behind'))[0]).toContain('dropped 2 message(s)');
            } finally {
                vi.useRealTimers();
            }
        });

        it('never limits a request, a delete, a log line, latency or anything on the colibri channel', () => {
            configure({ inboundBacklogLimit: 1 });
            const socket = handshaked();
            send(socket, 'objects', 'model::update');

            send(socket, 'objects', 'model::request');
            send(socket, 'objects', 'model::delete');
            send(socket, 'clients', 'client::request', '');
            send(socket, 'log', 'error', 'boom');
            send(socket, 'colibri', 'broadcast::json');
            socket.emit('data', encodeHeartbeatFrame(1n));

            expect(relayed()).toEqual([
                'objects model::update',
                'objects model::request',
                'objects model::delete',
                'clients client::request',
                'log error',
                'colibri broadcast::json',
                'colibri latency',
            ]);
        });

        // A delete overtaking a held update to the same object would have that update bring the
        // object back, in the store and in every other client.
        it('lets nothing overtake a held update: it goes before the client\'s next request or delete', () => {
            configure({ inboundBacklogLimit: 1 });
            const socket = handshaked();
            send(socket, 'objects', 'model::update', '{"id":"other"}');
            send(socket, 'objects', 'model::update', '{"id":"cube","x":5}');

            send(socket, 'objects', 'model::delete', '{"id":"cube"}');

            expect(posted.filter(p => p.channel === 'clientMessage$').map(p => `${String(p.content.command)} ${(p.content.payload as Buffer).toString()}`)).toEqual([
                'model::update {"id":"other"}',
                'model::update {"id":"cube","x":5}',
                'model::delete {"id":"cube"}',
            ]);
        });

        it('passes on what a client held back before reporting it gone', () => {
            configure({ inboundBacklogLimit: 1 });
            const socket = handshaked();
            send(socket, 'objects', 'model::update', '{"id":"a"}');
            send(socket, 'objects', 'model::update', '{"id":"last-state","x":9}');

            socket.emit('close');

            expect(posted.filter(p => p.channel !== 'log').map(p => p.channel)).toEqual([
                'clientMessage$',
                'clientMessage$',
                'clientDisconnected$',
            ]);
            expect(relayedUpdates()[1]).toEqual({ id: 'last-state', x: 9 });
        });

        // A held update is posted with the client's app at the time it goes. Left held across a
        // handshake into another app, it would reach the main thread as the new app's: stored in
        // the new app's model store and relayed to its clients, while the old app never got it.
        it('passes on what a client held back in its old app before it handshakes into another', () => {
            configure({ inboundBacklogLimit: 1 });
            const socket = handshaked();
            send(socket, 'objects', 'model::update', '{"id":"first"}');
            send(socket, 'objects', 'model::update', '{"id":"held","x":1}');

            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appB', 'quest-1'));
            caughtUp();
            internals.tick();

            expect(posted.filter(p => p.channel !== 'log').map(p => p.channel === 'clientMessage$'
                ? `${(p.content.origin as { app: string }).app} ${(p.content.payload as Buffer).toString()}`
                : `${p.channel} ${String(p.content.app)}`)).toEqual([
                'appA {"id":"first"}',
                'appA {"id":"held","x":1}',
                'clientConnected$ appB',
            ]);
        });

        it('shares out the room that frees up evenly between the clients holding updates', () => {
            configure({ inboundBacklogLimit: 2 });
            const first = handshaked('first');
            const second = handshaked('second');
            send(first, 'objects', 'model::update', '{"id":"f0"}');
            send(first, 'objects', 'model::update', '{"id":"f1"}');
            for (let i = 2; i < 5; i++) send(first, 'objects', 'model::update', `{"id":"f${i}"}`);
            for (let i = 0; i < 3; i++) send(second, 'objects', 'model::update', `{"id":"s${i}"}`);
            posted = [];

            caughtUp();
            internals.tick();

            expect(relayedUpdates()).toEqual([{ id: 'f2' }, { id: 's0' }]);
        });

        // Over the limit for a second, sending every 10 ms as a sync loop does.
        const stayBehind = function (socket: FakeSocket, millis: number): void {
            for (let t = 0; t < millis; t += 10) {
                send(socket, 'objects', 'model::update', `{"id":"a","x":${t}}`);
                vi.advanceTimersByTime(10);
                internals.tick();
            }
        };

        it('warns once the main thread has been behind for a second, and sums up once it has caught up', () => {
            vi.useFakeTimers();
            try {
                configure({ inboundBacklogLimit: 1 });
                const socket = handshaked();
                send(socket, 'objects', 'model::update');
                send(socket, 'myChannel', 'broadcast::json', '{}');

                stayBehind(socket, 1000);
                expect(warnings()).toEqual([]);
                stayBehind(socket, 500);

                expect(warnings()).toHaveLength(1);
                expect(warnings()[0]).toContain('kept falling 1 TCP messages behind');
                expect(warnings()[0]).toContain('for a second now');
                expect(warnings()[0]).toContain('TCP_INBOUND_BACKLOG_LIMIT');
                expect(warnings()[0]).toContain('held back and merged per object');

                // Nothing has been over the limit for 10 ms; the episode ends a second after it.
                caughtUp();
                vi.advanceTimersByTime(989);
                internals.tick();
                expect(warnings()).toHaveLength(1);
                // ...but what was held back went on as soon as there was room.
                expect(relayedUpdates()).toEqual([{ id: 'a' }, { id: 'a', x: 490 }]);

                vi.advanceTimersByTime(1);
                internals.tick();
                expect(warnings()).toHaveLength(2);
                expect(warnings()[1]).toContain('caught up');
                expect(warnings()[1]).toContain('held back 150 model::update(s), merged per object and dropped 1 message(s) over 1.5 s');

                internals.tick();
                expect(warnings()).toHaveLength(2);
            } finally {
                vi.useRealTimers();
            }
        });

        // A main thread that stalls for a few hundred milliseconds at normal load - a long GC, a
        // busy host - fills the backlog and empties it again. That is not an overload to warn about.
        it('only sums up, at debug level, a stall shorter than a second', () => {
            vi.useFakeTimers();
            try {
                configure({ inboundBacklogLimit: 1 });
                const socket = handshaked();
                send(socket, 'objects', 'model::update');
                send(socket, 'myChannel', 'broadcast::json', '{}');
                stayBehind(socket, 350);

                caughtUp();
                vi.advanceTimersByTime(1000);
                internals.tick();
                internals.tick();

                expect(warnings()).toEqual([]);
                expect(relayedUpdates()).toEqual([{ id: 'a' }, { id: 'a', x: 340 }]);
                const summaries = debugLines().filter(l => l.includes('TCP messages behind'));
                expect(summaries).toHaveLength(1);
                expect(summaries[0]).toContain('briefly 1 TCP messages behind');
                expect(summaries[0]).toContain('held back 35 model::update(s), merged per object and dropped 1 message(s) over 0.3 s');
            } finally {
                vi.useRealTimers();
            }
        });

        // Updates for more objects than one client can have held back are lost for good, however
        // short the stall; that used to be summed up only at debug level.
        it('warns about updates it lost, however short the stall', () => {
            vi.useFakeTimers();
            try {
                configure({ inboundBacklogLimit: 1 });
                const socket = handshaked();
                send(socket, 'objects', 'model::update');
                for (let i = 0; i < MAX_HELD_OBJECTS + 5; i++) send(socket, 'objects', 'model::update', `{"id":"new-${i}"}`);

                caughtUp();
                vi.advanceTimersByTime(1000);
                internals.tick();

                const summaries = warnings().filter(l => l.includes('TCP messages behind'));
                expect(summaries).toHaveLength(1);
                expect(summaries[0]).toContain('briefly 1 TCP messages behind');
                expect(summaries[0]).toContain(`held back ${MAX_HELD_OBJECTS} model::update(s), merged per object and lost 5 model::update(s) for good`);
                expect(summaries[0]).toContain(`more objects than the ${MAX_HELD_OBJECTS} one client can have held back at once`);
            } finally {
                vi.useRealTimers();
            }
        });

        // A token taken for an update the backlog then held back, and another when it went on,
        // would put a client at a legitimate rate over its own limit whenever the server is behind.
        it('does not spend a client\'s rate limit on what the backlog holds back', () => {
            vi.useFakeTimers();
            try {
                configure({ inboundBacklogLimit: 2, rateLimit: { messagesPerSecond: 10, burst: 5 } });
                const socket = handshaked();
                send(socket, 'objects', 'model::update', '{"id":"first"}');
                send(socket, 'objects', 'model::update', '{"id":"second"}');

                // Held back by the backlog alone: three tokens are left for them afterwards.
                for (let i = 0; i < 20; i++) send(socket, 'objects', 'model::update', `{"id":"o${i}"}`);
                for (let i = 0; i < 3; i++) {
                    caughtUp();
                    internals.tick();
                }

                expect(relayed()).toHaveLength(5);
                expect(warnings().filter(w => w.includes('has been sending more than'))).toEqual([]);
            } finally {
                vi.useRealTimers();
            }
        });

        it('never limits anything with the limit off', () => {
            configure({ inboundBacklogLimit: 0 });
            const socket = handshaked();

            for (let i = 0; i < 100; i++) send(socket, 'objects', 'model::update');

            expect(relayed()).toHaveLength(100);
            expect(warnings()).toEqual([]);
        });

        it('takes its settings from the start message', () => {
            const shared = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
            const start = vi.spyOn(worker, 'start').mockImplementation(() => undefined);
            internals.handleParentMessage({
                channel: 'm:start',
                content: { port: 1, host: '127.0.0.1', options: { inboundBacklog: shared, inboundBacklogLimit: 1 } },
            });
            expect(start).toHaveBeenCalledWith(1, '127.0.0.1');
            const socket = handshaked();

            send(socket, 'objects', 'model::update');
            send(socket, 'objects', 'model::update');

            expect(relayed()).toHaveLength(1);
            expect(Atomics.load(shared, 0)).toBe(1);
        });
    });

    // A backstop for one client's runaway send loop, which on its own could push the main thread
    // past the backlog limit and slow every other client down too.
    describe('per-client rate limit', () => {
        const handshaked = function (name: string): { socket: FakeSocket; id: string } {
            const client = connect();
            client.socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', name));
            return client;
        };

        // `count` updates (or other commands), each to an object of its own, ids from `from` on.
        const burstOf = function (count: number, command = 'model::update', channel = 'objects', from = 0): Buffer {
            return Buffer.concat(Array.from({ length: count }, (_, i) => encodeMessageFrame(wireMessage(channel, command, `{"id":"${from + i}"}`))));
        };

        const relayedFrom = (id: string, command?: string): number =>
            posted.filter(p => p.channel === 'clientMessage$'
                && (p.content.origin as { id: string }).id === id
                && (command === undefined || p.content.command === command)).length;
        const warnings = (): string[] =>
            posted.filter(p => p.channel === 'log' && p.content.level === LogLevel.Warn).map(p => String(p.content.msg));
        const debugLines = (): string[] =>
            posted.filter(p => p.channel === 'log' && p.content.level === LogLevel.Debug).map(p => String(p.content.msg));

        // A runaway loop: 300 updates a second, three times the limit, for `millis`.
        const runAway = function (socket: FakeSocket, millis: number): void {
            for (let t = 0; t < millis; t += 10) {
                socket.emit('data', burstOf(3, 'model::update', 'objects', t));
                vi.advanceTimersByTime(10);
                internals.tick();
            }
        };

        beforeEach(() => {
            vi.useFakeTimers();
            worker.configure({ rateLimit: { messagesPerSecond: 100, burst: 200 } });
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('holds back a client\'s updates and drops its broadcasts past its burst', () => {
            const runaway = handshaked('runaway-quest');

            runaway.socket.emit('data', burstOf(150));
            runaway.socket.emit('data', burstOf(150, 'broadcast::json', 'myChannel'));
            runaway.socket.emit('data', burstOf(100, 'model::update', 'objects', 150));

            expect(relayedFrom(runaway.id, 'model::update')).toBe(150);
            expect(relayedFrom(runaway.id, 'broadcast::json')).toBe(50);
        });

        it('warns once a client has been over its limit for a second, naming it', () => {
            const runaway = handshaked('runaway-quest');
            runaway.socket.emit('data', burstOf(200, 'model::update', 'objects', 10_000));

            runAway(runaway.socket, 990);
            expect(warnings()).toEqual([]);
            runAway(runaway.socket, 2000);

            expect(warnings()).toHaveLength(1);
            expect(warnings()[0]).toContain('Unity client \'runaway-quest\'');
            expect(warnings()[0]).toContain(runaway.id);
            expect(warnings()[0]).toContain('more than 100');
        });

        it('only sums up, at debug level, a burst that is over its limit for less than a second', () => {
            const runaway = handshaked('runaway-quest');
            runaway.socket.emit('data', burstOf(250));

            vi.advanceTimersByTime(1000);
            internals.tick();
            vi.advanceTimersByTime(1000);
            internals.tick();

            expect(relayedFrom(runaway.id)).toBe(250);
            expect(warnings()).toEqual([]);
            const summaries = debugLines().filter(l => l.includes('rate limit'));
            expect(summaries).toHaveLength(1);
            expect(summaries[0]).toContain('Unity client \'runaway-quest\'');
            expect(summaries[0]).toContain('was briefly over the message rate limit; held back 50 model::update(s)');
        });

        // A client creating thousands of objects at once - a scene with many synced objects loading,
        // or a manager spawning them - is over its limit for well under a second, and the updates
        // for objects past what it can have held back are lost for good. That used to be summed up
        // only at debug level, below the default log level.
        it('warns about updates to more objects than it can hold back, however short the burst', () => {
            const spawner = handshaked('spawner');
            spawner.socket.emit('data', burstOf(200 + MAX_HELD_OBJECTS + 50));

            vi.advanceTimersByTime(1000);
            internals.tick();

            const lost = warnings().filter(w => w.includes('lost 50 model::update(s) for good'));
            expect(lost).toHaveLength(1);
            expect(lost[0]).toContain('Unity client \'spawner\'');
            expect(lost[0]).toContain(`was briefly over the message rate limit; held back ${MAX_HELD_OBJECTS} model::update(s)`);
            expect(lost[0]).toContain('reach the store and the other clients only when they change again');
        });

        it('passes what it held back on at the client\'s sustained rate', () => {
            const runaway = handshaked('runaway-quest');
            runaway.socket.emit('data', burstOf(250));
            expect(relayedFrom(runaway.id)).toBe(200);

            vi.advanceTimersByTime(100);
            internals.tick();
            expect(relayedFrom(runaway.id)).toBe(210);

            vi.advanceTimersByTime(400);
            internals.tick();
            expect(relayedFrom(runaway.id)).toBe(250);
        });

        it('never limits a request, a delete, a log line or a heartbeat reply - and lets none overtake a held update', () => {
            const runaway = handshaked('runaway-quest');
            runaway.socket.emit('data', burstOf(300));
            const before = relayedFrom(runaway.id);

            runaway.socket.emit('data', Buffer.concat([
                burstOf(50, 'model::request'),
                burstOf(50, 'model::delete'),
                burstOf(50, 'info', 'log'),
                encodeHeartbeatFrame(1n),
            ]));

            // The 100 held updates first, then all 151 others.
            expect(relayedFrom(runaway.id) - before).toBe(251);
        });

        it('does not hold one client\'s loop against another', () => {
            const runaway = handshaked('runaway-quest');
            const neighbour = handshaked('neighbour');

            runaway.socket.emit('data', burstOf(500));
            neighbour.socket.emit('data', burstOf(100));

            expect(relayedFrom(neighbour.id)).toBe(100);
        });

        it('sums up the episode once the client has slowed down', () => {
            const runaway = handshaked('runaway-quest');
            runaway.socket.emit('data', burstOf(200, 'model::update', 'objects', 10_000));
            runAway(runaway.socket, 1500);
            expect(warnings()).toHaveLength(1);

            // The last update over the limit came 10 ms before the loop ended.
            vi.advanceTimersByTime(989);
            internals.tick();
            expect(warnings()).toHaveLength(1);

            vi.advanceTimersByTime(1);
            internals.tick();
            expect(warnings()).toHaveLength(2);
            expect(warnings()[1]).toContain('Unity client \'runaway-quest\'');
            expect(warnings()[1]).toContain('back under the message rate limit; held back 450 model::update(s)');
        });

        it('passes on what it held back, and sums up the episode, when the client disconnects over the limit', () => {
            const runaway = handshaked('runaway-quest');
            runaway.socket.emit('data', burstOf(200, 'model::update', 'objects', 10_000));
            runAway(runaway.socket, 1500);

            runaway.socket.emit('close');

            expect(relayedFrom(runaway.id)).toBe(200 + 450);
            expect(warnings()[1]).toContain('disconnected while over the message rate limit; held back 450 model::update(s)');
        });

        it('sums up a short episode at debug level when the client disconnects in it', () => {
            const runaway = handshaked('runaway-quest');
            runaway.socket.emit('data', burstOf(250));

            runaway.socket.emit('close');

            expect(relayedFrom(runaway.id)).toBe(250);
            expect(warnings()).toEqual([]);
            expect(debugLines().filter(l => l.includes('disconnected while briefly over the message rate limit; held back 50 model::update(s)')))
                .toHaveLength(1);
        });

        it('limits nothing when turned off', () => {
            worker.configure({ rateLimit: { messagesPerSecond: 0, burst: 1 } });
            const client = handshaked('fast-but-allowed');

            client.socket.emit('data', burstOf(5000));

            expect(relayedFrom(client.id)).toBe(5000);
            expect(warnings()).toEqual([]);
        });

        it('defaults to 1000 a second with bursts of 2000', () => {
            worker.configure({});
            const client = handshaked('quest');

            client.socket.emit('data', burstOf(2500));
            expect(relayedFrom(client.id)).toBe(2000);

            vi.advanceTimersByTime(500);
            internals.tick();
            expect(relayedFrom(client.id)).toBe(2500);
        });
    });

    // A Quest that drops off the Wi-Fi sends no FIN. Its connection used to stay open - a
    // connected client, keeping its app's models alive - until the kernel gave up on it.
    describe('idle timeout', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        const handshaked = function (name = 'quest-1'): { socket: FakeSocket; id: string } {
            const client = connect();
            client.socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', name));
            return client;
        };

        // The worker's 100 ms tick, for `millis`, with `each` run before every tick.
        const run = function (millis: number, each: () => void = () => undefined): void {
            for (let t = 0; t < millis; t += 100) {
                vi.advanceTimersByTime(100);
                each();
                internals.tick();
            }
        };

        const disconnected = (): string[] => posted.filter(p => p.channel === 'clientDisconnected$').map(p => String(p.content.id));
        const warnings = (): string[] =>
            posted.filter(p => p.channel === 'log' && p.content.level === LogLevel.Warn).map(p => String(p.content.msg));

        it('ends a handshaked client that has sent nothing for 10 s, as if it had disconnected', () => {
            const gone = handshaked('quest-gone');

            run(9_900);
            expect(disconnected()).toEqual([]);
            run(100);

            expect(disconnected()).toEqual([gone.id]);
            expect(gone.socket.destroyed).toBe(true);
            expect(internals.clients.has(gone.id)).toBe(false);
            expect(internals.clientsByApp.has('appA')).toBe(false);
            expect(warnings().filter(w => w.includes('has sent nothing for 10 s'))).toHaveLength(1);
            expect(warnings()[0]).toContain('quest-gone');

            // Its socket's own 'close' follows; that must not report it a second time.
            gone.socket.emit('close');
            expect(disconnected()).toEqual([gone.id]);
        });

        it('keeps a client that echoes its heartbeats', () => {
            const alive = handshaked('quest-alive');
            const gone = handshaked('quest-gone');

            run(30_000, () => alive.socket.emit('data', encodeHeartbeatFrame(1n)));

            expect(disconnected()).toEqual([gone.id]);
            expect(alive.socket.destroyed).toBe(false);
            expect(internals.clients.has(alive.id)).toBe(true);
        });

        it('counts any traffic, not only heartbeat replies', () => {
            const sender = handshaked();

            run(30_000, () => sender.socket.emit('data', encodeMessageFrame(wireMessage('objects', 'model::update', '{"id":"a"}'))));

            expect(disconnected()).toEqual([]);
        });

        // A client that sends nothing of its own is kept connected by echoing heartbeats, and it can
        // echo only those it has read. The answer to its model::request for a large store had none
        // in it, so on a slow link such a client was disconnected 10 s in, while reading all along.
        describe('a client still reading a backlog', () => {
            // A client that reads `writesPerTick` of what was written to it each tick and echoes every
            // heartbeat it finds, the way colibri-unity's receive thread does. Returns the models it read.
            const reader = function (client: { socket: FakeSocket }, writesPerTick: number): { each: () => void; models: Set<string> } {
                const frames = new FrameReader();
                const models = new Set<string>();
                return {
                    models,
                    each: () => {
                        for (const chunk of client.socket.flush(writesPerTick)) {
                            for (const frame of frames.append(chunk)) {
                                if (frame.type === FrameType.Heartbeat) client.socket.emit('data', encodeHeartbeatFrame(frame.pingTimestamp));
                                else if (frame.type === FrameType.Message) models.add(String(JSON.parse(frame.payload.toString()).id));
                            }
                        }
                    },
                };
            };

            const answered = function (name: string): { socket: FakeSocket; id: string } {
                const client = handshaked(name);
                client.socket.holdWrites = true;
                for (let i = 0; i < 3000; i++) {
                    internals.handleParentMessage({
                        channel: 'm:broadcast',
                        content: { msg: wireMessage('store', 'model::update', `{"id":"m${i}","data":"${'x'.repeat(1000)}"}`), clients: [client.id], reply: true },
                    });
                }
                return client;
            };

            it('is kept while it reads, however long the backlog takes it', () => {
                const spectator = answered('spectator');
                const reading = reader(spectator, 10);

                // About 100 KiB a second: over half a minute for its 3 MB.
                run(40_000, reading.each);

                expect(reading.models.size).toBe(3000);
                expect(disconnected()).toEqual([]);
                expect(spectator.socket.destroyed).toBe(false);
            });

            it('is ended 10 s after it stops reading', () => {
                const spectator = answered('spectator');
                const reading = reader(spectator, 10);
                run(5_000, reading.each);

                run(9_000);
                expect(disconnected()).toEqual([]);
                run(1_000);

                expect(disconnected()).toEqual([spectator.id]);
                expect(warnings().filter(w => w.includes('spectator') && w.includes('has sent nothing for 10 s'))).toHaveLength(1);
            });
        });

        // A message larger than HEARTBEAT_EVERY_BYTES has no heartbeat inside it, so a client reading
        // one echoes nothing until it is through. A 4 MiB broadcast over a link of 200 KB/s takes about
        // 21 s, and the client was disconnected 10 s in, while reading all along; it reconnected and
        // never got the message.
        describe('a client reading a message larger than HEARTBEAT_EVERY_BYTES', () => {
            // Fake timers stop process.hrtime between ticks too, so a heartbeat written ahead of a
            // large message would be stamped exactly like the message, and the order writeToClient
            // takes the two in would go untested: an echo of that heartbeat must not count as the
            // message read. Here, as on a real clock, each call is later than the one before.
            beforeEach(() => {
                const clock = process.hrtime.bigint;
                let calls = 0n;
                vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => clock() + ++calls);
            });

            const big = (channel = 'big'): WireNetworkMessage =>
                wireMessage(channel, 'broadcast::json', JSON.stringify('x'.repeat(4 * 1024 * 1024)));
            const send = function (msg: WireNetworkMessage): void {
                internals.handleParentMessage({ channel: 'm:broadcastToApp', content: { msg, app: 'appA' } });
            };
            // An answer to the client's own request, which unlike relayed traffic is still queued for
            // a client that has more than the high-water mark waiting.
            const answer = function (msg: WireNetworkMessage, id: string): void {
                internals.handleParentMessage({ channel: 'm:broadcast', content: { msg, clients: [id], reply: true } });
            };

            // A client that reads `bytesPerTick` of what was written to it each tick, a part of a large
            // message at a time, and echoes every heartbeat it finds. Returns the channels of the
            // messages it read in full.
            const slowLink = function (socket: FakeSocket, bytesPerTick: number): { each: () => void; read: string[] } {
                const frames = new FrameReader();
                const read: string[] = [];
                return {
                    read,
                    each: () => {
                        for (const chunk of socket.take(bytesPerTick)) {
                            for (const frame of frames.append(chunk)) {
                                if (frame.type === FrameType.Heartbeat) socket.emit('data', encodeHeartbeatFrame(frame.pingTimestamp));
                                else if (frame.type === FrameType.Message) read.push(frame.channel);
                            }
                        }
                    },
                };
            };

            it('is kept while it reads it, also with another one behind it', () => {
                const client = handshaked('downloader');
                client.socket.holdWrites = true;
                const link = slowLink(client.socket, 20 * 1024);

                // About 200 KiB a second: 41 s for both. Between them is a heartbeat, which it echoes
                // once it has read the first, but that one says nothing about the second.
                answer(big('first'), client.id);
                answer(big('second'), client.id);
                run(50_000, link.each);

                expect(link.read).toEqual(['first', 'second']);
                expect(disconnected()).toEqual([]);
                expect(client.socket.destroyed).toBe(false);
            });

            it('is kept while it reads one the kernel took all at once, and so is not seen being read', () => {
                const client = handshaked('downloader');
                send(big());

                // 21 s to read it, and nothing to echo in that time.
                run(21_000);
                expect(disconnected()).toEqual([]);

                // Then the first heartbeat behind it.
                const frames = new FrameReader().append(Buffer.concat(client.socket.written));
                const message = frames.findIndex(frame => frame.type === FrameType.Message);
                const next = frames.slice(message + 1).find(frame => frame.type === FrameType.Heartbeat);
                if (next?.type !== FrameType.Heartbeat) throw new Error('no heartbeat was written after the message');
                client.socket.emit('data', encodeHeartbeatFrame(next.pingTimestamp));

                // Having read it, it is held to the timeout itself again.
                run(9_900);
                expect(disconnected()).toEqual([]);
                run(100);
                expect(disconnected()).toEqual([client.id]);
                expect(warnings().filter(w => w.includes('has sent nothing for 10 s (TCP_IDLE_TIMEOUT_SECONDS)'))).toHaveLength(1);
            });

            it('is ended once it has read nothing for one more timeout per HEARTBEAT_EVERY_BYTES of it', () => {
                const client = handshaked('gone');
                client.socket.holdWrites = true;
                const link = slowLink(client.socket, 20 * 1024);
                // A heartbeat ahead of the message, which it reads and echoes...
                run(100, link.each);
                send(wireMessage('big', 'broadcast::json', JSON.stringify('x'.repeat(256 * 1024))));
                // ...then a quarter of the message, and nothing more.
                run(300, link.each);

                // 10 s for each 64 KiB of it: 40 s on top of the 10 s.
                run(49_000);
                expect(disconnected()).toEqual([]);
                run(1_000);

                expect(disconnected()).toEqual([client.id]);
                const [warning] = warnings().filter(w => w.includes('gone'));
                expect(warning).toContain('has sent nothing for 50 s (TCP_IDLE_TIMEOUT_SECONDS, and 40 s more for reading a 256 KiB message sent to it)');
                expect(warning).toContain('and so does a link too slow to read that message in that time.');
            });

            // Otherwise a headset that has gone by the time such a message is sent to it keeps its app's
            // models alive for up to 13.5 minutes.
            it('gets no more than 6 more timeouts, however large the message', () => {
                const client = handshaked('gone');
                client.socket.holdWrites = true;
                const link = slowLink(client.socket, 20 * 1024);
                run(100, link.each);
                // The largest a message can be: 80 more timeouts' worth, 800 s.
                send({ channel: 'huge', command: 'broadcast::json', payload: Buffer.alloc(MAX_FRAME_LENGTH - 1024, 0x31) });
                run(300, link.each);

                run(69_000);
                expect(disconnected()).toEqual([]);
                run(1_000);

                expect(disconnected()).toEqual([client.id]);
                const [warning] = warnings().filter(w => w.includes('gone'));
                expect(warning).toContain('has sent nothing for 70 s (TCP_IDLE_TIMEOUT_SECONDS, and 60 s more for reading a 5.0 MiB message sent to it)');
            });

            it('gets no more time for messages up to HEARTBEAT_EVERY_BYTES', () => {
                const client = handshaked('gone');
                client.socket.holdWrites = true;
                send(wireMessage('small', 'broadcast::json', JSON.stringify('x'.repeat(HEARTBEAT_EVERY_BYTES - 1024))));

                run(10_000);

                expect(disconnected()).toEqual([client.id]);
            });
        });

        // A client whose own updates keep it connected but that reads nothing: a send-only script,
        // or one whose receive loop has died while its sender goes on. Every tick's heartbeat used
        // to be queued for it, ten writes a second without limit for as long as it stayed.
        describe('a client that sends but never reads', () => {
            const heartbeatsWritten = (socket: FakeSocket): number => socket.written.filter(chunk => chunk[4] === FrameType.Heartbeat).length;

            it('is kept, with no more than one tick heartbeat queued for it at a time', () => {
                const sender = handshaked('send-only');
                sender.socket.holdWrites = true;
                sender.socket.written.length = 0;

                // Ten minutes, with one update of its own a second.
                let t = 0;
                run(600_000, () => {
                    if (t++ % 10 === 0) {
                        sender.socket.emit('data', encodeMessageFrame(wireMessage('objects', 'model::update', `{"id":"a","t":${t}}`)));
                    }
                });

                expect(disconnected()).toEqual([]);
                expect(heartbeatsWritten(sender.socket)).toBe(1);
                expect(sender.socket.writableLength).toBe(sender.socket.written[0]!.length);

                // Once it reads again, it is sent the next heartbeat.
                sender.socket.flush();
                run(100);
                expect(heartbeatsWritten(sender.socket)).toBe(2);
            });

            it('in a busy app, is queued no more heartbeats than fit between the relayed traffic it is still sent', () => {
                const sender = handshaked('send-only');
                sender.socket.holdWrites = true;
                sender.socket.written.length = 0;

                // Ten minutes: ten relayed updates of 2 KB a second from other clients, one of its own.
                let t = 0;
                run(600_000, () => {
                    internals.handleParentMessage({
                        channel: 'm:broadcastToApp',
                        content: { msg: wireMessage('objects', 'model::update', `{"id":"b","data":"${'x'.repeat(2000)}"}`), app: 'appA' },
                    });
                    if (t++ % 10 === 0) {
                        sender.socket.emit('data', encodeMessageFrame(wireMessage('objects', 'model::update', `{"id":"a","t":${t}}`)));
                    }
                });

                expect(disconnected()).toEqual([]);
                // The relayed traffic stops at the high-water mark; with it the heartbeats between it.
                expect(sender.socket.writableLength).toBeLessThan(1024 * 1024 + 3 * 2048);
                expect(heartbeatsWritten(sender.socket)).toBeLessThanOrEqual(1024 * 1024 / HEARTBEAT_EVERY_BYTES + 2);
            });
        });

        it('ends a connection that never handshakes', () => {
            const silent = connect();

            run(10_000);

            expect(silent.socket.destroyed).toBe(true);
            expect(internals.waitingClients.has(silent.id)).toBe(false);
            expect(warnings()).toEqual([]);
        });

        it('takes another timeout from the start options, and 0 as never', () => {
            worker.configure({ idleTimeoutMillis: 3000 });
            const quick = handshaked();
            run(3000);
            expect(disconnected()).toEqual([quick.id]);

            worker.configure({ idleTimeoutMillis: 0 });
            const patient = handshaked();
            run(60_000);
            expect(patient.socket.destroyed).toBe(false);
        });

        // A worker thread that could not run for longer than the timeout has not read anything
        // either; its clients have to be given the chance to be heard before being judged.
        it('does not end clients on the tick right after the worker itself stalled', () => {
            const alive = handshaked('quest-alive');
            const gone = handshaked('quest-gone');
            run(1000);

            vi.advanceTimersByTime(15_000);
            internals.tick();
            expect(disconnected()).toEqual([]);

            // What the clients sent during the stall is read before the next tick.
            alive.socket.emit('data', encodeHeartbeatFrame(1n));
            run(100);

            expect(disconnected()).toEqual([gone.id]);
        });

        it('turns on TCP keepalive for every connection', () => {
            const { socket } = connect();

            expect(socket.keepAlive?.[0]).toBe(true);
        });
    });

    describe('heartbeat replies', () => {
        it('relays an echoed ping timestamp as a colibri/latency message', () => {
            const { socket } = connect();
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'a'));
            posted = [];

            socket.emit('data', encodeHeartbeatFrame(123456789n));

            const relayed = posted.find(p => p.channel === 'clientMessage$');
            expect(relayed?.content.channel).toBe('colibri');
            expect(relayed?.content.command).toBe('latency');
            expect((relayed?.content.payload as Buffer).toString('utf8')).toBe('123456789');
        });

        // Posted to the main thread ten times a second per client: a Buffer.from() this small is a
        // view into the 64 KiB Buffer pool, and structured clone copies the whole pool slab.
        it('posts the relayed timestamp in a buffer of its own', () => {
            const { socket } = connect();
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'a'));
            posted = [];

            socket.emit('data', encodeHeartbeatFrame(123456789n));

            const payload = posted.find(p => p.channel === 'clientMessage$')?.content.payload as Buffer;
            expect(payload.byteOffset).toBe(0);
            expect(payload.buffer.byteLength).toBe(payload.length);
        });

        it('ignores a heartbeat from a client that has not handshaked yet', () => {
            const { socket } = connect();
            posted = [];

            socket.emit('data', encodeHeartbeatFrame(1n));

            expect(posted.filter(p => p.channel === 'clientMessage$')).toHaveLength(0);
        });
    });

    // The admin log's Connections switch hides these, and only these.
    describe('connection lines', () => {
        const tagged = (): string[] => posted
            .filter(p => p.channel === 'log' && (p.content.metadata as Record<string, unknown>).connection === true)
            .map(p => String(p.content.msg));

        it('tags the routine connect and disconnect lines', () => {
            const { socket } = connect('10.0.0.7');
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'quest'));
            socket.emit('close');

            expect(tagged()).toEqual([
                expect.stringContaining('connected from 10.0.0.7, waiting for app name'),
                expect.stringContaining('Setting app of new colibri client \'quest\''),
                expect.stringContaining('Colibri client 10.0.0.7 disconnected'),
            ]);
        });

        it('tags a peer that went away, but not a refusal', () => {
            const gone = connect('10.0.0.8');
            gone.socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'quest'));
            gone.socket.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
            const refused = connect('10.0.0.9');
            refused.socket.emit('data', encodeHandshakeFrame('1', 'appA', 'old'));

            expect(tagged()).toContainEqual(expect.stringContaining('Lost the connection to client'));
            expect(tagged().some(line => line.includes('Refusing'))).toBe(false);
        });
    });

    // What the admin UI's client view shows of a TCP client: counted here per message, posted only
    // when the main thread asks.
    describe('client activity for the admin UI', () => {
        const handshaked = function (name: string, app = 'appA'): { socket: FakeSocket; id: string } {
            const client = connect('10.0.0.7');
            client.socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, app, name));
            return client;
        };

        const updates = function (count: number, from = 0): Buffer {
            return Buffer.concat(Array.from({ length: count }, (_, i) => encodeMessageFrame(wireMessage('objects', 'model::update', `{"id":"${from + i}"}`))));
        };

        const ask = function (request = 1, history = false): {
            request: number;
            clients: { id: string; in: number | null; out: number | null; limit: string | null; held: number; history?: number[][] }[];
        } {
            posted = [];
            internals.handleParentMessage({ channel: 'm:clientActivity', content: history ? { request, history } : { request } });
            const answers = posted.filter(p => p.channel === 'clientActivity$');
            expect(answers).toHaveLength(1);
            return answers[0]!.content as never;
        };

        // A second of ticks.
        const aSecond = function (): void {
            for (let i = 0; i < 10; i++) {
                vi.advanceTimersByTime(100);
                internals.tick();
            }
        };

        beforeEach(() => {
            vi.useFakeTimers();
            vi.setSystemTime(1_700_000_000_000);
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('says where a client connected from, whether over TLS, and since when', () => {
            vi.setSystemTime(1_700_000_000_000);
            const { id } = handshaked('quest');

            const connected = posted.find(p => p.channel === 'clientConnected$');
            expect(connected?.content).toEqual({
                id, app: 'appA', name: 'quest', version: PROTOCOL_VERSION, address: '10.0.0.7', tls: false, tlsAtProxy: false, connectedAt: 1_700_000_000_000,
            });
        });

        it('posts nothing about it unless asked', () => {
            const quest = handshaked('quest');
            for (let i = 0; i < 5; i++) {
                quest.socket.emit('data', updates(10));
                aSecond();
            }

            expect(posted.filter(p => p.channel === 'clientActivity$')).toEqual([]);
        });

        it('reports each client\'s messages a second in and out, without heartbeats', () => {
            const sender = handshaked('sender');
            const receiver = handshaked('receiver');
            aSecond();

            sender.socket.emit('data', updates(30));
            sender.socket.emit('data', encodeHeartbeatFrame(1n));
            for (let i = 0; i < 20; i++) worker.broadcast(wireMessage('objects', 'model::update', '{"id":"x"}'), [ internals.clients.get(receiver.id) as never ]);
            aSecond();

            const report = ask(5);
            expect(report.request).toBe(5);
            expect(report.clients).toEqual([
                { id: sender.id, in: 30, out: 0, limit: null, held: 0 },
                { id: receiver.id, in: 0, out: 20, limit: null, held: 0 },
            ]);
        });

        it('adds each client\'s rates of the last seconds only when asked, each at its Date.now()', () => {
            const quest = handshaked('quest');
            for (let i = 1; i <= 3; i++) {
                quest.socket.emit('data', updates(10 * i, 100 * i));
                aSecond();
            }

            expect(ask().clients[0]).not.toHaveProperty('history');
            const history = ask(2, true).clients[0]!.history!;
            expect(history.map(([ , received, sent ]) => [ received, sent ])).toEqual([ [ 10, 0 ], [ 20, 0 ], [ 30, 0 ] ]);
            expect(history.map(([ at ]) => Date.now() - at!)).toEqual([ 2000, 1000, 0 ]);
        });

        it('has no rates for a client connected less than a second ago, and leaves out clients without a handshake', () => {
            aSecond();
            const quest = handshaked('quest');
            connect();

            expect(ask().clients).toEqual([ { id: quest.id, in: null, out: null, limit: null, held: 0 } ]);
        });

        it('names the rate limit while it holds a client\'s updates back', () => {
            worker.configure({ rateLimit: { messagesPerSecond: 10, burst: 5 } });
            const runaway = handshaked('runaway');
            const calm = handshaked('calm');

            runaway.socket.emit('data', updates(20));
            calm.socket.emit('data', updates(2, 100));
            let clients = ask().clients;
            expect(clients.find(c => c.id === runaway.id)).toMatchObject({ limit: 'rate', held: 15 });
            expect(clients.find(c => c.id === calm.id)).toMatchObject({ limit: null, held: 0 });

            // Drained at 10 a second, and quiet for a while after.
            for (let i = 0; i < 4; i++) aSecond();
            clients = ask().clients;
            expect(clients.find(c => c.id === runaway.id)).toMatchObject({ limit: null, held: 0 });
        });

        it('names the backlog limit while the main thread is behind', () => {
            const backlog = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
            worker.configure({ inboundBacklog: backlog, inboundBacklogLimit: 2 });
            const quest = handshaked('quest');

            quest.socket.emit('data', updates(5));
            expect(ask().clients).toEqual([ expect.objectContaining({ id: quest.id, limit: 'backlog', held: 3 }) ]);

            Atomics.store(backlog, 0, 0);
            aSecond();
            Atomics.store(backlog, 0, 0);
            aSecond();
            expect(ask().clients).toEqual([ expect.objectContaining({ id: quest.id, limit: null, held: 0 }) ]);
        });
    });

    describe('stop', () => {
        it('destroys live sockets and clears every index', () => {
            const connected = connect();
            const waiting = connect();
            connected.socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'a'));

            internals.stop();

            expect(connected.socket.destroyed).toBe(true);
            expect(waiting.socket.destroyed).toBe(true);
            expect(internals.clients.size).toBe(0);
            expect(internals.waitingClients.size).toBe(0);
            expect(internals.clientsByApp.size).toBe(0);
        });

        it('tolerates being stopped before it was ever started', () => {
            expect(() => internals.stop()).not.toThrow();
        });
    });
});
