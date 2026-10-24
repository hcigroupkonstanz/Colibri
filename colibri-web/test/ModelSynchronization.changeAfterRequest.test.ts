// What a client does with a change sent just after it asked for every model.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('socket.io-client', () => ({
    connect: vi.fn()
}));

import { connect } from 'socket.io-client';
import { Colibri, type Message } from '../src/Colibri';
import { RegisterModelSync } from '../src/ModelSynchronization';
import { SyncModel } from '../src/SyncModel';
import { Synced } from '../src/Synced';
import { type FakeSocket, makeFakeSocket } from './support/fakeSocket';
import { deliver, endOfAnswers, latest, nextTask } from './support/modelSyncWire';

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
    fakeSocket.connected = false;
    vi.unstubAllGlobals();
});

// The server answers the request for every model with what it has when it reads that request, and
// reads a change sent just after it only then. Applied, that answer undid the change on this client
// alone, for good: the server relays an update to every client but the one that sent it, so the
// server and every other client had the change while this one showed the old value.
describe('keeping a change sent just after asking for every model', () => {
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

    let debugSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    });

    afterEach(() => {
        debugSpy.mockRestore();
    });

    /** A Colibri with an own Pair 'p1' (a: 'A', b: 'B') that the server had nothing for, so it was sent in full. */
    const connectedWithOwnPair = () => {
        new Colibri('app', 'localhost', 9211);
        const [models$, registerModel] = RegisterModelSync({ name: 'own', type: Pair });
        const pair = new Pair('p1');
        pair.a = 'A';
        pair.b = 'B';
        registerModel(pair);
        connectSocket();
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1' } });
        return { models$, pair };
    };

    it('keeps a change to an own model sent just after it, at first', async () => {
        const { pair } = connectedWithOwnPair();
        pair.b = 'B2';
        await settle();
        expect(sentInOrder()).toEqual([
            ['model::request', { id: 'p1' }],
            ['model::update', { id: 'p1', a: 'A', b: 'B' }],
            ['model::request', {}],
            ['model::update', { id: 'p1', b: 'B2' }]
        ]);

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });

        expect([pair.a, pair.b]).toEqual(['A', 'B2']);
    });

    it('keeps a change to an own model sent just after it, after a reconnect', async () => {
        const { pair } = connectedWithOwnPair();
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        disconnectSocket();
        connectSocket();
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        expect(sentInOrder().at(-1)).toEqual(['model::request', {}]);
        fakeSocket.emit.mockClear();

        pair.b = 'B2';
        await settle();
        expect(sentInOrder()).toEqual([['model::update', { id: 'p1', b: 'B2' }]]);
        // Another client changed a during the outage, and that is applied.
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'theirs', b: 'B' } });
        expect([pair.a, pair.b]).toEqual(['theirs', 'B2']);

        // The answers to it are over: from now on an update is applied as it comes.
        endOfAnswers(fakeSocket);
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', b: 'theirs too' } });
        expect(pair.b).toBe('theirs too');
    });

    // Every RegisterModelSync on the page receives the answer to each one's request on
    // 'colibri::reconnect', and another one's may come first.
    it("keeps it out until the end of its own answers, not another RegisterModelSync's", async () => {
        new Colibri('app', 'localhost', 9211);
        const [, registerModel] = RegisterModelSync({ name: 'own', type: Pair });
        RegisterModelSync({ name: 'other', type: Pair });
        const pair = new Pair('p1');
        pair.a = 'A';
        pair.b = 'B';
        registerModel(pair);
        connectSocket();
        await nextTask();
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1' } });
        pair.b = 'B2';
        await settle();
        expect(fakeSocket.endMarkers).toHaveLength(2);

        // The end of the answers to the request the other one sent for every model, then the answer
        // to this one's.
        endOfAnswers(fakeSocket, 1);
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });

        expect(pair.b).toBe('B2');
    });

    // Every RegisterModelSync on a channel receives the answer to another one's request for every
    // model, created later on a re-render say.
    it('keeps a change to an own model sent just after another RegisterModelSync on the channel asked', async () => {
        const { pair } = connectedWithOwnPair();
        await nextTask();
        endOfAnswers(fakeSocket);
        RegisterModelSync({ name: 'own', type: Pair });
        await nextTask();
        pair.b = 'B2';
        await settle();
        expect(sentInOrder().slice(-2)).toEqual([
            ['model::request', {}],
            ['model::update', { id: 'p1', b: 'B2' }]
        ]);

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        expect([pair.a, pair.b]).toEqual(['A', 'B2']);

        // The answers to it are over: from now on an update is applied as it comes.
        endOfAnswers(fakeSocket);
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', b: 'theirs' } });
        expect(pair.b).toBe('theirs');
    });

    // On a reconnect, the one registered first asks for every model at once; the other one, still
    // waiting for the answer for its own model, only later.
    it('keeps a change sent just after another RegisterModelSync on the channel asked on a reconnect', async () => {
        new Colibri('app', 'localhost', 9211);
        RegisterModelSync({ name: 'own', type: Pair });
        const [models$, registerModel] = RegisterModelSync({ name: 'own', type: Pair });
        registerModel(new Pair('p1'));
        connectSocket();
        await nextTask();
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1' } });
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'theirs', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        const [, theirs] = latest(models$);
        disconnectSocket();
        connectSocket();
        fakeSocket.emit.mockClear();

        theirs.b = 'B2';
        await settle();
        expect(sentInOrder()).toEqual([['model::update', { id: 'theirs', b: 'B2' }]]);
        // The answer to the other one's request for every model.
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'theirs', a: 'A', b: 'B' } });

        expect([theirs.a, theirs.b]).toEqual(['A', 'B2']);
    });

    it('keeps a change to a model another client made, sent just after it', async () => {
        new Colibri('app', 'localhost', 9211);
        const [models$] = RegisterModelSync({ name: 'own', type: Pair });
        connectSocket();
        await nextTask();
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'theirs', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        const [theirs] = latest(models$);
        disconnectSocket();
        connectSocket();
        expect(sentInOrder().at(-1)).toEqual(['model::request', {}]);

        theirs.b = 'B2';
        await settle();
        expect(sentInOrder().at(-1)).toEqual(['model::update', { id: 'theirs', b: 'B2' }]);
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'theirs', a: 'A2', b: 'B' } });

        expect([theirs.a, theirs.b]).toEqual(['A2', 'B2']);
    });

    // SyncModel reports a change 1 ms after it is made. An update that came in between was applied
    // over it, and the report sent that update's value in its place.
    it('keeps a change to a model another client made when an update for it comes before it is sent', async () => {
        new Colibri('app', 'localhost', 9211);
        const [models$] = RegisterModelSync({ name: 'own', type: Pair });
        connectSocket();
        await nextTask();
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'theirs', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        const [theirs] = latest(models$);

        theirs.b = 'B2';
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'theirs', a: 'A2', b: 'B3' } });
        await settle();

        expect([theirs.a, theirs.b]).toEqual(['A2', 'B2']);
        expect(sentInOrder().at(-1)).toEqual(['model::update', { id: 'theirs', b: 'B2' }]);
    });
});
