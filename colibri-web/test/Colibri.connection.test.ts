import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('socket.io-client', () => ({
    connect: vi.fn()
}));

import { firstValueFrom } from 'rxjs';
import { connect } from 'socket.io-client';
import { Colibri, type Message, PROTOCOL_VERSION } from '../src/Colibri';
import { ProtocolMismatchError } from '../src/ColibriError';
import { type FakeSocket, getAnyHandler, getHandler, makeFakeSocket } from './support/fakeSocket';

const connectMock = connect as unknown as Mock;

let fakeSocket: FakeSocket;

beforeEach(() => {
    vi.clearAllMocks();
    fakeSocket = makeFakeSocket();
    connectMock.mockReturnValue(fakeSocket);
});

afterEach(() => {
    // Colibri.instance is a private static that must not leak between tests.
    (Colibri as unknown as { instance: Colibri | null }).instance = null;
    // Otherwise an earlier instance's 5 s old-server timer would warn during a later test.
    fakeSocket.connected = false;
    vi.unstubAllGlobals();
});

// Socket.IO retries a failed connection silently, so a wrong address or a server that is down
// looks like a slow connection.
describe('reporting a server that cannot be reached', () => {
    const fire = (event: string, ...args: unknown[]) => {
        for (const [e, handler] of fakeSocket.on.mock.calls) {
            if (e === event) handler(...args);
        }
    };

    // What Socket.IO hands over under Node: a TransportError whose own message says little, and
    // whose description is the underlying error.
    const transportError = (cause?: string) =>
        Object.assign(new Error('websocket error'), cause ? { description: new Error(cause) } : {});

    let warnSpy: ReturnType<typeof vi.spyOn>;
    let debugSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    });

    afterEach(() => {
        warnSpy.mockRestore();
        debugSpy.mockRestore();
    });

    it('warns once per outage, naming the address and the error, however often it retries', () => {
        new Colibri('app', 'colibri.example.org', 44011);

        for (let i = 0; i < 5; i++) fire('connect_error', transportError('connect ECONNREFUSED 10.0.0.1:44011'));

        expect(warnSpy).toHaveBeenCalledTimes(1);
        const [message] = warnSpy.mock.calls[0] as [string];
        expect(message).toContain('ws://colibri.example.org:44011');
        expect(message).toContain('websocket error: connect ECONNREFUSED 10.0.0.1:44011');
        expect(message).toContain('Retrying');
    });

    it('uses the message alone when the error has no underlying cause, as in a browser', () => {
        new Colibri('app', 'localhost', 9211);

        fire('connect_error', transportError());

        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toContain('(websocket error)');
    });

    it('warns again for the next outage, once connected in between', () => {
        new Colibri('app', 'localhost', 9211);

        fire('connect_error', transportError('first'));
        fire('connect');
        fire('connect_error', transportError('second'));
        fire('connect_error', transportError('second'));

        expect(warnSpy).toHaveBeenCalledTimes(2);
        expect(warnSpy.mock.calls[1][0]).toContain('second');
    });

    it('says nothing when the connection simply comes up', () => {
        new Colibri('app', 'localhost', 9211);

        fire('connect');
        fire('connect');

        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not promise a retry that Socket.IO will not make', () => {
        new Colibri('app', 'localhost', 9211);
        fakeSocket.active = false;

        fire('connect_error', new Error('refused by the server'));

        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toContain('Not retrying');
        expect(warnSpy.mock.calls[0][0]).not.toContain('Retrying');
    });
});

describe('protocol version handshake', () => {
    it('announces the client protocol version in the handshake query', () => {
        new Colibri('app', 'localhost', 9211);

        expect(connectMock).toHaveBeenCalledWith(
            'ws://localhost:9211',
            expect.objectContaining({ query: { app: 'app', version: PROTOCOL_VERSION } })
        );
    });

    it('stops reconnecting and reports a mismatch when the server refuses the version', async () => {
        const client = new Colibri('app', 'localhost', 9211);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const mismatch = firstValueFrom(client.protocolMismatch);

        getAnyHandler(fakeSocket.onAny)('colibri', {
            command: 'protocol::rejected',
            payload: { reason: 'nope', serverVersion: '9', clientVersion: PROTOCOL_VERSION }
        });

        const error = await mismatch;
        expect(error).toBeInstanceOf(ProtocolMismatchError);
        expect(error.serverVersion).toBe('9');
        expect(error.clientVersion).toBe(PROTOCOL_VERSION);
        // A mismatch cannot resolve itself; retrying would just bury the diagnostic.
        expect(fakeSocket.io.reconnection).toHaveBeenCalledWith(false);
        expect(fakeSocket.disconnect).toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalled();

        errorSpy.mockRestore();
    });

    it('keeps the rejection off the ordinary message stream', () => {
        const client = new Colibri('app', 'localhost', 9211);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const seen: string[] = [];
        client.messages.subscribe(msg => seen.push(msg.command));

        const onAny = getAnyHandler(fakeSocket.onAny);
        onAny('colibri', { command: 'protocol::rejected', payload: { serverVersion: '9' } });
        onAny('colibri', { command: 'latency', payload: 1 });

        expect(seen).toEqual(['latency']);

        errorSpy.mockRestore();
    });

    it('reports a refusal once, however many times the server sends it', () => {
        const client = new Colibri('app', 'localhost', 9211);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const seen: ProtocolMismatchError[] = [];
        client.protocolMismatch.subscribe(e => seen.push(e));

        const onAny = getAnyHandler(fakeSocket.onAny);
        for (let i = 0; i < 3; i++) {
            onAny('colibri', { command: 'protocol::rejected', payload: { serverVersion: '9' } });
        }

        expect(seen).toHaveLength(1);
        expect(seen[0].fatal).toBe(true);
        expect(errorSpy).toHaveBeenCalledTimes(1);

        errorSpy.mockRestore();
    });

    it('survives a rejection payload with nothing useful in it', async () => {
        const client = new Colibri('app', 'localhost', 9211);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const mismatch = firstValueFrom(client.protocolMismatch);

        getAnyHandler(fakeSocket.onAny)('colibri', { command: 'protocol::rejected', payload: undefined });

        const error = await mismatch;
        expect(error.serverVersion).toBe('unknown');
        expect(error.message).toContain(PROTOCOL_VERSION);

        errorSpy.mockRestore();
    });
});

describe('detecting a server that predates the version check', () => {
    const TIMEOUT_MS = 5000;

    // Mirrors socket.io: onAny sees every event, and a channel handler sees its own channel.
    const deliver = (channel: string, msg: { command: string; payload?: unknown }) => {
        getAnyHandler(fakeSocket.onAny)(channel, msg);
        const channelCall = fakeSocket.on.mock.calls.find(([event]) => event === channel);
        if (channelCall) channelCall[1](msg);
    };

    const connectSocket = () => {
        getHandler(fakeSocket.on, 'connect')();
    };

    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.useFakeTimers();
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.useRealTimers();
        warnSpy.mockRestore();
    });

    it('reports a suspected old server when it never announces itself', async () => {
        const client = new Colibri('app', 'localhost', 9211);
        const mismatch = firstValueFrom(client.protocolMismatch);

        connectSocket();
        vi.advanceTimersByTime(TIMEOUT_MS);

        const error = await mismatch;
        expect(error).toBeInstanceOf(ProtocolMismatchError);
        // Both are protocol versions, so they are comparable; not a release range.
        expect(error.serverVersion).toBe('1');
        expect(error.clientVersion).toBe(PROTOCOL_VERSION);
        // The Socket.IO envelope is the same in v1 and v2, so the connection works.
        // Reporting it as fatal, or hanging up, would turn a warning into an outage.
        expect(error.fatal).toBe(false);
        expect(fakeSocket.disconnect).not.toHaveBeenCalled();
        expect(fakeSocket.io.reconnection).not.toHaveBeenCalled();
    });

    it('stays quiet once the server identifies itself', () => {
        const client = new Colibri('app', 'localhost', 9211);
        const seen: ProtocolMismatchError[] = [];
        client.protocolMismatch.subscribe(e => seen.push(e));

        connectSocket();
        // Late, but inside the window: a loaded server is not an old one.
        vi.advanceTimersByTime(TIMEOUT_MS - 100);
        deliver('colibri', { command: 'protocol::accepted', payload: { serverVersion: PROTOCOL_VERSION } });
        vi.advanceTimersByTime(TIMEOUT_MS * 2);

        expect(seen).toEqual([]);
    });

    // 1.2.x and 1.3.x servers send the 100 ms `latency` broadcast but speak protocol v1, so it
    // does not show a current server.
    it('still reports an old server that sends the latency broadcast', async () => {
        const client = new Colibri('app', 'localhost', 9211);
        const mismatch = firstValueFrom(client.protocolMismatch);

        connectSocket();
        for (let i = 0; i < 50; i++) {
            deliver('colibri', { command: 'latency', payload: `${i}` });
            vi.advanceTimersByTime(100);
        }
        vi.advanceTimersByTime(TIMEOUT_MS);

        await expect(mismatch).resolves.toBeInstanceOf(ProtocolMismatchError);
    });

    // A pre-2.0.0 server relays broadcasts and model updates too, so ordinary traffic must not
    // clear the timer.
    it('still reports a busy old server that is relaying traffic', async () => {
        const client = new Colibri('app', 'localhost', 9211);
        const mismatch = firstValueFrom(client.protocolMismatch);

        connectSocket();
        for (let i = 0; i < 10; i++) {
            deliver('positions', { command: 'broadcast::vector3', payload: [i, 0, 0] });
            deliver('player', { command: 'model::update', payload: { id: 'p1' } });
            vi.advanceTimersByTime(400);
        }
        vi.advanceTimersByTime(TIMEOUT_MS);

        await expect(mismatch).resolves.toBeInstanceOf(ProtocolMismatchError);
    });

    it('keeps the server hello off the ordinary message stream', () => {
        const client = new Colibri('app', 'localhost', 9211);
        const seen: string[] = [];
        client.messages.subscribe(msg => seen.push(msg.command));

        connectSocket();
        deliver('colibri', { command: 'protocol::accepted', payload: { serverVersion: PROTOCOL_VERSION } });
        deliver('colibri', { command: 'latency', payload: 1 });

        expect(seen).toEqual(['latency']);
    });

    it('delivers messages untouched while the check is pending', () => {
        const client = new Colibri('app', 'localhost', 9211);
        const seen: Message[] = [];
        client.messages.subscribe(msg => seen.push(msg));

        connectSocket();
        deliver('positions', { command: 'broadcast::vector3', payload: [1, 2, 3] });
        deliver('player', { command: 'model::update', payload: { id: 'p1' } });
        vi.advanceTimersByTime(TIMEOUT_MS);
        deliver('positions', { command: 'broadcast::vector3', payload: [4, 5, 6] });

        expect(seen).toEqual([
            { channel: 'positions', command: 'broadcast::vector3', payload: [1, 2, 3] },
            { channel: 'player', command: 'model::update', payload: { id: 'p1' } },
            { channel: 'positions', command: 'broadcast::vector3', payload: [4, 5, 6] }
        ]);
    });

    it('reports once, not once per reconnect', () => {
        const client = new Colibri('app', 'localhost', 9211);
        const seen: ProtocolMismatchError[] = [];
        client.protocolMismatch.subscribe(e => seen.push(e));

        for (let i = 0; i < 3; i++) {
            connectSocket();
            vi.advanceTimersByTime(TIMEOUT_MS);
        }

        expect(seen).toHaveLength(1);
    });

    it('says nothing when the socket went down before the window elapsed', () => {
        const client = new Colibri('app', 'localhost', 9211);
        const seen: ProtocolMismatchError[] = [];
        client.protocolMismatch.subscribe(e => seen.push(e));

        connectSocket();
        fakeSocket.connected = false;
        vi.advanceTimersByTime(TIMEOUT_MS);

        expect(seen).toEqual([]);
    });

    // A hidden tab may not have drained the socket yet, so the announcement can still be queued
    // when the timer fires.
    it('waits another window instead of reporting while the tab is hidden', () => {
        vi.stubGlobal('document', { visibilityState: 'hidden' });
        const client = new Colibri('app', 'localhost', 9211);
        const seen: ProtocolMismatchError[] = [];
        client.protocolMismatch.subscribe(e => seen.push(e));

        connectSocket();
        vi.advanceTimersByTime(TIMEOUT_MS);
        expect(seen).toEqual([]);

        vi.stubGlobal('document', { visibilityState: 'visible' });
        deliver('colibri', { command: 'protocol::accepted', payload: { serverVersion: PROTOCOL_VERSION } });
        vi.advanceTimersByTime(TIMEOUT_MS * 2);

        expect(seen).toEqual([]);
    });

    // Each kind at most once, but the two are independent: a suspicion says nothing about whether
    // a refusal can follow, e.g. once the old server is replaced by one speaking another version.
    it('reports a suspicion and a later refusal once each', () => {
        const client = new Colibri('app', 'localhost', 9211);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const seen: ProtocolMismatchError[] = [];
        client.protocolMismatch.subscribe(e => seen.push(e));

        for (let i = 0; i < 2; i++) {
            connectSocket();
            vi.advanceTimersByTime(TIMEOUT_MS);
        }
        for (let i = 0; i < 2; i++) {
            getAnyHandler(fakeSocket.onAny)('colibri', {
                command: 'protocol::rejected',
                payload: { serverVersion: '9', clientVersion: PROTOCOL_VERSION }
            });
        }

        expect(seen.map(e => e.fatal)).toEqual([false, true]);

        errorSpy.mockRestore();
    });

    it('does not follow an explicit refusal with a contradictory old-server guess', () => {
        const client = new Colibri('app', 'localhost', 9211);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const seen: ProtocolMismatchError[] = [];
        client.protocolMismatch.subscribe(e => seen.push(e));

        connectSocket();
        getAnyHandler(fakeSocket.onAny)('colibri', {
            command: 'protocol::rejected',
            payload: { reason: 'nope', serverVersion: '9', clientVersion: PROTOCOL_VERSION }
        });
        vi.advanceTimersByTime(TIMEOUT_MS * 2);

        expect(seen).toHaveLength(1);
        expect(seen[0].serverVersion).toBe('9');
        expect(seen[0].fatal).toBe(true);

        errorSpy.mockRestore();
    });
});
