import { afterEach, describe, expect, it } from 'vitest';
import { createClient, disconnectAll, nextMessage, uniqueApp } from './helpers';

afterEach(() => {
    disconnectAll();
});

describe('model sync relay (transport level)', () => {
    it('relays a model::update to another client in the same app', async () => {
        const app = uniqueApp('model-sync-app');
        const channel = 'e2e-model';

        const a = await createClient(app);
        const b = await createClient(app);

        const updatePromise = nextMessage(b, {
            channel,
            command: 'model::update'
        });

        a.sendMessage(channel, 'model::update', { id: 'model-1', value: 42 });

        const msg = await updatePromise;
        expect(msg.payload).toEqual({ id: 'model-1', value: 42 });
    });

    it('sends persisted state to a late-joining client that requests it', async () => {
        const app = uniqueApp('model-sync-persist');
        const channel = 'e2e-model';

        const a = await createClient(app);
        const witness = await createClient(app);

        // Wait for the witness to see the update relayed before asking a late
        // client to request state — the server applies the update to its
        // store before broadcasting, so this guarantees persistence has
        // already happened by the time we ask for it below.
        const witnessPromise = nextMessage(witness, {
            channel,
            command: 'model::update'
        });
        a.sendMessage(channel, 'model::update', {
            id: 'model-1',
            value: 'persisted'
        });
        await witnessPromise;

        const late = await createClient(app);
        const statePromise = nextMessage(late, {
            channel,
            command: 'model::update'
        });
        late.sendMessage(channel, 'model::request');

        const msg = await statePromise;
        expect(msg.payload).toEqual({ id: 'model-1', value: 'persisted' });
    });

    it('relays model::delete to another client in the same app', async () => {
        const app = uniqueApp('model-sync-delete');
        const channel = 'e2e-model';

        const a = await createClient(app);
        const b = await createClient(app);

        const createdPromise = nextMessage(b, {
            channel,
            command: 'model::update'
        });
        a.sendMessage(channel, 'model::update', { id: 'model-1' });
        await createdPromise;

        const deletePromise = nextMessage(b, {
            channel,
            command: 'model::delete'
        });
        a.sendMessage(channel, 'model::delete', { id: 'model-1' });

        const msg = await deletePromise;
        expect(msg.payload).toEqual({ id: 'model-1' });
    });
});
