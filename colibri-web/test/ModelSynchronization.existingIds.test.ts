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
import { deliver, endOfAnswers, endRequest, everything, latest, nextTask } from './support/modelSyncWire';

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

// The server may already have a model under the id registered: another client created it, or this
// one did before a page reload while another client kept the app alive. What the server has wins;
// the full model is sent only if it has nothing.
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

    const sentInOrder = () =>
        fakeSocket.emit.mock.calls.map(([, msg]) => [(msg as Message).command, (msg as Message).payload]);

    // Longer than SyncModel's 1 ms buffer, so a change has been reported and sent by then.
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
        // The update taken for the answer may not be it, so a request follows whose answer comes after it.
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
        // Asked for again, to see that the server has the change.
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

        // A model that no registration here owns is listed even when the update is bare.
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
