// Holding back a change made after registerModel, before the server has answered for the model.
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
    fakeSocket.connected = false;
    vi.unstubAllGlobals();
});

// A change made after registerModel, before the server has answered for the model, is held back and
// sent on top of what the server has. The update taken for the answer need not be the answer,
// though: the answer to the request for every model carries the id too, and so does an update
// another client made. The real answer then came after the change was sent, without it, and undid
// it on this client only: it showed the old value while the server and every other client had the
// new one.
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
