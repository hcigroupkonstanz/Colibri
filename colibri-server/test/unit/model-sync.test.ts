import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Subject, Subscription } from 'rxjs';
import { ConnectionPool, NetworkClient, NetworkMessage, NetworkServer } from '../../src/server/modules/command-hooks/connection-pool.js';
import { DataStore } from '../../src/server/modules/command-hooks/data-store.js';
import { ModelSynchronization } from '../../src/server/modules/command-hooks/model-sync.js';
import { Payload } from '../../src/server/modules/core/payload.js';
import { Service } from '../../src/server/modules/core/service.js';
import { LogLevel, LogMessage } from '../../src/server/modules/core/log-message.js';

// A transport without broadcastToApp, so every message the hooks send shows up in `sent` with
// the clients it went to. The payload is written down as it is sent, the way a real transport
// encodes it: the store keeps the very object a client's first update carried, and merges later
// updates into it.
class FakeServer implements NetworkServer {
    public readonly clientConnectedSource = new Subject<NetworkClient>();
    public readonly clientDisconnectedSource = new Subject<NetworkClient>();
    public readonly messagesSource = new Subject<NetworkMessage>();
    public clients: NetworkClient[] = [];
    public readonly sent: { command: string; payload: string | undefined; clients: ReadonlyArray<NetworkClient> }[] = [];

    public get currentClients(): ReadonlyArray<NetworkClient> {
        return this.clients;
    }
    public get clientConnected$() {
        return this.clientConnectedSource.asObservable();
    }
    public get clientDisconnected$() {
        return this.clientDisconnectedSource.asObservable();
    }
    public get messages$() {
        return this.messagesSource.asObservable();
    }

    public broadcast(message: NetworkMessage, clients: ReadonlyArray<NetworkClient>): void {
        this.sent.push({ command: message.command, payload: message.payload?.asString(), clients });
    }

    public connect(client: NetworkClient): NetworkClient {
        this.clients.push(client);
        this.clientConnectedSource.next(client);
        return client;
    }

    public disconnect(client: NetworkClient): void {
        this.clients = this.clients.filter(c => c.id !== client.id);
        this.clientDisconnectedSource.next(client);
    }
}

const makeClient = function (id: string, app = 'appA'): NetworkClient {
    return { id, app, name: `${id}-name`, version: '2', metadata: {} };
};

describe('ModelSynchronization', () => {
    let server: FakeServer;
    let store: DataStore;
    let logs: LogMessage[];
    let logSubscription: Subscription;

    beforeEach(() => {
        vi.useFakeTimers();
        server = new FakeServer();
        store = new DataStore();
        new ModelSynchronization(new ConnectionPool(server), store);
        logs = [];
        logSubscription = Service.output$.subscribe(msg => logs.push(msg));
    });

    afterEach(() => {
        logSubscription.unsubscribe();
        vi.useRealTimers();
    });

    const send = function (from: NetworkClient, command: string, payload: unknown, channel = 'objects'): void {
        server.messagesSource.next({ origin: from, channel, command, payload: Payload.fromValue(payload) });
    };

    // What went out, as "<command> <payload> -> <recipients>".
    const sent = (): string[] =>
        server.sent.map(s => `${s.command} ${s.payload} -> ${s.clients.map(c => c.id).join(',')}`);

    const debugLines = (): string[] => logs.filter(l => l.level === LogLevel.Debug).map(l => l.message);

    // An update that arrives after the object was deleted - another client's, sent before the
    // delete reached it, or one the server itself held back and passed on late - used to create
    // the model again and be relayed, so every client's manager spawned the object anew.
    describe('an update to a model deleted a moment ago', () => {
        it('is neither stored nor relayed when it comes from another client', () => {
            const mover = server.connect(makeClient('mover'));
            const deleter = server.connect(makeClient('deleter'));
            send(mover, 'model::update', { id: 'cube', x: 1 });

            send(deleter, 'model::delete', { id: 'cube' });
            send(mover, 'model::update', { id: 'cube', x: 2 });

            expect(store.getModel('appA', 'objects', 'cube')).toBeUndefined();
            expect(sent()).toEqual([
                'model::update {"id":"cube","x":1} -> deleter',
                'model::delete {"id":"cube"} -> mover',
            ]);
            const ignored = debugLines().filter(l => l.includes('Ignoring a model::update'));
            expect(ignored).toHaveLength(1);
            expect(ignored[0]).toContain('\'cube\'');
            expect(ignored[0]).toContain(mover.id);
        });

        it('leaves updates to other models, and to the same id on another channel, alone', () => {
            const mover = server.connect(makeClient('mover'));
            const deleter = server.connect(makeClient('deleter'));
            send(deleter, 'model::delete', { id: 'cube' });

            send(mover, 'model::update', { id: 'sphere', x: 1 });
            send(mover, 'model::update', { id: 'cube', x: 1 }, 'others');

            expect(store.getModel('appA', 'objects', 'sphere')).toEqual({ id: 'sphere', x: 1 });
            expect(store.getModel('appA', 'others', 'cube')).toEqual({ id: 'cube', x: 1 });
        });

        it('leaves another app\'s model of the same name alone', () => {
            const deleter = server.connect(makeClient('deleter', 'appA'));
            const other = server.connect(makeClient('other', 'appB'));
            send(deleter, 'model::delete', { id: 'cube' });

            send(other, 'model::update', { id: 'cube', x: 1 });

            expect(store.getModel('appB', 'objects', 'cube')).toEqual({ id: 'cube', x: 1 });
        });

        // A client knows nothing of the server's tombstones; a client creating the object again
        // on purpose says so with a fresh model::request { id } first (see 'a request for one model').
        it('is ignored from the client that deleted the model too, unless it asked for the id afresh first', () => {
            const mover = server.connect(makeClient('mover'));
            const deleter = server.connect(makeClient('deleter'));
            send(deleter, 'model::delete', { id: 'cube' });

            send(deleter, 'model::update', { id: 'cube', x: 5 });
            expect(store.getModel('appA', 'objects', 'cube')).toBeUndefined();

            // A scene it unloaded, loaded again: its placed object of the same id wakes and asks.
            send(deleter, 'model::request', { id: 'cube' });
            send(deleter, 'model::update', { id: 'cube', x: 6 });
            send(mover, 'model::update', { id: 'cube', y: 1 });

            expect(store.getModel('appA', 'objects', 'cube')).toEqual({ id: 'cube', x: 6, y: 1 });
            expect(sent()).toEqual([
                'model::delete {"id":"cube"} -> mover',
                'model::update {"id":"cube"} -> deleter',
                'model::update {"id":"cube","x":6} -> mover',
                'model::update {"id":"cube","y":1} -> deleter',
            ]);
        });

        it('creates the model again once the deletion is 10 minutes old', () => {
            const mover = server.connect(makeClient('mover'));
            const deleter = server.connect(makeClient('deleter'));
            send(deleter, 'model::delete', { id: 'cube' });

            vi.advanceTimersByTime(10 * 60 * 1000);
            send(mover, 'model::update', { id: 'cube', x: 2 });

            expect(store.getModel('appA', 'objects', 'cube')).toEqual({ id: 'cube', x: 2 });
        });

        it('creates the model again, as before, with tombstones turned off', () => {
            store.tombstoneMillis = 0;
            const mover = server.connect(makeClient('mover'));
            const deleter = server.connect(makeClient('deleter'));
            send(deleter, 'model::delete', { id: 'cube' });

            send(mover, 'model::update', { id: 'cube', x: 2 });

            expect(store.getModel('appA', 'objects', 'cube')).toEqual({ id: 'cube', x: 2 });
        });

        // The models go when the app's last client leaves, and the deletions with them: what the
        // next client brings is the app's state afresh.
        it('creates the model again once every client of the app has left', () => {
            const mover = server.connect(makeClient('mover'));
            const deleter = server.connect(makeClient('deleter'));
            send(deleter, 'model::delete', { id: 'cube' });
            server.disconnect(mover);
            server.disconnect(deleter);

            const next = server.connect(makeClient('next'));
            send(next, 'model::update', { id: 'cube', x: 3 });

            expect(store.getModel('appA', 'objects', 'cube')).toEqual({ id: 'cube', x: 3 });
        });

        it('is still refused while another client of the app stays connected', () => {
            const mover = server.connect(makeClient('mover'));
            const deleter = server.connect(makeClient('deleter'));
            send(deleter, 'model::delete', { id: 'cube' });
            server.disconnect(deleter);

            send(mover, 'model::update', { id: 'cube', x: 3 });

            expect(store.getModel('appA', 'objects', 'cube')).toBeUndefined();
        });
    });

    // A model::request { id } is fresh: the sender has the object in its scene now, or is creating
    // it. { id, again: true } asks again after a reconnect, for an object the sender held before.
    describe('a request for one model', () => {
        // A client that was offline while another deleted one of its objects never got the
        // relayed delete; the bare { id } it used to be answered with kept its stale copy alive.
        it('asked again after a reconnect is answered with a delete, to the requester alone, when the model was deleted meanwhile', () => {
            const deleter = server.connect(makeClient('deleter'));
            server.connect(makeClient('bystander'));
            send(deleter, 'model::update', { id: 'cube', x: 1 });
            send(deleter, 'model::delete', { id: 'cube' });
            // Back after an outage: a connection of its own, which the delete was never relayed to.
            const returning = server.connect(makeClient('returning'));
            server.sent.length = 0;

            send(returning, 'model::request', { id: 'cube', again: true });

            expect(sent()).toEqual(['model::delete {"id":"cube"} -> returning']);
        });

        // Its stale copy, or anyone else's, must still not bring the model back.
        it('asked again keeps the tombstone: the next returning client is told too, and stale updates stay ignored', () => {
            const deleter = server.connect(makeClient('deleter'));
            send(deleter, 'model::delete', { id: 'cube' });
            const first = server.connect(makeClient('first'));
            const second = server.connect(makeClient('second'));
            server.sent.length = 0;

            send(first, 'model::request', { id: 'cube', again: true });
            send(first, 'model::update', { id: 'cube', x: 9 });
            send(second, 'model::request', { id: 'cube', again: true });

            expect(store.getModel('appA', 'objects', 'cube')).toBeUndefined();
            expect(sent()).toEqual([
                'model::delete {"id":"cube"} -> first',
                'model::delete {"id":"cube"} -> second',
            ]);
        });

        // A scene with a placed object of a fixed id, loaded by another client within
        // MODEL_TOMBSTONE_SECONDS of the delete: it used to be answered with model::delete, which
        // destroyed the object it had just loaded, and its updates were ignored for 10 minutes.
        it('asked afresh by another client is answered with the bare id even though the model was deleted a moment ago, and its updates are taken', () => {
            const observer = server.connect(makeClient('observer'));
            const headsetA = server.connect(makeClient('headset-a'));
            send(headsetA, 'model::request', { id: 'door' });
            send(headsetA, 'model::update', { id: 'door', position: [1, 0, 0] });
            send(headsetA, 'model::delete', { id: 'door' });
            const headsetB = server.connect(makeClient('headset-b'));
            server.sent.length = 0;

            send(headsetB, 'model::request', { id: 'door' });
            send(headsetB, 'model::update', { id: 'door', position: [2, 0, 0] });

            expect(store.getModel('appA', 'objects', 'door')).toEqual({ id: 'door', position: [2, 0, 0] });
            expect(sent()).toEqual([
                'model::update {"id":"door"} -> headset-b',
                `model::update {"id":"door","position":[2,0,0]} -> ${observer.id},${headsetA.id}`,
            ]);
        });

        // The client that deleted it, back on a new connection (a Wi-Fi blip, the idle timeout),
        // loads the scene again. It used to be told to delete the objects it had just loaded.
        it('asked afresh by the client that deleted the model, after it reconnected, is answered with the bare id', () => {
            server.connect(makeClient('observer'));
            const questBefore = server.connect(makeClient('quest-conn-1'));
            send(questBefore, 'model::request', { id: 'lobby-table' });
            send(questBefore, 'model::update', { id: 'lobby-table', x: 1 });
            send(questBefore, 'model::delete', { id: 'lobby-table' });
            server.disconnect(questBefore);
            const questAfter = server.connect(makeClient('quest-conn-2'));
            vi.advanceTimersByTime(60_000);
            server.sent.length = 0;

            send(questAfter, 'model::request', { id: 'lobby-table' });
            send(questAfter, 'model::update', { id: 'lobby-table', x: 2 });

            expect(sent()).toEqual([
                'model::update {"id":"lobby-table"} -> quest-conn-2',
                'model::update {"id":"lobby-table","x":2} -> observer',
            ]);
            expect(store.getModel('appA', 'objects', 'lobby-table')).toEqual({ id: 'lobby-table', x: 2 });
            expect(debugLines().filter(l => l.includes('Ignoring a model::update'))).toEqual([]);
        });

        // The id is in use again, for everyone: a client returning afterwards keeps its copy.
        it('asked afresh lifts the tombstone, so a later request asked again is answered with the bare id', () => {
            const deleter = server.connect(makeClient('deleter'));
            send(deleter, 'model::delete', { id: 'door' });
            // The scene loaded again, the door static: it is asked for, but nothing is sent for it.
            send(deleter, 'model::request', { id: 'door' });
            const returning = server.connect(makeClient('returning'));
            server.sent.length = 0;

            send(returning, 'model::request', { id: 'door', again: true });

            expect(sent()).toEqual(['model::update {"id":"door"} -> returning']);
            expect(store.deletion('appA', 'objects', 'door')).toBeUndefined();
        });

        it('asked afresh lifts the tombstone on its own channel and app only', () => {
            const deleter = server.connect(makeClient('deleter'));
            const otherApp = server.connect(makeClient('other', 'appB'));
            send(deleter, 'model::delete', { id: 'door' });
            send(deleter, 'model::delete', { id: 'door' }, 'others');

            send(deleter, 'model::request', { id: 'door' }, 'others');
            send(otherApp, 'model::request', { id: 'door' });

            expect(store.deletion('appA', 'objects', 'door')).toBeDefined();
            expect(store.deletion('appA', 'others', 'door')).toBeUndefined();
        });

        it('is answered with the bare id for an id the server simply does not know, asked afresh or again', () => {
            const client = server.connect(makeClient('client'));

            send(client, 'model::request', { id: 'new-object' });
            send(client, 'model::request', { id: 'other-object', again: true });

            expect(sent()).toEqual([
                'model::update {"id":"new-object"} -> client',
                'model::update {"id":"other-object"} -> client',
            ]);
        });

        it('is answered with the model when there is one, asked afresh or again', () => {
            const owner = server.connect(makeClient('owner'));
            const client = server.connect(makeClient('client'));
            send(owner, 'model::update', { id: 'cube', x: 1 });
            server.sent.length = 0;

            send(client, 'model::request', { id: 'cube' });
            send(client, 'model::request', { id: 'cube', again: true });

            expect(sent()).toEqual([
                'model::update {"id":"cube","x":1} -> client',
                'model::update {"id":"cube","x":1} -> client',
            ]);
        });

        // Only `again: true` asks again; anything else in the payload is ignored.
        it('counts as asked afresh unless again is true, and ignores other fields', () => {
            const deleter = server.connect(makeClient('deleter'));
            const client = server.connect(makeClient('client'));
            send(deleter, 'model::delete', { id: 'a' });
            send(deleter, 'model::delete', { id: 'b' });
            server.sent.length = 0;

            send(client, 'model::request', { id: 'a', again: 'true', note: 'x' });
            send(client, 'model::request', { id: 'b', again: true, note: 'x' });

            expect(sent()).toEqual([
                'model::update {"id":"a"} -> client',
                'model::delete {"id":"b"} -> client',
            ]);
        });

        it('asked again is answered with the bare id once the deletion is 10 minutes old', () => {
            const deleter = server.connect(makeClient('deleter'));
            const client = server.connect(makeClient('client'));
            send(deleter, 'model::delete', { id: 'cube' });
            server.sent.length = 0;

            vi.advanceTimersByTime(10 * 60 * 1000);
            send(client, 'model::request', { id: 'cube', again: true });

            expect(sent()).toEqual(['model::update {"id":"cube"} -> client']);
        });

        it('asked again is answered with the bare id with tombstones turned off', () => {
            store.tombstoneMillis = 0;
            const deleter = server.connect(makeClient('deleter'));
            const client = server.connect(makeClient('client'));
            send(deleter, 'model::delete', { id: 'cube' });
            server.sent.length = 0;

            send(client, 'model::request', { id: 'cube', again: true });

            expect(sent()).toEqual(['model::update {"id":"cube"} -> client']);
        });

        it('is answered with the model once a client has created it again', () => {
            const deleter = server.connect(makeClient('deleter'));
            const client = server.connect(makeClient('client'));
            send(deleter, 'model::delete', { id: 'cube' });
            send(deleter, 'model::request', { id: 'cube' });
            send(deleter, 'model::update', { id: 'cube', x: 2 });
            server.sent.length = 0;

            send(client, 'model::request', { id: 'cube', again: true });

            expect(sent()).toEqual(['model::update {"id":"cube","x":2} -> client']);
        });
    });


    describe('a request for every model of a channel', () => {
        it('is answered with the models there are, and nothing about deleted ones', () => {
            const owner = server.connect(makeClient('owner'));
            const client = server.connect(makeClient('client'));
            send(owner, 'model::update', { id: 'kept', x: 1 });
            send(owner, 'model::update', { id: 'deleted', x: 1 });
            send(owner, 'model::delete', { id: 'deleted' });
            server.sent.length = 0;

            send(client, 'model::request', null);

            expect(sent()).toEqual(['model::update {"id":"kept","x":1} -> client']);
        });
    });
});
