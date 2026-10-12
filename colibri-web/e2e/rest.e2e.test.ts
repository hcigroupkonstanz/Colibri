import { afterEach, describe, expect, it } from 'vitest';
import { HOST, PORT, createClient, createClientWithAddress, disconnectAll, uniqueApp } from './helpers';

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

        await expect(client.getRestObject(uniqueApp('missing-key'))).resolves.toBeNull();
    });

    // Unencoded, 'a#b' and 'a?b' were both stored as 'a', over each other; 'a/b' and '50%' could not
    // be stored at all, and getRestObject('..') answered with the server's list of apps.
    it('stores every key under its own name, whatever characters it has', async () => {
        const app = `${uniqueApp('rest app')} /#?%`;
        const client = await createClient(app);
        const keys = ['a b', 'a#b', 'a?b', 'a', 'a/b', '50%', 'x%20y', '../x'];

        for (const key of keys) {
            await expect(client.setRestObject(key, { key })).resolves.toBe(true);
        }
        for (const key of keys) {
            await expect(client.getRestObject(key)).resolves.toEqual({ key });
        }

        // Under the literal names, in an app of the literal name - which is what a Unity client
        // of that app asks the server for.
        const listed = await fetch(`http://${HOST}:${PORT}/api/store/`).then(r => r.json() as Promise<string[]>);
        expect(listed).toContain(app);
        const stored = await fetch(client.uriRestApi).then(r => r.json() as Promise<string[]>);
        expect([...stored].sort()).toEqual([...keys].sort());

        await expect(client.getRestObject('..')).resolves.toBeNull();
    });

    // A plain key is the same URL as before, so a value stored by an older client - or by Unity,
    // which builds the URL as it always has - is still found.
    it('finds a value stored through an unencoded URL under a plain key', async () => {
        const app = uniqueApp('rest-app');
        const client = await createClient(app);
        const key = uniqueApp('plain-key');

        const put = await fetch(`http://${HOST}:${PORT}/api/store/${app}/${key}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: 'unencoded' })
        });
        expect(put.status).toBe(201);

        await expect(client.getRestObject(key)).resolves.toEqual({ from: 'unencoded' });
    });

    // The admin UI's URL as copied out of the address bar, port and trailing slash included and no
    // port argument. The port used to stay in the host, so this retried 'ws://host:9011:9011'
    // forever and said nothing. The REST round trip checks the REST URL, the connect the socket's.
    it('connects and round-trips through the admin UI address, port included', async () => {
        const client = await createClientWithAddress(uniqueApp('rest-app'), `http://${HOST}:${PORT}/`);
        const key = uniqueApp('rest-key');

        expect(client.uri).toBe(`ws://${HOST}:${PORT}`);
        await expect(client.setRestObject(key, { from: 'address' })).resolves.toBe(true);
        await expect(client.getRestObject(key)).resolves.toEqual({ from: 'address' });
    });
});
