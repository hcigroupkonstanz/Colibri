import { afterEach, describe, expect, it } from 'vitest';
import { createClient, disconnectAll, uniqueApp } from './helpers';

afterEach(() => {
    disconnectAll();
});

describe('REST store', () => {
    it('round-trips an object through setRestObject/getRestObject', async () => {
        const client = await createClient(uniqueApp('rest-app'));
        const key = uniqueApp('rest-key');
        const data = { hello: 'world', n: 42 };

        await expect(client.setRestObject(key, data)).resolves.toBe(true);
        await expect(client.getRestObject(key)).resolves.toEqual(data);
    });

    it('returns null for a key that was never set', async () => {
        const client = await createClient(uniqueApp('rest-app'));

        await expect(
            client.getRestObject(uniqueApp('missing-key'))
        ).resolves.toBeNull();
    });
});
