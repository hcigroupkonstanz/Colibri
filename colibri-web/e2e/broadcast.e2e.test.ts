import { afterEach, describe, expect, it } from 'vitest';
import { createClient, disconnectAll, nextMessage, uniqueApp } from './helpers';

afterEach(() => {
    disconnectAll();
});

describe('broadcast relay', () => {
    it('relays a broadcast to another client in the same app, but not back to the sender', async () => {
        const app = uniqueApp('broadcast-app');
        const channel = 'e2e-broadcast-channel';

        const sender = await createClient(app);
        const receiver = await createClient(app);

        const receiverPromise = nextMessage(receiver, {
            channel,
            command: 'broadcast::json'
        });
        const senderEcho = nextMessage(sender, { channel, command: 'broadcast::json' }, 500).then(
            () => true,
            () => false
        );

        sender.sendMessage(channel, 'broadcast::json', { hello: 'world' });

        const received = await receiverPromise;
        expect(received.payload).toEqual({ hello: 'world' });
        await expect(senderEcho).resolves.toBe(false);
    });

    it('does not relay a broadcast to a client in a different app', async () => {
        const channel = 'e2e-broadcast-cross-app';

        const sender = await createClient(uniqueApp('broadcast-other-a'));
        const receiver = await createClient(uniqueApp('broadcast-other-b'));

        const receiverPromise = nextMessage(receiver, { channel, command: 'broadcast::json' }, 500).then(
            () => true,
            () => false
        );

        sender.sendMessage(channel, 'broadcast::json', {
            should: 'not-arrive'
        });

        await expect(receiverPromise).resolves.toBe(false);
    });
});
