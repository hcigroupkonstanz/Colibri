import { afterEach, describe, expect, it } from 'vitest';
import { createClient, disconnectAll, nextMessage, uniqueApp } from './helpers';

afterEach(() => {
    disconnectAll();
});

describe('connecting to a real colibri-server', () => {
    it('completes the version-2 handshake and receives the latency heartbeat', async () => {
        const client = await createClient(uniqueApp('connection'));

        const msg = await nextMessage(client, { channel: 'colibri', command: 'latency' }, 3000);

        expect(msg.channel).toBe('colibri');
        expect(msg.command).toBe('latency');
    });

    it('supports two independently connected clients on different apps', async () => {
        const a = await createClient(uniqueApp('connection-a'));
        const b = await createClient(uniqueApp('connection-b'));

        const [msgA, msgB] = await Promise.all([
            nextMessage(a, { channel: 'colibri', command: 'latency' }, 3000),
            nextMessage(b, { channel: 'colibri', command: 'latency' }, 3000)
        ]);

        expect(msgA.command).toBe('latency');
        expect(msgB.command).toBe('latency');
    });
});
