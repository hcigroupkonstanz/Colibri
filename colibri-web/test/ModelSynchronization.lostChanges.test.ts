// Sending again a change that a connection which died without closing lost.
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
import { deliver, endOfAnswers, latest } from './support/modelSyncHelpers';

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

// A connection that dies without closing (Wi-Fi dropping out, say) is noticed by Socket.IO only once
// its ping timeout has run out, and a change sent until then is lost. The answer to asking for the
// model again after the reconnect then had the value from before it, and applying it undid the
// change on this client alone: the server and every other client never saw it.
describe('sending again a change lost in a connection that died', () => {
    const connectSocket = () => {
        for (const [event, handler] of fakeSocket.on.mock.calls) {
            if (event === 'connect') handler();
        }
    };

    const disconnectSocket = () => {
        for (const [event, handler] of fakeSocket.on.mock.calls) {
            if (event === 'disconnect') handler('ping timeout');
        }
    };

    // What every message from the server goes through, the latency probe that comes every 100 ms
    // included: it is how the client knows when it last heard from the server.
    const hearFromServer = () => {
        getAnyHandler(fakeSocket.onAny)('colibri', { command: 'latency', payload: '1' });
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

    let clock = 1_000_000;
    let debugSpy: ReturnType<typeof vi.spyOn>;
    let nowSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        clock = 1_000_000;
        debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
        nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    });

    afterEach(() => {
        debugSpy.mockRestore();
        nowSpy.mockRestore();
    });

    /**
     * A Colibri with an own Pair 'p1' that the server had nothing for, so it was sent in full
     * (a: 'A', b: 'B'), and then the request for every model answered with it, and the answers
     * over.
     */
    const connectedWithOwnPair = async () => {
        new Colibri('app', 'localhost', 9211);
        const [models$, registerModel] = RegisterModelSync({ name: 'own', type: Pair });
        const pair = new Pair('p1');
        pair.a = 'A';
        pair.b = 'B';
        registerModel(pair);
        connectSocket();
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1' } });
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();
        fakeSocket.emit.mockClear();
        return { models$, pair };
    };

    /** Changes `a` while connected, so that it is sent, and the connection then dies. */
    const sendAndDie = async (pair: Pair, a: string) => {
        fakeSocket.emit.mockClear();
        pair.a = a;
        await settle();
        expect(sentInOrder()).toEqual([['model::update', { id: 'p1', a }]]);
        hearFromServer();
        disconnectSocket();
        connectSocket();
        fakeSocket.emit.mockClear();
    };

    it('keeps and sends again a change when the answer has the value from before it', async () => {
        const { models$, pair } = await connectedWithOwnPair();
        pair.a = 'A2';
        await settle();
        await sendAndDie(pair, 'A3');

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A2', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect([pair.a, pair.b]).toEqual(['A3', 'B']);
        expect(latest(models$)).toEqual([pair]);
        // Sent again, and asked for again to see that the server has it now.
        expect(sentInOrder()).toEqual([
            ['model::update', { id: 'p1', a: 'A3' }],
            ['model::request', { id: 'p1', again: true }]
        ]);

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A3', b: 'B' } });
        endOfAnswers(fakeSocket);
        expect(sentInOrder().slice(2)).toEqual([['model::request', {}]]);
        expect(pair.a).toBe('A3');
    });

    // A model that changes all the time, a tracked pose say, changed again before every answer: the
    // changes made meanwhile went out with one more request each time, so the model stayed asked
    // for, one update a round trip went out, and everything else was never asked for.
    it('asks for every model after asking again once, though the model changed before every answer', async () => {
        const { pair } = await connectedWithOwnPair();
        await sendAndDie(pair, 'A2');
        pair.b = 'B1';
        await settle();
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();
        expect(sentInOrder()).toEqual([
            ['model::update', { id: 'p1', a: 'A2', b: 'B1' }],
            ['model::request', { id: 'p1', again: true }]
        ]);

        pair.b = 'B2';
        await settle();
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A2', b: 'B1' } });
        endOfAnswers(fakeSocket);
        pair.b = 'B3';
        await settle();
        expect([pair.a, pair.b]).toEqual(['A2', 'B3']);
        expect(sentInOrder().slice(2)).toEqual([
            ['model::update', { id: 'p1', b: 'B2' }],
            ['model::request', {}],
            ['model::update', { id: 'p1', b: 'B3' }]
        ]);
    });

    // The value the server last showed this client counts as one from before the change, too.
    it('does so for the first change made after the server last showed the field', async () => {
        const { pair } = await connectedWithOwnPair();
        await sendAndDie(pair, 'A2');

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect(pair.a).toBe('A2');
        expect(sentInOrder()).toEqual([
            ['model::update', { id: 'p1', a: 'A2' }],
            ['model::request', { id: 'p1', again: true }]
        ]);
    });

    it('sends it in one update with a change made while disconnected', async () => {
        const { pair } = await connectedWithOwnPair();
        pair.a = 'A2';
        await settle();
        hearFromServer();
        disconnectSocket();
        pair.b = 'B2';
        await settle();
        connectSocket();
        fakeSocket.emit.mockClear();

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect([pair.a, pair.b]).toEqual(['A2', 'B2']);
        expect(sentInOrder()).toEqual([
            ['model::update', { id: 'p1', a: 'A2', b: 'B2' }],
            ['model::request', { id: 'p1', again: true }]
        ]);
    });

    it('sends nothing when the answer has the last change sent', async () => {
        const { pair } = await connectedWithOwnPair();
        await sendAndDie(pair, 'A2');

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A2', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect(pair.a).toBe('A2');
        expect(sentInOrder()).toEqual([['model::request', {}]]);
    });

    it('takes a value it never had: another client set it while this one was away', async () => {
        const { pair } = await connectedWithOwnPair();
        await sendAndDie(pair, 'A2');

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'theirs', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect(pair.a).toBe('theirs');
        expect(sentInOrder()).toEqual([['model::request', {}]]);
    });

    // The server showed that it had moved on from the change, so the older value is another
    // client's, set again.
    it('takes a value from before the change when the server showed a newer one since', async () => {
        const { pair } = await connectedWithOwnPair();
        pair.a = 'A2';
        await settle();
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'theirs' } });
        hearFromServer();
        disconnectSocket();
        connectSocket();
        fakeSocket.emit.mockClear();

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect(pair.a).toBe('A');
        expect(sentInOrder()).toEqual([['model::request', {}]]);
    });

    // A change followed by more than KNOWN_VALUES_MS of a working connection arrived for certain:
    // the server answering with the value from before it means another client set that again.
    it('takes a value from before a change sent long before the connection stopped working', async () => {
        const { pair } = await connectedWithOwnPair();
        pair.a = 'A2';
        await settle();
        clock += 11_000;
        hearFromServer();
        disconnectSocket();
        // However long Socket.IO took to notice.
        clock += 60_000;
        connectSocket();
        fakeSocket.emit.mockClear();

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect(pair.a).toBe('A');
        expect(sentInOrder()).toEqual([['model::request', {}]]);
    });

    it('counts back from when it last heard from the server, not from when it noticed', async () => {
        const { pair } = await connectedWithOwnPair();
        pair.a = 'A2';
        await settle();
        clock += 9_000;
        hearFromServer();
        // The default ping timeout, 25 s and 20 s, before Socket.IO noticed.
        clock += 45_000;
        disconnectSocket();
        connectSocket();
        fakeSocket.emit.mockClear();

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect(pair.a).toBe('A2');
        expect(sentInOrder()[0]).toEqual(['model::update', { id: 'p1', a: 'A2' }]);
    });

    // Only the answer to asking again after a reconnect: an update relayed from another client is
    // that client's change, made after this one's.
    it('applies an update another client made as it comes, whatever value it has', async () => {
        const { pair } = await connectedWithOwnPair();
        pair.a = 'A2';
        await settle();
        fakeSocket.emit.mockClear();

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A' } });
        await settle();

        expect(pair.a).toBe('A');
        expect(sentInOrder()).toEqual([]);
    });

    // The server relays another client's update to the new connection as it comes, so one made right
    // after the reconnect arrives ahead of the answer. Taken for the answer, it settled the model:
    // the field lost was not in it and never checked, and the answer that followed undid the change.
    it("checks every update until the answers are over, another client's that comes first included", async () => {
        const { pair } = await connectedWithOwnPair();
        await sendAndDie(pair, 'A2');

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', b: 'theirs' } });
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'theirs' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect([pair.a, pair.b]).toEqual(['A2', 'theirs']);
        expect(sentInOrder()).toEqual([
            ['model::update', { id: 'p1', a: 'A2' }],
            ['model::request', { id: 'p1', again: true }]
        ]);
    });

    // Nor may such an update end the outage the change is judged from, when the connection dies again
    // before the answer comes.
    it("still judges from the earlier outage when another client's update came before the next one", async () => {
        const { pair } = await connectedWithOwnPair();
        await sendAndDie(pair, 'A2');
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', b: 'theirs' } });
        clock += 15_000;
        hearFromServer();
        disconnectSocket();
        connectSocket();
        fakeSocket.emit.mockClear();

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'theirs' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect([pair.a, pair.b]).toEqual(['A2', 'theirs']);
        expect(sentInOrder()).toEqual([
            ['model::update', { id: 'p1', a: 'A2' }],
            ['model::request', { id: 'p1', again: true }]
        ]);
    });

    it('still drops the model when the answer is model::delete', async () => {
        const { models$, pair } = await connectedWithOwnPair();
        await sendAndDie(pair, 'A2');

        deliver(fakeSocket, 'own', { command: 'model::delete', payload: { id: 'p1' } });
        await settle();

        expect(latest(models$)).toEqual([]);
        expect(sentInOrder()).toEqual([['model::request', {}]]);
    });

    // Each RegisterModelSync sends its own request after its re-requests, so the answer to the one
    // sent first comes ahead of the answers to the next one's re-requests. Taken for the end of those,
    // it settled the model early, and the answer that came next undid the change.
    it('waits for the end of its own answers when another RegisterModelSync asked again first', async () => {
        new Colibri('app', 'localhost', 9211);
        const [, registerOther] = RegisterModelSync({ name: 'other', type: Pair });
        const [, registerModel] = RegisterModelSync({ name: 'own', type: Pair });
        registerOther(new Pair('q1'));
        const pair = new Pair('p1');
        pair.a = 'A';
        pair.b = 'B';
        registerModel(pair);
        connectSocket();
        deliver(fakeSocket, 'other', { command: 'model::update', payload: { id: 'q1' } });
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1' } });
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();
        await sendAndDie(pair, 'A2');
        expect(fakeSocket.endMarkers).toHaveLength(2);

        deliver(fakeSocket, 'other', { command: 'model::update', payload: { id: 'q1', a: '', b: '' } });
        endOfAnswers(fakeSocket, 1);
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect(pair.a).toBe('A2');
        expect(sentInOrder()).toEqual([
            ['model::update', { id: 'p1', a: 'A2' }],
            ['model::request', { id: 'p1', again: true }]
        ]);
    });

    // detach() stops this client sending the model's changes, a lost one sent again among them.
    it('sends nothing for a model whose detach() was called before the answers are over', async () => {
        const { models$, pair } = await connectedWithOwnPair();
        await sendAndDie(pair, 'A2');

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        pair.detach();
        endOfAnswers(fakeSocket);
        await settle();

        expect(latest(models$)).toEqual([pair]);
        expect(sentInOrder()).toEqual([['model::request', {}]]);
    });

    it('sends nothing for a model whose detach() was called before the answer came', async () => {
        const { models$, pair } = await connectedWithOwnPair();
        await sendAndDie(pair, 'A2');

        pair.detach();
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect(sentInOrder()).toEqual([['model::request', {}]]);
        expect(latest(models$)).toEqual([pair]);
        expect(pair.a).toBe('A');
    });

    it('sends it again after another reconnect when the update sending it again was lost too', async () => {
        const { pair } = await connectedWithOwnPair();
        await sendAndDie(pair, 'A2');
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();
        hearFromServer();
        disconnectSocket();
        connectSocket();
        fakeSocket.emit.mockClear();

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect(pair.a).toBe('A2');
        expect(sentInOrder()).toEqual([
            ['model::update', { id: 'p1', a: 'A2' }],
            ['model::request', { id: 'p1', again: true }]
        ]);
    });

    // The connection died again before the answer to asking again came, long after the change: the
    // change is still judged from when this client last heard from the server before the first.
    it('sends it again when the connection dies again before the answer comes', async () => {
        const { pair } = await connectedWithOwnPair();
        await sendAndDie(pair, 'A2');
        clock += 15_000;
        hearFromServer();
        disconnectSocket();
        connectSocket();
        fakeSocket.emit.mockClear();

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect(pair.a).toBe('A2');
        expect(sentInOrder()).toEqual([
            ['model::update', { id: 'p1', a: 'A2' }],
            ['model::request', { id: 'p1', again: true }]
        ]);
    });

    // The answer came only after a while, and the update sending the change again was lost in a
    // connection that died soon after: the value that answer had tells, however long before the
    // change itself was made.
    it('sends it again when the update sending it again is lost long after the change', async () => {
        const { pair } = await connectedWithOwnPair();
        await sendAndDie(pair, 'A2');
        clock += 15_000;
        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();
        expect(sentInOrder()[0]).toEqual(['model::update', { id: 'p1', a: 'A2' }]);
        hearFromServer();
        disconnectSocket();
        connectSocket();
        fakeSocket.emit.mockClear();

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect(pair.a).toBe('A2');
        expect(sentInOrder()).toEqual([
            ['model::update', { id: 'p1', a: 'A2' }],
            ['model::request', { id: 'p1', again: true }]
        ]);
    });

    /** Changes `a` to each of `values` in turn, `apart` ms apart, hearing nothing from the server. */
    const changeWithoutHearing = async (pair: Pair, values: string[], apart: number) => {
        for (const a of values) {
            clock += apart;
            pair.a = a;
            await settle();
        }
    };

    /** Socket.IO noticing the dead connection, once its ping timeout has run out, and connecting again. */
    const noticeAndReconnect = () => {
        clock += 45_000;
        disconnectSocket();
        connectSocket();
        fakeSocket.emit.mockClear();
    };

    /** What a field shows while `word` is typed into it, one key at a time. */
    const typing = (word: string) => Array.from(word, (_, i) => word.slice(0, i + 1));
    const WORD = 'typed one key at a time';

    // Every change made until Socket.IO notices is sent into the dead link, each key typed included,
    // so the value the server has may be many changes back by then.
    it.each([
        ['as fast as they come', 1],
        ['one a second', 1_000]
    ])('does so after many more changes went into the dead link, %s', async (_, apart) => {
        const { pair } = await connectedWithOwnPair();
        pair.a = 'A2';
        await settle();
        hearFromServer();
        await changeWithoutHearing(pair, typing(WORD), apart);
        noticeAndReconnect();

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A2', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect(pair.a).toBe(WORD);
        expect(sentInOrder()).toEqual([
            ['model::update', { id: 'p1', a: WORD }],
            ['model::request', { id: 'p1', again: true }]
        ]);
    });

    // The latency probe comes every 100 ms, so a connection stops working at most about that long
    // after the server was last heard from, and a change sent in between may still have reached it.
    it('does so when the server got a change sent after it was last heard from', async () => {
        const { pair } = await connectedWithOwnPair();
        hearFromServer();
        await changeWithoutHearing(pair, ['A2'], 50);
        await changeWithoutHearing(pair, typing(WORD), 100);
        noticeAndReconnect();

        deliver(fakeSocket, 'own', { command: 'model::update', payload: { id: 'p1', a: 'A2', b: 'B' } });
        endOfAnswers(fakeSocket);
        await settle();

        expect(pair.a).toBe(WORD);
        expect(sentInOrder()).toEqual([
            ['model::update', { id: 'p1', a: WORD }],
            ['model::request', { id: 'p1', again: true }]
        ]);
    });
});
