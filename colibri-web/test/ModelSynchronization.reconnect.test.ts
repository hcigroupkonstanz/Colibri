// What a client does on a reconnect: asking for the models again and sending its own models again.
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
import {
    Widget,
    deliver,
    endId,
    endOfAnswers,
    endRequest,
    everything,
    latest,
    nextTask
} from './support/modelSyncHelpers';

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

// The server relays model updates, it does not replay them, so one relayed while this client was
// disconnected is simply gone for it - and it used to stay stale until that model changed again.
describe('catching up on models after a reconnect', () => {
    const connectSocket = () => {
        for (const [event, handler] of fakeSocket.on.mock.calls) {
            if (event === 'connect') handler();
        }
    };

    // Leaving out the one on 'colibri::reconnect' that follows each (see endOfAnswers).
    const requested = () =>
        fakeSocket.emit.mock.calls
            .filter(
                ([channel, msg]) => channel !== 'colibri::reconnect' && (msg as Message).command === 'model::request'
            )
            .map(([channel]) => channel);

    let debugSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    });

    afterEach(() => {
        debugSpy.mockRestore();
    });

    it('asks for every registered model channel again on each reconnect', async () => {
        new Colibri('app', 'localhost', 9211);
        RegisterModelSync({ name: 'resync-a', type: Widget });
        RegisterModelSync({ name: 'resync-b', type: Widget });
        await nextTask();
        expect(requested()).toEqual(['resync-a', 'resync-b']);

        // The first connect is not a reconnect: Socket.IO sends the requests above on it.
        connectSocket();
        expect(requested()).toEqual(['resync-a', 'resync-b']);

        connectSocket();
        expect(requested()).toEqual(['resync-a', 'resync-b', 'resync-a', 'resync-b']);

        connectSocket();
        expect(requested()).toHaveLength(6);
    });

    it('does the same for a RegisterModelSync made before new Colibri()', async () => {
        RegisterModelSync({ name: 'resync-early', type: Widget });
        new Colibri('app', 'localhost', 9211);
        await nextTask();

        connectSocket();
        connectSocket();

        expect(requested()).toEqual(['resync-early', 'resync-early']);
    });

    it('brings a model missed during the outage up to date, in place, without duplicating it', async () => {
        new Colibri('app', 'localhost', 9211);
        const [models$] = RegisterModelSync({ name: 'resync-widget', type: Widget });
        await nextTask();
        connectSocket();
        deliver(fakeSocket, 'resync-widget', { command: 'model::update', payload: { id: 'w1', label: 'before' } });
        const [widget] = latest(models$);

        // Disconnected; another client changes w1 and the server relays it to everyone but us.
        connectSocket();
        expect(requested()).toEqual(['resync-widget', 'resync-widget']);

        // What the server answers that request with: one model::update per model it has.
        deliver(fakeSocket, 'resync-widget', {
            command: 'model::update',
            payload: { id: 'w1', label: 'during the outage' }
        });

        const models = latest(models$);
        expect(models).toHaveLength(1);
        expect(models[0]).toBe(widget);
        expect(widget.label).toBe('during the outage');
    });
});

// The server forgets every model of an app when the app's last client leaves, and when it restarts.
// A model this client had registered itself was never sent again after that, so a client joining
// later never saw it.
describe('sending its own models again after a reconnect', () => {
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
    });

    /** A Colibri with one own model, 'w1', connected and then reconnected. */
    const reconnectedWithOwnModel = () => {
        new Colibri('app', 'localhost', 9211);
        const [models$, registerModel] = RegisterModelSync({ name: 'own', type: Widget });
        const widget = new Widget('w1');
        widget.label = 'mine';
        registerModel(widget);

        connectSocket();
        // The server had nothing for it, and was sent all of it.
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'w1' } });
        connectSocket();
        return { models$, widget };
    };

    it('asks again for each of its own models by id on a reconnect', async () => {
        new Colibri('app', 'localhost', 9211);
        const [, registerModel] = RegisterModelSync({ name: 'own', type: Widget });
        registerModel(new Widget('w1'));
        registerModel(new Widget('w2'));
        await nextTask();

        connectSocket();
        expect(sent('model::request')).toEqual([
            ['own', { id: 'w1' }],
            ['own', { id: 'w2' }]
        ]);
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'w1' } });
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'w2' } });
        expect(sent('model::request').slice(2)).toEqual([
            ['own', {}],
            ['colibri::reconnect', { id: endId, again: true }]
        ]);

        // And one more, for an id nobody has, whose answer comes after all of theirs.
        connectSocket();
        expect(sent('model::request').slice(4)).toEqual([
            ['own', { id: 'w1', again: true }],
            ['own', { id: 'w2', again: true }],
            ['colibri::reconnect', { id: endId, again: true }]
        ]);
    });

    // Asked for again, the server would answer model::delete for an id another client deleted a
    // moment ago - but this client has the model now, and has never had an answer for it.
    it('asks afresh after a reconnect for an own model the server has not answered for yet', async () => {
        new Colibri('app', 'localhost', 9211);
        const [, registerModel] = RegisterModelSync({ name: 'own', type: Widget });
        registerModel(new Widget('w1'));
        await nextTask();
        connectSocket();

        connectSocket();
        expect(sent('model::request')).toEqual([
            ['own', { id: 'w1' }],
            ['own', { id: 'w1' }]
        ]);
    });

    it('sends the whole model when the server answers with nothing but its id', () => {
        const { models$, widget } = reconnectedWithOwnModel();
        fakeSocket.emit.mockClear();

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'w1' } });

        expect(sent('model::update')).toEqual([['own', { id: 'w1', label: 'mine' }]]);
        expect(latest(models$)).toEqual([widget]);
        expect(widget.label).toBe('mine');
    });

    // What the server has is newer than what this client kept: another client changed it.
    it('takes what the server has instead of overwriting it', async () => {
        const { models$, widget } = reconnectedWithOwnModel();
        fakeSocket.emit.mockClear();

        // The answers to the request for every model, and to the one for w1.
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'w1', label: 'newer' } });
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'w1', label: 'newer' } });
        await settle();

        expect(sent('model::update')).toEqual([]);
        expect(widget.label).toBe('newer');
        expect(latest(models$)).toEqual([widget]);
    });

    it('leaves alone the models the server told it about', async () => {
        new Colibri('app', 'localhost', 9211);
        RegisterModelSync({ name: 'own', type: Widget });
        await nextTask();
        connectSocket();
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'theirs', label: 'not mine' } });

        connectSocket();
        expect(sent('model::request').filter(([channel]) => channel === 'own')).toEqual([
            ['own', {}],
            ['own', {}]
        ]);

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'theirs' } });
        await settle();
        expect(sent('model::update')).toEqual([]);
    });

    // The server's answer for an own model another client deleted while this one was away.
    it('drops an own model the server answers with model::delete, and asks for everything else', () => {
        const { models$ } = reconnectedWithOwnModel();
        fakeSocket.emit.mockClear();

        deliver(fakeSocket, 'own', { command: 'model::delete', payload: { id: 'w1' } });

        expect(sentInOrder()).toEqual(everything);
        expect(latest(models$)).toEqual([]);
    });

    it('asks for everything else once every own model is answered, a delete among the answers', () => {
        new Colibri('app', 'localhost', 9211);
        const [models$, registerModel] = RegisterModelSync({ name: 'own', type: Widget });
        const kept = new Widget('w2');
        registerModel(new Widget('w1'));
        registerModel(kept);
        connectSocket();
        connectSocket();
        fakeSocket.emit.mockClear();

        deliver(fakeSocket, 'own', { command: 'model::delete', payload: { id: 'w1' } });
        expect(sent('model::request')).toEqual([]);

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'w2', label: 'kept' } });
        expect(sentInOrder()).toEqual(everything);
        expect(latest(models$)).toEqual([kept]);
    });

    // A delete relayed just before the answer, from a server that does not remember deletes
    // (MODEL_TOMBSTONE_SECONDS=0) and so answers with the bare id.
    it('does not bring back an own model deleted before the answer came', () => {
        const { models$ } = reconnectedWithOwnModel();
        fakeSocket.emit.mockClear();

        deliver(fakeSocket, 'own', { command: 'model::delete', payload: { id: 'w1' } });
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'w1' } });

        expect(sentInOrder()).toEqual(everything);
        expect(latest(models$)).toEqual([]);
    });

    it('does it again on every reconnect', () => {
        reconnectedWithOwnModel();
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'w1' } });

        connectSocket();
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'w1' } });

        expect(sent('model::update')).toEqual([
            ['own', { id: 'w1', label: 'mine' }],
            ['own', { id: 'w1', label: 'mine' }],
            ['own', { id: 'w1', label: 'mine' }]
        ]);
    });

    it('does it for a model registered before new Colibri()', () => {
        const [, registerModel] = RegisterModelSync({ name: 'own-early', type: Widget });
        const widget = new Widget('early');
        widget.label = 'mine';
        registerModel(widget);
        new Colibri('app', 'localhost', 9211);
        connectSocket();
        connectSocket();
        fakeSocket.emit.mockClear();

        deliver(fakeSocket, 'own-early', { command: 'model::update', payload: { id: 'early' } });

        expect(sent('model::update')).toEqual([['own-early', { id: 'early', label: 'mine' }]]);
    });

    const disconnectSocket = () => {
        for (const [event, handler] of fakeSocket.on.mock.calls) {
            if (event === 'disconnect') handler('transport close');
        }
    };

    /** Everything emitted, as [command, payload], in the order it was. */
    const sentInOrder = () =>
        fakeSocket.emit.mock.calls.map(([, msg]) => [(msg as Message).command, (msg as Message).payload]);

    class Pair extends SyncModel<Pair> {
        @Synced() accessor a = '';
        @Synced() accessor b = '';
    }

    /** A Colibri with one own model, 'p1', that has been connected and is now disconnected. */
    const disconnectedWithOwnPair = () => {
        new Colibri('app', 'localhost', 9211);
        const [models$, registerModel] = RegisterModelSync({ name: 'own', type: Pair });
        const pair = new Pair('p1');
        pair.a = 'A';
        pair.b = 'B';
        registerModel(pair);
        connectSocket();
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1' } });
        disconnectSocket();
        fakeSocket.emit.mockClear();
        return { models$, pair };
    };

    it('asks for everything else once its own models are answered, not before', () => {
        new Colibri('app', 'localhost', 9211);
        const [, registerModel] = RegisterModelSync({ name: 'own', type: Widget });
        registerModel(new Widget('w1'));
        registerModel(new Widget('w2'));
        connectSocket();
        connectSocket();
        fakeSocket.emit.mockClear();

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'w1', label: 'kept' } });
        // Not for every model yet: only the request whose answer comes after w1's, in case this was not it.
        expect(sentInOrder()).toEqual([endRequest]);

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'w2' } });
        expect(sentInOrder().slice(1)).toEqual([['model::update', { id: 'w2', label: '' }], ...everything]);
    });

    // Socket.IO buffers what is sent while disconnected and sends it on the reconnect, ahead of the
    // request for the model. A server that had forgotten the model kept that one change as all of
    // it, answered with it rather than a bare id, and the rest was never sent again.
    it('holds back a change made while disconnected, and sends it with the rest when the server forgot the model', async () => {
        const { pair } = disconnectedWithOwnPair();

        pair.a = 'A2';
        await settle();
        expect(sent('model::update')).toEqual([]);

        connectSocket();
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1' } });
        await settle();

        expect(sentInOrder()).toEqual([
            ['model::request', { id: 'p1', again: true }],
            endRequest,
            ['model::update', { id: 'p1', a: 'A2', b: 'B' }],
            ...everything
        ]);
    });

    it('sends only the change it made while disconnected when the server has the model, and takes the rest', async () => {
        const { models$, pair } = disconnectedWithOwnPair();

        pair.a = 'A2';
        await settle();
        connectSocket();
        // Another client changed b meanwhile; a is still what this client last sent.
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B2' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect([pair.a, pair.b]).toEqual(['A2', 'B2']);
        expect(latest(models$)).toEqual([pair]);
        // Sent, and asked for again to see that the server has it, before everything else is
        // asked for, so that that answer already has it.
        expect(sentInOrder()).toEqual([
            ['model::request', { id: 'p1', again: true }],
            endRequest,
            ['model::update', { id: 'p1', a: 'A2' }],
            ['model::request', { id: 'p1', again: true }],
            endRequest
        ]);
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A2', b: 'B2' } });
        endOfAnswers(fakeSocket);
        expect(sentInOrder().slice(5)).toEqual(everything);

        // Answered, so from now on a change goes out as it is made.
        fakeSocket.emit.mockClear();
        pair.b = 'B3';
        await settle();
        expect(sent('model::update')).toEqual([['own', { id: 'p1', b: 'B3' }]]);
    });

    // Sent at once, it would reach the server after the request, whose answer - without it - would
    // then undo it here.
    it('holds back a change made after the reconnect until the answer has come', async () => {
        const { pair } = disconnectedWithOwnPair();
        connectSocket();

        pair.b = 'B2';
        await settle();
        expect(sent('model::update')).toEqual([]);

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect([pair.a, pair.b]).toEqual(['A', 'B2']);
        expect(sent('model::update')).toEqual([['own', { id: 'p1', b: 'B2' }]]);
    });

    it('still sends a held change when the connection drops again before the answer', async () => {
        const { pair } = disconnectedWithOwnPair();
        pair.a = 'A2';
        await settle();

        connectSocket();
        disconnectSocket();
        connectSocket();
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1' } });
        await settle();

        expect(sentInOrder()).toEqual([
            ['model::request', { id: 'p1', again: true }],
            endRequest,
            ['model::request', { id: 'p1', again: true }],
            endRequest,
            ['model::update', { id: 'p1', a: 'A2', b: 'B' }],
            ...everything
        ]);
    });

    // detach() stops this client sending the model's changes; the whole model is one of them.
    it('does not ask for or send again an own model whose detach() was called', async () => {
        new Colibri('app', 'localhost', 9211);
        const [models$, registerModel] = RegisterModelSync({ name: 'own', type: Widget });
        const widget = new Widget('w1');
        widget.label = 'mine';
        registerModel(widget);
        connectSocket();
        disconnectSocket();
        widget.label = 'changed';
        await settle();
        widget.detach();
        await settle();
        fakeSocket.emit.mockClear();

        connectSocket();
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'w1' } });
        await settle();

        expect(sentInOrder()).toEqual(everything);
        expect(latest(models$)).toEqual([widget]);
    });

    it('does not send a change held for an own model deleted before the answer came', async () => {
        const { models$, pair } = disconnectedWithOwnPair();
        pair.a = 'A2';
        await settle();

        connectSocket();
        deliver(fakeSocket, 'own', { command: 'model::delete', payload: { id: 'p1' } });
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1' } });
        await settle();

        expect(sent('model::update')).toEqual([]);
        expect(latest(models$)).toEqual([]);
    });
});
