import { afterEach, describe, expect, it } from 'vitest';
import { firstValueFrom, type Observable } from 'rxjs';
import { filter, take, timeout, toArray } from 'rxjs/operators';
import {
    connectAsAdminUi,
    createClient,
    createClientThrough,
    createPeer,
    createSingletonWithPeer,
    disconnectAll,
    dropConnection,
    dropConnectionUntilReleased,
    isConnected,
    nextConnect,
    nextMessage,
    resetSingleton,
    startLinkProxy,
    uniqueApp
} from './helpers';
import type { Colibri } from '../src/Colibri';
import { Sync } from '../src/Broadcasting';
import { RegisterModelSync } from '../src/ModelSynchronization';
import { SyncModel } from '../src/SyncModel';
import { Synced } from '../src/Synced';
import { RemoteLogger } from '../src/RemoteLogger';

afterEach(() => {
    disconnectAll();
});

describe('Sync (Broadcasting) high-level API', () => {
    it('Sync.sendJson on the singleton is received by a raw peer as broadcast::json', async () => {
        const { peer } = await createSingletonWithPeer(uniqueApp('sync-app'));
        const channel = uniqueApp('sync-channel');

        const peerPromise = nextMessage(peer, {
            channel,
            command: 'broadcast::json'
        });

        Sync.sendJson(channel, { hello: 'world' });

        const msg = await peerPromise;
        expect(msg.payload).toEqual({ hello: 'world' });
    });

    it('Sync.sendFloat (Unity compatibility alias) is received as broadcast::float', async () => {
        const { peer } = await createSingletonWithPeer(uniqueApp('sync-app-float'));
        const channel = uniqueApp('sync-channel-float');

        const peerPromise = nextMessage(peer, {
            channel,
            command: 'broadcast::float'
        });

        Sync.sendFloat(channel, 3.5);

        const msg = await peerPromise;
        expect(msg.payload).toBe(3.5);
    });

    it('Sync.receiveBool fires when the raw peer sends a matching broadcast', async () => {
        const { peer } = await createSingletonWithPeer(uniqueApp('sync-app-recv'));
        const channel = uniqueApp('sync-channel-recv');

        const received = await new Promise<boolean>(resolve => {
            Sync.receiveBool(channel, resolve);
            peer.sendMessage(channel, 'broadcast::bool', true);
        });

        expect(received).toBe(true);
    });
});

describe('RegisterModelSync high-level API', () => {
    class TestModel extends SyncModel<TestModel> {
        @Synced()
        accessor value = '';
    }

    it('propagates a locally registered model to a raw peer', async () => {
        const { peer } = await createSingletonWithPeer(uniqueApp('modelsync-app'));
        const channelName = 'testmodel';

        const [, registerModel] = RegisterModelSync<TestModel>({
            type: TestModel
        });

        const model = new TestModel('model-1');
        model.value = 'initial';

        const peerUpdatePromise = nextMessage(peer, {
            channel: channelName,
            command: 'model::update'
        });

        registerModel(model);

        const msg = await peerUpdatePromise;
        expect(msg.payload).toEqual({ id: 'model-1', value: 'initial' });
    });

    it('adds a model to the observable array when a peer sends an inbound model::update', async () => {
        const { peer } = await createSingletonWithPeer(uniqueApp('modelsync-app-inbound'));
        const channelName = 'testmodel';

        const [models$] = RegisterModelSync<TestModel>({ type: TestModel });

        const modelsPromise = firstValueFrom(
            models$.pipe(
                filter(models => models.some(m => m.id === 'model-2')),
                timeout(5000)
            )
        );

        peer.sendMessage(channelName, 'model::update', {
            id: 'model-2',
            value: 'from-peer'
        });

        const models = await modelsPromise;
        const found = models.find(m => m.id === 'model-2');
        expect(found?.value).toBe('from-peer');
    });

    // The server relays model updates and does not replay them, so a client that missed one
    // while disconnected used to stay stale until that model happened to change again.
    it('catches up on a model update it missed while disconnected', async () => {
        const { singleton, peer } = await createSingletonWithPeer(uniqueApp('modelsync-app-resync'));
        const channelName = 'testmodel';

        const [models$] = RegisterModelSync<TestModel>({ type: TestModel });
        const modelWithValue = async (value: string) => {
            const models = await firstValueFrom(
                models$.pipe(
                    filter(ms => ms.some(m => m.id === 'model-3' && m.value === value)),
                    timeout(10_000)
                )
            );
            return models.filter(m => m.id === 'model-3');
        };

        const before = modelWithValue('before');
        peer.sendMessage(channelName, 'model::update', { id: 'model-3', value: 'before' });
        const [original] = await before;

        // A real outage: the transport goes away underneath Socket.IO, which reconnects by itself.
        await dropConnection(singleton);
        peer.sendMessage(channelName, 'model::update', { id: 'model-3', value: 'missed' });

        // Make sure the server stored that while the singleton was still away. It handles one
        // client's messages in order, so its answer to the peer's own request comes after it.
        const stored = nextMessage(peer, { channel: channelName, command: 'model::update' });
        peer.sendMessage(channelName, 'model::request');
        expect((await stored).payload).toEqual({ id: 'model-3', value: 'missed' });
        expect(isConnected(singleton)).toBe(false);

        // Updated in place: the answer to the re-request must not add a second model-3.
        const after = await modelWithValue('missed');
        expect(after).toHaveLength(1);
        expect(after[0]).toBe(original);
    });
});

const latest = <T>(models$: Observable<T[]>): T[] => {
    let current: T[] = [];
    models$.subscribe(m => (current = m)).unsubscribe();
    return current;
};

/** What the server has stored for `id`, asked for through `client`, which receives the answer. */
const storedOn = async (client: Colibri, channel: string, id: string) => {
    const answer = nextMessage(client, { channel, command: 'model::update' });
    client.sendMessage(channel, 'model::request', { id });
    return (await answer).payload;
};

/**
 * Resolves once the server has handled everything `client` sent before this, and `client` has
 * been handed everything the server sent it until then. On a channel of its own, so that no
 * RegisterModelSync mistakes the answer for a model.
 */
const roundTrip = async (client: Colibri) => {
    const fence = uniqueApp('fence');
    const answer = nextMessage(client, { channel: fence, command: 'model::update' });
    client.sendMessage(fence, 'model::request', { id: 'fence' });
    await answer;
};

/**
 * Resolves once a RegisterModelSync made just before has the answer to its request for every model.
 * It asks on the next task, after the models registered in the same block of code.
 */
const listed = async (client: Colibri) => {
    await new Promise(resolve => setTimeout(resolve, 0));
    await roundTrip(client);
};

/** Every model::update `client` receives on `channel` until `until` resolves. */
const updatesDuring = async (client: Colibri, channel: string, until: () => Promise<unknown>) => {
    const received: unknown[] = [];
    const subscription = client.messages.subscribe(msg => {
        if (msg.channel === channel && msg.command === 'model::update') received.push(msg.payload);
    });
    try {
        await until();
    } finally {
        subscription.unsubscribe();
    }
    return received;
};

// Every RegisterModelSync on a channel receives the answer to a request another one on the same
// page sent. The bare answer for an id the server did not have was listed by the other one as a
// model with no fields, which nothing ever filled in: the full state sent in reply is relayed to
// every client but this one.
describe('RegisterModelSync twice on one channel', () => {
    class Shared extends SyncModel<Shared> {
        @Synced()
        accessor value = '';
    }

    it('does not list a model with no fields for an id the other one registers', async () => {
        const app = uniqueApp('modelsync-two-on-a-channel');
        const channel = uniqueApp('shared');
        const page = await createClient(app);
        const [, registerModel] = RegisterModelSync<Shared>({ name: channel, type: Shared });
        const [other$] = RegisterModelSync<Shared>({ name: channel, type: Shared });
        await listed(page);

        const mine = new Shared('mine');
        mine.value = 'set';
        registerModel(mine);
        await roundTrip(page);
        await roundTrip(page);

        expect(latest(other$)).toEqual([]);
    });

    // The other one is created later, on a re-render say, and asks for every model. Its answer, made
    // before the server had a change this one sent just after, undid the change on this page only.
    it('keeps a change sent just after the other one asked for every model', async () => {
        const app = uniqueApp('modelsync-two-asking');
        const channel = uniqueApp('shared');
        const peer = await createClient(app);
        const link = await startLinkProxy(25);
        const page = await createClientThrough(app, link);
        const [, registerModel] = RegisterModelSync<Shared>({ name: channel, type: Shared });
        const session = new Shared('session');
        session.value = 'running';
        registerModel(session);
        // The answer for the id, then the one for every model, and the request after it.
        await listed(page);
        await roundTrip(page);

        RegisterModelSync<Shared>({ name: channel, type: Shared });
        // Asked for every model by now.
        await new Promise(resolve => setTimeout(resolve, 0));
        session.value = 'mine';

        const peerSaw = await updatesDuring(peer, channel, async () => {
            for (let i = 0; i < 3; i++) await roundTrip(page);
            await roundTrip(peer);
        });
        expect({
            page: session.value,
            server: await storedOn(peer, channel, 'session'),
            peerLastSaw: peerSaw.at(-1)
        }).toEqual({
            page: 'mine',
            server: { id: 'session', value: 'mine' },
            peerLastSaw: { id: 'session', value: 'mine' }
        });
    });
});

// The server forgets an app's models when its last client leaves, and a model a client had
// registered itself was never sent again - so a client that joined after the outage never saw it.
describe('RegisterModelSync own models after a reconnect', () => {
    class OwnModel extends SyncModel<OwnModel> {
        @Synced()
        accessor value = '';
    }

    it('sends its own model again after the server forgot it, so a client joining later sees it', async () => {
        const app = uniqueApp('modelsync-own-forgotten');
        const channel = uniqueApp('own');
        // Alone in its app, so the server forgets the app's models when it drops.
        const singleton = await createClient(app);

        const [, registerModel] = RegisterModelSync<OwnModel>({ name: channel, type: OwnModel });
        const model = new OwnModel('own-1');
        model.value = 'mine';
        registerModel(model);
        // Sent once the server has answered the request for it, which is before the answer to this.
        await roundTrip(singleton);
        expect(await storedOn(singleton, channel, 'own-1')).toEqual({ id: 'own-1', value: 'mine' });

        const admin = await connectAsAdminUi();
        const gone = admin.disconnected(app);
        const reconnect = await dropConnectionUntilReleased(singleton);
        await gone;

        // Forgotten: a client joining now is told nothing but the id.
        const peer = await createPeer(app);
        expect(await storedOn(peer, channel, 'own-1')).toEqual({ id: 'own-1' });

        const sentAgain = nextMessage(peer, { channel, command: 'model::update' });
        await reconnect();
        expect((await sentAgain).payload).toEqual({ id: 'own-1', value: 'mine' });

        // And a client joining after that finds it on the server.
        const late = await createPeer(app);
        expect(await storedOn(late, channel, 'own-1')).toEqual({ id: 'own-1', value: 'mine' });
    });

    it('takes what the server has for its own model instead of overwriting it', async () => {
        const app = uniqueApp('modelsync-own-newer');
        const channel = uniqueApp('own');
        // The peer stays connected throughout, so the server keeps the app's models.
        const { singleton, peer } = await createSingletonWithPeer(app);

        const [models$, registerModel] = RegisterModelSync<OwnModel>({ name: channel, type: OwnModel });
        const model = new OwnModel('own-2');
        model.value = 'mine';
        const arrived = nextMessage(peer, { channel, command: 'model::update' });
        registerModel(model);
        await arrived;

        const reconnect = await dropConnectionUntilReleased(singleton);
        peer.sendMessage(channel, 'model::update', { id: 'own-2', value: 'newer' });
        expect(await storedOn(peer, channel, 'own-2')).toEqual({ id: 'own-2', value: 'newer' });

        // Both answers: to the request for every model, and to the one for own-2.
        const answers = firstValueFrom(
            singleton.messages.pipe(
                filter(msg => msg.channel === channel && msg.command === 'model::update'),
                take(2),
                toArray(),
                timeout(10_000)
            )
        );
        await reconnect();
        expect((await answers).map(msg => msg.payload)).toEqual([
            { id: 'own-2', value: 'newer' },
            { id: 'own-2', value: 'newer' }
        ]);
        expect(latest(models$)).toEqual([model]);
        expect(model.value).toBe('newer');

        // The server handles one client's messages in order, so anything the singleton sent over
        // the newer value in reply to those would have been applied before it answers this.
        expect(await storedOn(singleton, channel, 'own-2')).toEqual({ id: 'own-2', value: 'newer' });
    });

    class PairModel extends SyncModel<PairModel> {
        @Synced()
        accessor a = '';

        @Synced()
        accessor b = '';
    }

    // Longer than SyncModel's 1ms buffer, so a change has been reported - and sent, or not - by then.
    const reported = () => new Promise(resolve => setTimeout(resolve, 20));

    it('sends every field again after the server forgot its own model, also one it changed while away', async () => {
        const app = uniqueApp('modelsync-own-changed-away');
        const channel = uniqueApp('own');
        // Alone in its app, so the server forgets the app's models when it drops.
        const singleton = await createClient(app);

        const [, registerModel] = RegisterModelSync<PairModel>({ name: channel, type: PairModel });
        const model = new PairModel('own-3');
        model.a = 'A';
        model.b = 'B';
        registerModel(model);
        await roundTrip(singleton);
        expect(await storedOn(singleton, channel, 'own-3')).toEqual({ id: 'own-3', a: 'A', b: 'B' });

        const admin = await connectAsAdminUi();
        const gone = admin.disconnected(app);
        const reconnect = await dropConnectionUntilReleased(singleton);
        await gone;

        model.a = 'A2';
        await reported();

        const peer = await createPeer(app);
        const sentAgain = nextMessage(peer, { channel, command: 'model::update' });
        await reconnect();
        expect((await sentAgain).payload).toEqual({ id: 'own-3', a: 'A2', b: 'B' });

        const late = await createPeer(app);
        expect(await storedOn(late, channel, 'own-3')).toEqual({ id: 'own-3', a: 'A2', b: 'B' });
        expect([model.a, model.b]).toEqual(['A2', 'B']);
    });

    it('keeps the change it made while away, and takes the one another client made meanwhile', async () => {
        const app = uniqueApp('modelsync-own-both-changed');
        const channel = uniqueApp('own');
        // The peer stays connected throughout, so the server keeps the app's models.
        const { singleton, peer } = await createSingletonWithPeer(app);

        const [, registerModel] = RegisterModelSync<PairModel>({ name: channel, type: PairModel });
        const model = new PairModel('own-4');
        model.a = 'A';
        model.b = 'B';
        const arrived = nextMessage(peer, { channel, command: 'model::update' });
        registerModel(model);
        await arrived;

        const reconnect = await dropConnectionUntilReleased(singleton);
        model.a = 'A2';
        await reported();
        peer.sendMessage(channel, 'model::update', { id: 'own-4', b: 'B2' });
        expect(await storedOn(peer, channel, 'own-4')).toEqual({ id: 'own-4', a: 'A', b: 'B2' });

        const sent = nextMessage(peer, { channel, command: 'model::update' });
        await reconnect();
        // Only what changed while it was away: b on the server is newer than its own.
        expect((await sent).payload).toEqual({ id: 'own-4', a: 'A2' });

        // Twice: the first only once the server has answered what the reconnect asked for, after
        // which the client sends what it has to; the second once that has been answered too.
        await roundTrip(singleton);
        await roundTrip(singleton);
        expect([model.a, model.b]).toEqual(['A2', 'B2']);
        expect(await storedOn(peer, channel, 'own-4')).toEqual({ id: 'own-4', a: 'A2', b: 'B2' });
    });

    /** Every model the server has on `channel`, asked for through `client`. */
    const modelsOn = (client: Colibri, channel: string) =>
        updatesDuring(client, channel, () => {
            client.sendMessage(channel, 'model::request');
            return roundTrip(client);
        });

    // Another client (a Unity client destroying the object, say) deleted it while this one was away,
    // so the delete it relayed never arrived here. Sending the model in full again after the
    // reconnect would build it again on every client.
    it('does not bring back its own model that another client deleted while it was away', async () => {
        const app = uniqueApp('modelsync-own-deleted-away');
        const channel = uniqueApp('own');
        // The peer stays connected throughout, so the server keeps the app's models.
        const { singleton, peer } = await createSingletonWithPeer(app);

        const [models$, registerModel] = RegisterModelSync<OwnModel>({ name: channel, type: OwnModel });
        const model = new OwnModel('own-5');
        model.value = 'mine';
        const arrived = nextMessage(peer, { channel, command: 'model::update' });
        registerModel(model);
        await arrived;

        const reconnect = await dropConnectionUntilReleased(singleton);
        peer.sendMessage(channel, 'model::delete', { id: 'own-5' });
        await roundTrip(peer);

        const sentAgain = await updatesDuring(peer, channel, async () => {
            await reconnect();
            // The answer to what the reconnect asked for, then whatever the client sent in reply,
            // then that relayed to the peer.
            await roundTrip(singleton);
            await roundTrip(singleton);
            await roundTrip(peer);
        });

        expect(sentAgain).toEqual([]);
        expect(latest(models$)).toEqual([]);
        expect(await modelsOn(peer, channel)).toEqual([]);
    });

    // The server answers the request for such a model with model::delete rather than an update. The
    // client went on waiting for an update that never came, so it never asked for anything else
    // either, and missed every change and every model made while it was away.
    it('catches up on the other models after its own model was deleted while it was away', async () => {
        const app = uniqueApp('modelsync-own-deleted-catch-up');
        const channel = uniqueApp('own');
        // The peer stays connected throughout, so the server keeps the app's models.
        const { singleton, peer } = await createSingletonWithPeer(app);

        const [models$, registerModel] = RegisterModelSync<OwnModel>({ name: channel, type: OwnModel });
        const model = new OwnModel('own-6');
        model.value = 'mine';
        const arrived = nextMessage(peer, { channel, command: 'model::update' });
        registerModel(model);
        await arrived;

        peer.sendMessage(channel, 'model::update', { id: 'theirs-1', value: 'before' });
        await firstValueFrom(
            models$.pipe(
                filter(ms => ms.some(m => m.id === 'theirs-1')),
                timeout(5000)
            )
        );

        const reconnect = await dropConnectionUntilReleased(singleton);
        peer.sendMessage(channel, 'model::delete', { id: 'own-6' });
        peer.sendMessage(channel, 'model::update', { id: 'theirs-1', value: 'missed' });
        peer.sendMessage(channel, 'model::update', { id: 'theirs-2', value: 'created' });
        await roundTrip(peer);

        await reconnect();
        // The answer for own-6, then the answer to what the client asked for next.
        await roundTrip(singleton);
        await roundTrip(singleton);

        const models = latest(models$)
            .map(m => [m.id, m.value])
            .sort(([a], [b]) => a.localeCompare(b));
        expect(models).toEqual([
            ['theirs-1', 'missed'],
            ['theirs-2', 'created']
        ]);
    });
});

// A network that drops out (Wi-Fi, say) closes nothing, so Socket.IO notices only once its ping
// timeout has run out, and whatever this client sends until then is written into the dead link and
// lost: Socket.IO holds back only what is sent while it knows it is disconnected. After the
// reconnect, the server answered the request for the model with what it had before, and the client
// applied it: the change was undone on the client that made it, and never reached anyone else.
describe('RegisterModelSync own models after a change lost in a dead link', () => {
    class Item extends SyncModel<Item> {
        @Synced()
        accessor value = '';
    }

    // Longer than SyncModel's 1ms buffer, so a change has been reported - and sent, or not - by then.
    const reported = () => new Promise(resolve => setTimeout(resolve, 20));

    /**
     * Registers `model` through `client` and resolves once `peer` has it, and `client` has the answer
     * to the request for every model that followed it.
     */
    const registeredOn = async (
        client: Colibri,
        peer: Colibri,
        channel: string,
        model: Item,
        registerModel: (m: Item) => void
    ) => {
        const arrived = nextMessage(peer, { channel, command: 'model::update' });
        registerModel(model);
        expect((await arrived).payload).toEqual({ id: model.id, value: model.value });
        await roundTrip(client);
    };

    /** Cuts the link `client` reaches the server through, and resolves once it is back and caught up. */
    const cutAndCatchUp = async (client: Colibri, link: { cut(): void }) => {
        const reconnected = nextConnect(client);
        link.cut();
        await reconnected;
        // The answer to asking for the model again, then to whatever the client sent in reply,
        // then to the request for every model.
        for (let i = 0; i < 3; i++) await roundTrip(client);
    };

    it('sends a change lost in the dead link again when the server answers with a value sent before it', async () => {
        const app = uniqueApp('modelsync-own-lost');
        const channel = uniqueApp('own');
        // Stays connected throughout, directly, so the server keeps the app's models.
        const peer = await createClient(app);
        const link = await startLinkProxy();
        const singleton = await createClientThrough(app, link);

        const [models$, registerModel] = RegisterModelSync<Item>({ name: channel, type: Item });
        const model = new Item('lost-1');
        model.value = 'A';
        await registeredOn(singleton, peer, channel, model, registerModel);
        const arrived = nextMessage(peer, { channel, command: 'model::update' });
        model.value = 'B';
        expect((await arrived).payload).toEqual({ id: 'lost-1', value: 'B' });

        link.freeze();
        model.value = 'C';
        await reported();
        expect(await storedOn(peer, channel, 'lost-1')).toEqual({ id: 'lost-1', value: 'B' });

        const peerSaw = await updatesDuring(peer, channel, async () => {
            await cutAndCatchUp(singleton, link);
            await roundTrip(peer);
        });

        expect(model.value).toBe('C');
        expect(latest(models$)).toEqual([model]);
        expect(peerSaw).toEqual([{ id: 'lost-1', value: 'C' }]);
        expect(await storedOn(peer, channel, 'lost-1')).toEqual({ id: 'lost-1', value: 'C' });
    });

    // Socket.IO may take most of a minute to notice, and every change made until then goes into the
    // dead link: one for each key typed, say.
    it('sends the last of many changes lost in the dead link', async () => {
        const app = uniqueApp('modelsync-own-lost-typed');
        const channel = uniqueApp('own');
        const peer = await createClient(app);
        const link = await startLinkProxy();
        const singleton = await createClientThrough(app, link);

        const [, registerModel] = RegisterModelSync<Item>({ name: channel, type: Item });
        const model = new Item('lost-4');
        model.value = 'A';
        await registeredOn(singleton, peer, channel, model, registerModel);
        const arrived = nextMessage(peer, { channel, command: 'model::update' });
        model.value = 'B';
        expect((await arrived).payload).toEqual({ id: 'lost-4', value: 'B' });

        link.freeze();
        const word = 'typed one key at a time';
        for (let i = 1; i <= word.length; i++) {
            model.value = word.slice(0, i);
            await reported();
        }
        expect(await storedOn(peer, channel, 'lost-4')).toEqual({ id: 'lost-4', value: 'B' });

        const peerSaw = await updatesDuring(peer, channel, async () => {
            await cutAndCatchUp(singleton, link);
            await roundTrip(peer);
        });

        expect(model.value).toBe(word);
        expect(peerSaw).toEqual([{ id: 'lost-4', value: word }]);
        expect(await storedOn(peer, channel, 'lost-4')).toEqual({ id: 'lost-4', value: word });
    });

    // The server keeps an app's models for as long as one of its clients is connected - and that
    // includes this client's old connection, which the server has not noticed is dead either.
    it('does so when it is alone in its app, kept alive by its own old connection', async () => {
        const app = uniqueApp('modelsync-own-lost-alone');
        const channel = uniqueApp('own');
        const link = await startLinkProxy();
        const singleton = await createClientThrough(app, link);

        const [, registerModel] = RegisterModelSync<Item>({ name: channel, type: Item });
        const model = new Item('lost-2');
        model.value = 'A';
        registerModel(model);
        // The server's answer for the model, and then the model, which the client sent in reply.
        await roundTrip(singleton);
        await roundTrip(singleton);

        link.freeze();
        model.value = 'B';
        await reported();
        await cutAndCatchUp(singleton, link);

        expect(model.value).toBe('B');
        const late = await createPeer(app);
        expect(await storedOn(late, channel, 'lost-2')).toEqual({ id: 'lost-2', value: 'B' });
    });

    // The server relays another client's update to the new connection as it comes, so on a slow link
    // one made just after the reconnect arrives ahead of the answer. Taken for the answer, it settled
    // the model, and the answer that followed undid the change.
    it('sends the change again when another client keeps changing the model through the reconnect', async () => {
        class Moved extends SyncModel<Moved> {
            @Synced()
            accessor value = '';
            @Synced()
            accessor pos = 0;
        }

        const app = uniqueApp('modelsync-own-lost-moved');
        const channel = uniqueApp('own');
        const peer = await createClient(app);
        const link = await startLinkProxy(25);
        const singleton = await createClientThrough(app, link);

        const [, registerModel] = RegisterModelSync<Moved>({ name: channel, type: Moved });
        const model = new Moved('lost-5');
        model.value = 'A';
        const registered = nextMessage(peer, { channel, command: 'model::update' });
        registerModel(model);
        expect((await registered).payload).toEqual({ id: 'lost-5', value: 'A', pos: 0 });
        await roundTrip(singleton);

        // Another client moves the model all along, as a tracked object would be.
        let pos = 0;
        const moving = setInterval(() => {
            pos += 1;
            peer.sendMessage(channel, 'model::update', { id: 'lost-5', pos });
        }, 33);
        try {
            link.freeze();
            model.value = 'B';
            await reported();
            expect(await storedOn(peer, channel, 'lost-5')).toMatchObject({ value: 'A' });
            await cutAndCatchUp(singleton, link);
        } finally {
            clearInterval(moving);
        }
        await roundTrip(peer);
        await roundTrip(singleton);

        expect(model.value).toBe('B');
        expect(model.pos).toBe(pos);
        expect(await storedOn(peer, channel, 'lost-5')).toEqual({ id: 'lost-5', value: 'B', pos });
    });

    it('takes the value another client set meanwhile, and sends nothing over it', async () => {
        const app = uniqueApp('modelsync-own-lost-overtaken');
        const channel = uniqueApp('own');
        const peer = await createClient(app);
        const link = await startLinkProxy();
        const singleton = await createClientThrough(app, link);

        const [, registerModel] = RegisterModelSync<Item>({ name: channel, type: Item });
        const model = new Item('lost-3');
        model.value = 'A';
        await registeredOn(singleton, peer, channel, model, registerModel);

        link.freeze();
        model.value = 'B';
        await reported();
        peer.sendMessage(channel, 'model::update', { id: 'lost-3', value: 'theirs' });
        expect(await storedOn(peer, channel, 'lost-3')).toEqual({ id: 'lost-3', value: 'theirs' });

        const peerSaw = await updatesDuring(peer, channel, async () => {
            await cutAndCatchUp(singleton, link);
            await roundTrip(peer);
        });

        expect(model.value).toBe('theirs');
        expect(peerSaw).toEqual([]);
        expect(await storedOn(peer, channel, 'lost-3')).toEqual({ id: 'lost-3', value: 'theirs' });
    });
});

// A page whose own model changes while it catches up after a reconnect, on a link with some latency.
describe('RegisterModelSync own models changing through the reconnect', () => {
    class Pair extends SyncModel<Pair> {
        @Synced()
        accessor value = '';
        @Synced()
        accessor other = '';
    }

    /** Registers `model` through `client`, and resolves once `peer` has it and `client` is caught up. */
    const registeredOn = async (
        client: Colibri,
        peer: Colibri,
        channel: string,
        model: Pair,
        registerModel: (m: Pair) => void
    ) => {
        const arrived = nextMessage(peer, { channel, command: 'model::update' });
        registerModel(model);
        await arrived;
        await roundTrip(client);
    };

    // A model that changes all the time, a tracked pose say, changed again before every answer to
    // asking for it once more: it stayed asked for, one update a round trip went out, and the models
    // created during the outage never arrived.
    it('catches up on a model created during the outage while its own model changes all the time', async () => {
        const app = uniqueApp('modelsync-own-moving');
        const channel = uniqueApp('own');
        const peer = await createClient(app);
        const link = await startLinkProxy(25);
        const singleton = await createClientThrough(app, link);

        const [models$, registerModel] = RegisterModelSync<Pair>({ name: channel, type: Pair });
        const model = new Pair('me');
        model.value = '0';
        await registeredOn(singleton, peer, channel, model, registerModel);

        let moves = 0;
        const moving = setInterval(() => {
            moves += 1;
            model.value = String(moves);
        }, 33);
        try {
            link.freeze();
            peer.sendMessage(channel, 'model::update', { id: 'theirs', value: 'created meanwhile' });
            await roundTrip(peer);
            const reconnected = nextConnect(singleton);
            link.cut();
            await reconnected;

            await firstValueFrom(
                models$.pipe(
                    filter(ms => ms.some(m => m.id === 'theirs')),
                    timeout(3000)
                )
            );
            const peerSaw = await updatesDuring(peer, channel, () => new Promise(resolve => setTimeout(resolve, 1000)));
            // About 30 a second; one a round trip was about 18.
            expect(peerSaw.length).toBeGreaterThanOrEqual(25);
        } finally {
            clearInterval(moving);
        }
        expect(latest(models$).map(m => m.id)).toEqual(['me', 'theirs']);
    });

    // The server answers the request for every model with what it has when it reads that request, and
    // reads a change sent just after it only then. Applied, that answer undid the change on this page
    // alone: the server never sends a client's own update back to it.
    it('keeps a change sent just after asking for every model after a reconnect', async () => {
        const app = uniqueApp('modelsync-own-catch-up');
        const channel = uniqueApp('own');
        const peer = await createClient(app);
        const link = await startLinkProxy(25);
        const singleton = await createClientThrough(app, link);

        const [, registerModel] = RegisterModelSync<Pair>({ name: channel, type: Pair });
        const model = new Pair('kept-1');
        model.value = 'A';
        model.other = 'X';
        await registeredOn(singleton, peer, channel, model, registerModel);

        // Changes `other` in the same tick as the request for every model goes out after the reconnect.
        const send = singleton.sendMessage.bind(singleton);
        let armed = true;
        singleton.sendMessage = (ch: string, command: string, payload?: unknown) => {
            send(ch, command, payload);
            if (armed && ch === channel && command === 'model::request' && payload === undefined) {
                armed = false;
                model.other = 'Y';
            }
        };
        const reconnected = nextConnect(singleton);
        link.cut();
        await reconnected;
        for (let i = 0; i < 3; i++) await roundTrip(singleton);

        expect(armed).toBe(false);
        expect(model.other).toBe('Y');
        expect(await storedOn(peer, channel, 'kept-1')).toEqual({ id: 'kept-1', value: 'A', other: 'Y' });
    });
});

// The server may already have a model under the id a client registers: another client created it,
// or the same page did before it was reloaded, while another client kept the app alive.
describe('RegisterModelSync registering an id the server already has', () => {
    class Shared extends SyncModel<Shared> {
        @Synced()
        accessor value = '';
    }

    // The registering client sent its fresh state at once, and the answer to the request for every
    // model then put the old one back on that client only: it showed the old state, while the
    // server and every other client had the fresh one.
    it('takes what the server has, so that it agrees with the server and every other client', async () => {
        const app = uniqueApp('modelsync-known-id');
        const channel = uniqueApp('shared');
        // Stays connected throughout, so the server keeps the app's models: a headset, say.
        const peer = await createClient(app);
        peer.sendMessage(channel, 'model::update', { id: 'session', value: 'running' });
        await roundTrip(peer);

        // A page loaded now registers the same id with a fresh state of its own.
        const page = await createClient(app);
        const [models$, registerModel] = RegisterModelSync<Shared>({ name: channel, type: Shared });
        const session = new Shared('session');
        session.value = 'fresh';

        const peerSaw = await updatesDuring(peer, channel, async () => {
            registerModel(session);
            // The answers to both requests, then anything the page sent in reply, relayed.
            await roundTrip(page);
            await roundTrip(page);
            await roundTrip(peer);
        });

        expect(latest(models$)).toEqual([session]);
        expect(session.value).toBe('running');
        expect(peerSaw).toEqual([]);
        expect(await storedOn(peer, channel, 'session')).toEqual({ id: 'session', value: 'running' });
    });

    // The server drops an update for an id deleted a moment ago (MODEL_TOMBSTONE_SECONDS), so that
    // one still on its way when the delete was made cannot bring the model back. Registering the id
    // again is creating the model again on purpose, and must not be dropped.
    it('creates a model again under an id another client deleted a moment ago', async () => {
        const app = uniqueApp('modelsync-recreated-id');
        const channel = uniqueApp('shared');
        const { singleton, peer } = await createSingletonWithPeer(app);
        const [models$, registerModel] = RegisterModelSync<Shared>({ name: channel, type: Shared });
        await listed(singleton);

        peer.sendMessage(channel, 'model::update', { id: 'marker', value: 'old' });
        peer.sendMessage(channel, 'model::delete', { id: 'marker' });
        await roundTrip(peer);
        // Seen to be deleted here too.
        await roundTrip(singleton);
        expect(latest(models$)).toEqual([]);

        const marker = new Shared('marker');
        marker.value = 'new';
        const arrived = nextMessage(peer, { channel, command: 'model::update' }, 3000);
        registerModel(marker);

        expect((await arrived).payload).toEqual({ id: 'marker', value: 'new' });
        expect(latest(models$)).toEqual([marker]);
        expect(await storedOn(peer, channel, 'marker')).toEqual({ id: 'marker', value: 'new' });
    });

    // Another client creates the id and deletes it while the request for it is on its way. Its update
    // came first and was taken for the answer. The answer itself, the bare id since the server read
    // the request after the delete, was then listed as a model with no fields.
    it('lists nothing for an id another client creates and deletes while the request is on its way', async () => {
        const app = uniqueApp('modelsync-created-deleted');
        const channel = uniqueApp('shared');
        const peer = await createClient(app);
        const link = await startLinkProxy(25);
        const page = await createClientThrough(app, link);
        const [models$, registerModel] = RegisterModelSync<Shared>({ name: channel, type: Shared });
        await listed(page);

        const peerSaw = await updatesDuring(peer, channel, async () => {
            registerModel(new Shared('marker'));
            // The server reads these before the request for the id, which takes 25 ms more to reach it.
            peer.sendMessage(channel, 'model::update', { id: 'marker', value: 'theirs' });
            peer.sendMessage(channel, 'model::delete', { id: 'marker' });
            for (let i = 0; i < 3; i++) await roundTrip(page);
            await roundTrip(peer);
        });

        expect(latest(models$)).toEqual([]);
        expect(peerSaw).toEqual([]);
    });

    // Registered after the answer to the request for every model, on a button press say, the id is
    // already listed. It used to be listed twice, and the instance registered never saw another
    // client's change again: each went to the copy listed first.
    it('replaces the copy of the id it already lists, and goes on receiving changes to it', async () => {
        const app = uniqueApp('modelsync-listed-id');
        const channel = uniqueApp('shared');
        const peer = await createClient(app);
        peer.sendMessage(channel, 'model::update', { id: 'session', value: 'running' });
        await roundTrip(peer);

        const page = await createClient(app);
        const [models$, registerModel] = RegisterModelSync<Shared>({ name: channel, type: Shared });
        await listed(page);
        expect(latest(models$).map(m => m.toJson())).toEqual([{ id: 'session', value: 'running' }]);

        const session = new Shared('session');
        registerModel(session);
        await roundTrip(page);
        peer.sendMessage(channel, 'model::update', { id: 'session', value: 'paused' });
        await roundTrip(peer);
        await roundTrip(page);

        expect(latest(models$)).toEqual([session]);
        expect(session.value).toBe('paused');
    });

    // A change made after registerModel is held back until the server has answered for the id, and
    // then sent on top of what it has. It used to be undone on the registering client only, so that
    // the page showed the old value while the server and every other client had the new one: when
    // the answer for every model came first and was taken for the answer for the id, and when the
    // answer came before SyncModel reported the change, 1 ms after it was made.
    describe('keeps a change made right after registerModel', () => {
        /** A peer that holds 'session' = running and stays connected throughout. */
        const peerWithSession = async (prefix: string) => {
            const app = uniqueApp(prefix);
            const channel = uniqueApp('shared');
            const peer = await createClient(app);
            peer.sendMessage(channel, 'model::update', { id: 'session', value: 'running' });
            await roundTrip(peer);
            return { app, channel, peer };
        };

        /** What the page, the server and the peer have for 'session' once everything has arrived. */
        const outcome = async (page: Colibri, peer: Colibri, channel: string, session: Shared) => {
            const peerSaw = await updatesDuring(peer, channel, async () => {
                for (let i = 0; i < 3; i++) await roundTrip(page);
                await roundTrip(peer);
            });
            return {
                page: session.value,
                server: await storedOn(peer, channel, 'session'),
                peerLastSaw: peerSaw.at(-1)
            };
        };

        const expected = {
            page: 'mine',
            server: { id: 'session', value: 'mine' },
            peerLastSaw: { id: 'session', value: 'mine' }
        };

        it('registered at the top of a module, before new Colibri()', async () => {
            const { app, channel, peer } = await peerWithSession('modelsync-change-early');

            resetSingleton();
            const [models$, registerModel] = RegisterModelSync<Shared>({ name: channel, type: Shared });
            const session = new Shared('session');
            registerModel(session);
            session.value = 'mine';
            const page = await createClient(app);

            expect(await outcome(page, peer, channel, session)).toEqual(expected);
            expect(latest(models$)).toEqual([session]);
        });

        // Run a few times over: whether the answer comes within the 1 ms is down to timing.
        it('registered later, on a button press say', async () => {
            for (let run = 0; run < 6; run++) {
                const { app, channel, peer } = await peerWithSession('modelsync-change-late');
                const page = await createClient(app);
                const [models$, registerModel] = RegisterModelSync<Shared>({ name: channel, type: Shared });
                await listed(page);
                expect(latest(models$)).toHaveLength(1);

                const session = new Shared('session');
                registerModel(session);
                session.value = 'mine';

                expect({ run, ...(await outcome(page, peer, channel, session)) }).toEqual({ run, ...expected });
                expect(latest(models$)).toEqual([session]);
            }
        });

        it('registered while the answer for every model is still on its way', async () => {
            for (let run = 0; run < 6; run++) {
                const { app, channel, peer } = await peerWithSession('modelsync-change-in-flight');
                const page = await createClient(app);
                const [models$, registerModel] = RegisterModelSync<Shared>({ name: channel, type: Shared });
                // Asked for every model by now, and not answered yet.
                await new Promise(resolve => setTimeout(resolve, 0));

                const session = new Shared('session');
                registerModel(session);
                session.value = 'mine';

                expect({ run, ...(await outcome(page, peer, channel, session)) }).toEqual({ run, ...expected });
                expect(latest(models$)).toEqual([session]);
            }
        });
    });
});

// A page on a link with some latency registers an id the server already has, and changes one field
// before the answer for the id arrives. The update the page takes for that answer need not be it: an
// update another client made can come first, and so can the answer to the request for every model.
// With nothing held then, a change made after it went out at once, and the answer itself, made before
// the server had the change, undid it on the page only.
describe('RegisterModelSync changing a model registered under an id the server already has', () => {
    class Pair extends SyncModel<Pair> {
        @Synced()
        accessor value = '';
        @Synced()
        accessor other = '';
    }

    /** A peer that holds 'session' and stays connected throughout, and a page behind a slow link. */
    const peerAndSlowPage = async (prefix: string) => {
        const app = uniqueApp(prefix);
        const channel = uniqueApp('shared');
        const peer = await createClient(app);
        peer.sendMessage(channel, 'model::update', { id: 'session', value: 'running', other: 'theirs' });
        await roundTrip(peer);
        const link = await startLinkProxy(25);
        const page = await createClientThrough(app, link);
        const [models$, registerModel] = RegisterModelSync<Pair>({ name: channel, type: Pair });
        // Set before registerModel, so the server's value replaces it.
        const session = new Pair('session');
        session.other = 'mine before registering';
        return { channel, peer, page, models$, registerModel, session };
    };

    /** Resolves once `models$` shows `session` with `value`. */
    const shown = (models$: Observable<Pair[]>, session: Pair, value: string) =>
        firstValueFrom(
            models$.pipe(
                filter(ms => ms.includes(session) && session.value === value),
                timeout(3000)
            )
        );

    /** What the page, the server and the peer have for 'session' once everything has arrived. */
    const outcome = async (page: Colibri, peer: Colibri, channel: string, session: Pair) => {
        const peerSaw = await updatesDuring(peer, channel, async () => {
            for (let i = 0; i < 3; i++) await roundTrip(page);
            await roundTrip(peer);
        });
        return {
            page: session.toJson(),
            server: await storedOn(peer, channel, 'session'),
            peerLastSaw: peerSaw.at(-1)
        };
    };

    // The change everywhere, and the server's value for the field the page did not change.
    const expected = {
        page: { id: 'session', value: 'mine', other: 'theirs' },
        server: { id: 'session', value: 'mine', other: 'theirs' },
        peerLastSaw: { id: 'session', value: 'mine' }
    };

    it('in the same tick as registerModel', async () => {
        const { channel, peer, page, models$, registerModel, session } = await peerAndSlowPage('modelsync-same-tick');
        await listed(page);

        registerModel(session);
        session.value = 'mine';

        expect(await outcome(page, peer, channel, session)).toEqual(expected);
        expect(latest(models$)).toEqual([session]);
    });

    it('after registerModel, before the answer', async () => {
        const { channel, peer, page, models$, registerModel, session } =
            await peerAndSlowPage('modelsync-before-answer');
        await listed(page);

        registerModel(session);
        await new Promise(resolve => setTimeout(resolve, 10));
        session.value = 'mine';

        expect(await outcome(page, peer, channel, session)).toEqual(expected);
        expect(latest(models$)).toEqual([session]);
    });

    it("after another client's update, before the answer", async () => {
        const { channel, peer, page, models$, registerModel, session } = await peerAndSlowPage('modelsync-after-relay');
        await listed(page);

        const relayed = shown(models$, session, 'paused');
        registerModel(session);
        // The server reads this before the request for the id, which takes 25 ms more to reach it.
        peer.sendMessage(channel, 'model::update', { id: 'session', value: 'paused' });
        await relayed;
        session.value = 'mine';

        expect(await outcome(page, peer, channel, session)).toEqual(expected);
        expect(latest(models$)).toEqual([session]);
    });

    it('after the answer to the request for every model, before the answer', async () => {
        const { channel, peer, page, models$, registerModel, session } = await peerAndSlowPage('modelsync-after-all');
        // Asked for every model by now, and registered while that answer is on its way, far enough
        // behind it for a change made when it arrives to go out before the answer for the id comes.
        await new Promise(resolve => setTimeout(resolve, 15));

        const answered = shown(models$, session, 'running');
        registerModel(session);
        await answered;
        session.value = 'mine';

        expect(await outcome(page, peer, channel, session)).toEqual(expected);
        expect(latest(models$)).toEqual([session]);
    });
});

describe('RemoteLogger high-level API', () => {
    it('forwards console.info without throwing or breaking the connection', async () => {
        const { singleton } = await createSingletonWithPeer(uniqueApp('logger-app'));

        const originalConsole = {
            debug: console.debug,
            log: console.log,
            info: console.info,
            warn: console.warn,
            error: console.error
        };

        const logger = new RemoteLogger();
        try {
            // The server's ClientLogger consumes 'log' channel messages for
            // its own admin UI and never relays them to other clients, so
            // receipt isn't observable from here; that's covered by the
            // mocked unit suite. Here we just assert the wire path doesn't
            // throw and the connection stays healthy afterwards.
            expect(() => {
                console.info('e2e log message');
            }).not.toThrow();

            await expect(
                nextMessage(singleton, { channel: 'colibri', command: 'latency' }, 3000)
            ).resolves.toBeDefined();
        } finally {
            console.debug = originalConsole.debug;
            console.log = originalConsole.log;
            console.info = originalConsole.info;
            console.warn = originalConsole.warn;
            console.error = originalConsole.error;
            logger.disable();
        }
    });
});
