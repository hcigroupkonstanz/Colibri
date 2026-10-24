// Deleting a model for every client: delete() on an own model and on one another client created.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('socket.io-client', () => ({
    connect: vi.fn()
}));

import { connect } from 'socket.io-client';
import { Colibri, type Message } from '../src/Colibri';
import { RegisterModelSync } from '../src/ModelSynchronization';
import { SyncModel } from '../src/SyncModel';
import { Synced } from '../src/Synced';
import { type FakeSocket, getAnyHandler, makeFakeSocket } from './support/fakeSocket';
import { deliver, endOfAnswers, latest } from './support/modelSyncWire';
import { Widget } from './support/Widget';

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

// delete() deletes a model for every client, as destroying a SyncBehaviour does in Unity: the
// server removes it and tells every other client. It used to only stop this client syncing it.
describe('deleting a model for every client', () => {
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
        vi.useRealTimers();
    });

    /** A connected Colibri with the own model 'w1' on channel 'del', which the server has. */
    const connectedWithOwnWidget = async () => {
        new Colibri('app', 'localhost', 9211);
        const [models$, registerModel] = RegisterModelSync({ name: 'del', type: Widget });
        const widget = new Widget('w1');
        widget.label = 'mine';
        registerModel(widget);
        connectSocket();
        deliver(fakeSocket, 'del', { command: 'model::update', payload: { id: 'w1', label: 'mine' } });
        await settle();
        fakeSocket.emit.mockClear();
        return { models$, registerModel, widget };
    };

    it('deletes an own model on the server, and takes it out of the list', async () => {
        const { models$, widget } = await connectedWithOwnWidget();

        widget.delete();
        widget.label = 'after';
        await settle();

        expect(sent('model::delete')).toEqual([['del', { id: 'w1' }]]);
        expect(sent('model::update')).toEqual([]);
        expect(latest(models$)).toEqual([]);
    });

    it('deletes a model another client created', () => {
        new Colibri('app', 'localhost', 9211);
        const [models$] = RegisterModelSync({ name: 'del-theirs', type: Widget });
        connectSocket();
        deliver(fakeSocket, 'del-theirs', { command: 'model::update', payload: { id: 'r1', label: 'theirs' } });
        const [theirs] = latest(models$);
        fakeSocket.emit.mockClear();

        theirs.delete();

        expect(sent('model::delete')).toEqual([['del-theirs', { id: 'r1' }]]);
        expect(latest(models$)).toEqual([]);
    });

    it('sends the delete once, however often delete() is called', async () => {
        const { widget } = await connectedWithOwnWidget();

        widget.delete();
        widget.delete();

        expect(sent('model::delete')).toEqual([['del', { id: 'w1' }]]);
    });

    it('sends the delete once new Colibri() is constructed, when it is called before', () => {
        const [models$, registerModel] = RegisterModelSync({ name: 'del-early', type: Widget });
        const widget = new Widget('w1');
        registerModel(widget);
        widget.delete();
        expect(fakeSocket.emit).not.toHaveBeenCalled();

        new Colibri('app', 'localhost', 9211);

        expect(sent('model::delete')).toEqual([['del-early', { id: 'w1' }]]);
        // Nothing to ask for any more.
        expect(sent('model::request')).not.toContainEqual(['del-early', { id: 'w1' }]);
        expect(latest(models$)).toEqual([]);
    });

    it('sends no delete for a delete from another client, nor when registerModel replaces a listed copy', () => {
        new Colibri('app', 'localhost', 9211);
        const [models$, registerModel] = RegisterModelSync({ name: 'del', type: Widget });
        connectSocket();
        deliver(fakeSocket, 'del', { command: 'model::update', payload: { id: 'r1', label: 'theirs' } });
        deliver(fakeSocket, 'del', { command: 'model::update', payload: { id: 'r2', label: 'theirs' } });

        deliver(fakeSocket, 'del', { command: 'model::delete', payload: { id: 'r1' } });
        registerModel(new Widget('r2'));

        expect(sent('model::delete')).toEqual([]);
        expect(latest(models$).map(m => m.id)).toEqual(['r2']);
    });

    // Relayed before the server had the delete, another client's update comes after it.
    it('does not list a model it deleted again from an update in the next 60 s', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const { models$ } = await connectedWithOwnWidget();
        const [widget] = latest(models$);

        widget.delete();
        deliver(fakeSocket, 'del', { command: 'model::update', payload: { id: 'w1', label: 'late' } });
        expect(latest(models$)).toEqual([]);

        vi.setSystemTime(Date.now() + 60_000);
        deliver(fakeSocket, 'del', { command: 'model::update', payload: { id: 'w1', label: 'created again' } });
        expect(latest(models$).map(m => [m.id, m.label])).toEqual([['w1', 'created again']]);
    });

    // A fresh request, without `again`, lifts the server's memory of the delete.
    it('lists and asks for a model registered again with the id it deleted', async () => {
        const { models$, registerModel, widget } = await connectedWithOwnWidget();
        widget.delete();
        fakeSocket.emit.mockClear();

        const again = new Widget('w1');
        registerModel(again);
        deliver(fakeSocket, 'del', { command: 'model::update', payload: { id: 'w1', label: 'other' } });

        expect(sent('model::request').filter(([channel]) => channel === 'del')).toEqual([['del', { id: 'w1' }]]);
        expect(latest(models$)).toEqual([again]);
    });

    // A change still buffered goes out before the delete, never after it: with
    // MODEL_TOMBSTONE_SECONDS=0 that update created the object again on every client.
    it('sends a change made just before delete() ahead of the delete', async () => {
        const { widget } = await connectedWithOwnWidget();

        widget.label = 'last';
        widget.delete();
        await settle();

        expect(fakeSocket.emit.mock.calls.map(([, msg]) => (msg as Message).command)).toEqual([
            'model::update',
            'model::delete'
        ]);
    });

    // Socket.IO notices a connection that died without closing only after its ping timeout, and
    // what it sent until then is lost. colibri-unity sends such deletes again, and so does this.
    it('sends a delete again on a disconnect when nothing was heard from the server since', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const { widget } = await connectedWithOwnWidget();
        getAnyHandler(fakeSocket.onAny)('colibri', { command: 'latency', payload: '1' });
        vi.setSystemTime(Date.now() + 5_000);

        widget.delete();
        for (const [event, handler] of fakeSocket.on.mock.calls) {
            if (event === 'disconnect') handler('ping timeout');
        }

        expect(sent('model::delete')).toEqual([
            ['del', { id: 'w1' }],
            ['del', { id: 'w1' }]
        ]);
    });

    it('does not send a delete again that the server answered after', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const { widget } = await connectedWithOwnWidget();

        widget.delete();
        vi.setSystemTime(Date.now() + 5_000);
        getAnyHandler(fakeSocket.onAny)('colibri', { command: 'latency', payload: '1' });
        for (const [event, handler] of fakeSocket.on.mock.calls) {
            if (event === 'disconnect') handler('transport close');
        }

        expect(sent('model::delete')).toEqual([['del', { id: 'w1' }]]);
    });

    // An update another client sent before the server had the delete still comes after it. Taken
    // for the answer to registering the id again, it settled the new object with the deleted
    // one's values, and the new object was never sent.
    it('sends a model registered again with the id it deleted in full, and drops updates until the answer', async () => {
        const { models$, registerModel, widget } = await connectedWithOwnWidget();
        widget.delete();
        fakeSocket.emit.mockClear();

        const again = new Widget('w1');
        again.label = 'fresh';
        registerModel(again);
        deliver(fakeSocket, 'del', { command: 'model::update', payload: { id: 'w1', label: 'stale' } });
        deliver(fakeSocket, 'del', { command: 'model::update', payload: { id: 'w1' } });
        // What it sends is kept out of updates until the answers asked before are over.
        endOfAnswers(fakeSocket);
        deliver(fakeSocket, 'del', { command: 'model::update', payload: { id: 'w1', label: 'from another client' } });

        expect(sent('model::request').filter(([channel]) => channel === 'del')).toEqual([['del', { id: 'w1' }]]);
        expect(sent('model::update')).toEqual([['del', { id: 'w1', label: 'fresh' }]]);
        expect(latest(models$).map(m => m.label)).toEqual(['from another client']);
    });

    // Deleted by a subscriber of the list while the answer is applied: nothing goes out after the
    // delete for it.
    it('sends nothing more for a model a subscriber deletes as its answer is applied', async () => {
        class Pair extends SyncModel<Pair> {
            @Synced() accessor a = '';
            @Synced() accessor b = '';
        }
        new Colibri('app', 'localhost', 9211);
        const [models$, registerModel] = RegisterModelSync({ name: 'del', type: Pair });
        const pair = new Pair('p1');
        registerModel(pair);
        pair.a = 'held';
        connectSocket();
        const subscription = models$.subscribe(models => {
            if (models.some(m => m.b === 'server')) pair.delete();
        });

        deliver(fakeSocket, 'del', { command: 'model::update', payload: { id: 'p1', a: 'old', b: 'server' } });
        await settle();
        subscription.unsubscribe();

        const commands = fakeSocket.emit.mock.calls.map(([channel, msg]) => [channel, (msg as Message).command]);
        const afterDelete = commands.slice(commands.findIndex(([, c]) => c === 'model::delete') + 1);
        expect(afterDelete).not.toContainEqual(['del', 'model::update']);
        // Asking for every model still follows.
        expect(afterDelete).toContainEqual(['del', 'model::request']);
    });

    // Deleted while its answer is on its way: the answer settles nothing, and asking for every
    // model still follows.
    it('ignores the answer for a model deleted before it came, and still asks for every model', async () => {
        new Colibri('app', 'localhost', 9211);
        const [models$, registerModel] = RegisterModelSync({ name: 'del', type: Widget });
        const widget = new Widget('w1');
        widget.label = 'mine';
        registerModel(widget);
        connectSocket();
        expect(sent('model::request')).toContainEqual(['del', { id: 'w1' }]);

        widget.delete();
        deliver(fakeSocket, 'del', { command: 'model::update', payload: { id: 'w1' } });
        deliver(fakeSocket, 'del', { command: 'model::update', payload: { id: 'w1', label: 'server' } });
        await settle();

        expect(latest(models$)).toEqual([]);
        expect(sent('model::update')).toEqual([]);
        expect(sent('model::request')).toContainEqual(['del', {}]);
    });
});
