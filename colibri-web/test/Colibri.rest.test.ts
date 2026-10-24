import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('socket.io-client', () => ({
    connect: vi.fn()
}));

import { connect } from 'socket.io-client';
import { Colibri, PROTOCOL_VERSION } from '../src/Colibri';
import { type FakeSocket, makeFakeSocket } from './support/fakeSocket';

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

describe('Colibri.getRestUri', () => {
    it('joins the REST base uri with the trimmed key', () => {
        const c = new Colibri('app', 'localhost', 9211);
        expect(c.getRestUri('mykey')).toBe('http://localhost:9211/api/store/app/mykey');
    });

    it('trims leading slashes from the key', () => {
        const c = new Colibri('app', 'localhost', 9211);
        expect(c.getRestUri('///nested/key')).toBe('http://localhost:9211/api/store/app/nested%2Fkey');
    });

    it('returns null for an empty or whitespace-only key', () => {
        const c = new Colibri('app', 'localhost', 9211);
        expect(c.getRestUri('')).toBeNull();
        expect(c.getRestUri('   ')).toBeNull();
    });

    // The key is one path segment, so '#', '?', '/' and '%' have to be escaped.
    it.each([
        ['a b', 'a%20b'],
        ['a#b', 'a%23b'],
        ['a?b', 'a%3Fb'],
        ['a/b', 'a%2Fb'],
        ['50%', '50%25'],
        ['x%20y', 'x%2520y'],
        ['../x', '..%2Fx'],
        ['a..b', 'a..b'],
        ['plain-key_1', 'plain-key_1']
    ])('encodes the key %j as the path segment %j', (key, segment) => {
        const c = new Colibri('app', 'localhost', 9211);
        expect(c.getRestUri(key)).toBe(`http://localhost:9211/api/store/app/${segment}`);
    });

    // A URL parser resolves '.' and '..', encoded or not, as directory steps, so no URL can name them as a key.
    it.each(['.', '..', ' .. ', '/..'])('returns null for the key %j, which a URL cannot carry', key => {
        const c = new Colibri('app', 'localhost', 9211);
        expect(c.getRestUri(key)).toBeNull();
    });

    it('encodes the app name in the REST API uri', () => {
        const c = new Colibri('my app/#?%', 'localhost', 9211);
        expect(c.uriRestApi).toBe('http://localhost:9211/api/store/my%20app%2F%23%3F%25/');
        expect(c.getRestUri('key')).toBe('http://localhost:9211/api/store/my%20app%2F%23%3F%25/key');
    });
});

describe('Colibri REST API', () => {
    it('getRestObject skips fetch and returns null for an empty key', async () => {
        const c = new Colibri('app', 'localhost', 9211);
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        await expect(c.getRestObject('')).resolves.toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('getRestObject returns parsed JSON on success', async () => {
        const c = new Colibri('app', 'localhost', 9211);
        const fetchMock = vi.fn().mockResolvedValue({
            status: 200,
            json: () => Promise.resolve({ a: 1 })
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(c.getRestObject('mykey')).resolves.toEqual({ a: 1 });
        expect(fetchMock).toHaveBeenCalledWith('http://localhost:9211/api/store/app/mykey', {
            method: 'GET',
            headers: { Accept: `application/vnd.colibri.v${PROTOCOL_VERSION}+json` }
        });
    });

    it('getRestObject returns null on a >= 400 status', async () => {
        const c = new Colibri('app', 'localhost', 9211);
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                status: 404,
                json: () => Promise.resolve({})
            })
        );

        await expect(c.getRestObject('mykey')).resolves.toBeNull();
    });

    it('skips fetch for the key .., which no URL can carry', async () => {
        const c = new Colibri('app', 'localhost', 9211);
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        await expect(c.getRestObject('..')).resolves.toBeNull();
        await expect(c.setRestObject('..', { a: 1 })).resolves.toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('setRestObject skips fetch and returns false for an empty key', async () => {
        const c = new Colibri('app', 'localhost', 9211);
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        await expect(c.setRestObject('', { a: 1 })).resolves.toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('setRestObject returns true on a 2xx status', async () => {
        const c = new Colibri('app', 'localhost', 9211);
        const fetchMock = vi.fn().mockResolvedValue({ status: 204 });
        vi.stubGlobal('fetch', fetchMock);

        await expect(c.setRestObject('mykey', { a: 1 })).resolves.toBe(true);
        expect(fetchMock).toHaveBeenCalledWith('http://localhost:9211/api/store/app/mykey', {
            method: 'PUT',
            headers: {
                Accept: `application/vnd.colibri.v${PROTOCOL_VERSION}+json`,
                'Content-Type': `application/vnd.colibri.v${PROTOCOL_VERSION}+json`
            },
            body: JSON.stringify({ a: 1 })
        });
    });

    it('setRestObject returns false on a non-2xx status', async () => {
        const c = new Colibri('app', 'localhost', 9211);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 500 }));

        await expect(c.setRestObject('mykey', { a: 1 })).resolves.toBe(false);
    });

    it('deleteRestObject skips fetch and returns false for an empty key, . or ..', async () => {
        const c = new Colibri('app', 'localhost', 9211);
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        await expect(c.deleteRestObject('')).resolves.toBe(false);
        await expect(c.deleteRestObject('..')).resolves.toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('deleteRestObject sends a DELETE and returns true on a 2xx status', async () => {
        const c = new Colibri('app', 'localhost', 9211);
        const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
        vi.stubGlobal('fetch', fetchMock);

        await expect(c.deleteRestObject('my key')).resolves.toBe(true);
        expect(fetchMock).toHaveBeenCalledWith('http://localhost:9211/api/store/app/my%20key', {
            method: 'DELETE',
            headers: { Accept: `application/vnd.colibri.v${PROTOCOL_VERSION}+json` }
        });
    });

    it('deleteRestObject returns false for a key that holds no value', async () => {
        const c = new Colibri('app', 'localhost', 9211);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 404 }));

        await expect(c.deleteRestObject('mykey')).resolves.toBe(false);
    });

    // As documented on the methods: an unreachable server rejects with fetch's own error, not null or false.
    it('getRestObject, setRestObject and deleteRestObject reject when the server cannot be reached', async () => {
        const c = new Colibri('app', 'localhost', 9211);
        const networkError = new TypeError('fetch failed');
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(networkError));

        await expect(c.getRestObject('mykey')).rejects.toBe(networkError);
        await expect(c.setRestObject('mykey', { a: 1 })).rejects.toBe(networkError);
        await expect(c.deleteRestObject('mykey')).rejects.toBe(networkError);
    });
});
