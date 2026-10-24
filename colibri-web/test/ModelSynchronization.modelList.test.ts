// A model class with methods named like SyncModel's, and the list of models a RegisterModelSync emits.
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
import { Widget, deliver, latest } from './support/modelSyncHelpers';

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

// SyncModel's own update(), toJson() and detach() are used, whatever a model class has under those
// names: an update() of its own, to move the model each frame say, took over how other clients'
// changes were applied, and none of them arrived.
describe("a model class with methods named like SyncModel's", () => {
    class Mover extends SyncModel<Mover> {
        @Synced() accessor x = 0;
        public moves = 0;

        // TypeScript takes this as an override: it has fewer parameters than SyncModel's.
        public update(): void {
            this.moves += 1;
        }

        public toJson(): Partial<Mover> {
            return {};
        }
    }

    const connectSocket = () => {
        for (const [event, handler] of fakeSocket.on.mock.calls) {
            if (event === 'connect') handler();
        }
    };

    it("takes other clients' changes and sends its own all the same", async () => {
        new Colibri('app', 'localhost', 9211);
        const [movers$] = RegisterModelSync({ name: 'movers', type: Mover });
        connectSocket();

        deliver(fakeSocket, 'movers', { command: 'model::update', payload: { id: 'm1', x: 5 } });
        const [mover] = latest(movers$);
        expect(mover.x).toBe(5);
        expect(mover.moves).toBe(0);

        fakeSocket.emit.mockClear();
        mover.x = 7;
        await new Promise(resolve => setTimeout(resolve, 10));

        const updates = fakeSocket.emit.mock.calls
            .filter(([, msg]) => (msg as Message).command === 'model::update')
            .map(([, msg]) => (msg as Message).payload);
        expect(updates).toEqual([{ id: 'm1', x: 7 }]);
    });
});

// A change of a model another client created made the list emit, one of this client's own did not,
// so a page rendering the list never showed it.
describe('the list of models', () => {
    it('emits when this client changes one of its own models', async () => {
        new Colibri('app', 'localhost', 9211);
        const [widgets$, registerWidget] = RegisterModelSync({ name: 'own-changes', type: Widget });
        const widget = new Widget('w1');
        registerWidget(widget);
        const emitted: string[][] = [];
        widgets$.subscribe(list => emitted.push(list.map(w => w.label)));

        widget.label = 'changed';
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(emitted.at(-1)).toEqual(['changed']);
        expect(emitted.length).toBeGreaterThan(1);
    });
});
