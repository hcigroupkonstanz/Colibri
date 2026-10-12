import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect } from 'socket.io-client';
import { PROTOCOL_VERSION } from '../src/Colibri';
import {
    HOST,
    PORT,
    connectErrors,
    createClient,
    createUnconnectedClient,
    disconnectAll,
    nextMessage,
    uniqueApp
} from './helpers';

// A host name that cannot resolve, anywhere: '.invalid' is reserved for exactly that (RFC 2606).
// Unlike a port nothing listens on, it cannot turn out to be some other process's server.
const UNRESOLVABLE_HOST = 'colibri-e2e.invalid';

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

    // A wrong address used to retry forever without a word, which looks exactly like a slow
    // connection. Now the first failed attempt says so, and the retries after it do not.
    it('warns once about an address nothing answers on, however often it retries', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const client = createUnconnectedClient(uniqueApp('connection-wrong-host'), UNRESOLVABLE_HOST, PORT);

            await connectErrors(client, 3);

            expect(warnSpy).toHaveBeenCalledTimes(1);
            const [message] = warnSpy.mock.calls[0] as [string];
            expect(message).toContain(`ws://${UNRESOLVABLE_HOST}:${PORT}`);
            // The underlying error (ENOTFOUND, or EAI_AGAIN without a resolver), not just Socket.IO's.
            expect(message).toMatch(/websocket error: \S/);
            expect(message).toContain('Retrying');
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('does not warn about a server that answers', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const client = await createClient(uniqueApp('connection-quiet'));
            await nextMessage(client, { channel: 'colibri', command: 'latency' }, 3000);

            expect(warnSpy).not.toHaveBeenCalled();
        } finally {
            warnSpy.mockRestore();
        }
    });

    // The signal a client uses to tell this server from one predating the version check. A raw
    // socket, because the Colibri class consumes this message rather than surfacing it - what
    // matters here is that the *server* sends it, unprompted, to an accepted client.
    it('announces its protocol version on connect', async () => {
        const socket = connect(`ws://${HOST}:${PORT}`, {
            query: { app: uniqueApp('protocol-hello'), version: PROTOCOL_VERSION },
            transports: ['websocket'],
            reconnection: false
        });

        try {
            const hello = await new Promise<Record<string, unknown>>((resolve, reject) => {
                const timer = setTimeout(() => {
                    reject(new Error('the server never announced itself'));
                }, 5000);
                socket.on('colibri', (msg: { command: string; payload: Record<string, unknown> }) => {
                    if (msg.command !== 'protocol::accepted') return;
                    clearTimeout(timer);
                    resolve(msg.payload);
                });
            });

            expect(hello.serverVersion).toBe(PROTOCOL_VERSION);
            expect(socket.connected).toBe(true);
        } finally {
            socket.disconnect();
        }
    });

    // The Colibri class always announces PROTOCOL_VERSION, so a mismatch can only be
    // produced with a raw socket - which is also the honest shape of the test, since what
    // matters is what the *server* does with a version it does not support.
    it('refuses a client announcing an unsupported protocol version', async () => {
        const socket = connect(`ws://${HOST}:${PORT}`, {
            query: { app: uniqueApp('protocol-mismatch'), version: `${PROTOCOL_VERSION}-wrong` },
            transports: ['websocket'],
            reconnection: false
        });

        try {
            const rejection = await new Promise<Record<string, unknown>>((resolve, reject) => {
                const timer = setTimeout(() => {
                    reject(new Error('no rejection received'));
                }, 5000);
                socket.on('colibri', (msg: { command: string; payload: Record<string, unknown> }) => {
                    if (msg.command !== 'protocol::rejected') return;
                    clearTimeout(timer);
                    resolve(msg.payload);
                });
            });

            expect(rejection.serverVersion).toBe(PROTOCOL_VERSION);
            expect(rejection.clientVersion).toBe(`${PROTOCOL_VERSION}-wrong`);
            expect(String(rejection.reason)).toContain('Unsupported protocol version');

            // And the server must not leave the refused client connected.
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => {
                    reject(new Error('server never closed the connection'));
                }, 5000);
                if (!socket.connected) {
                    clearTimeout(timer);
                    resolve();
                    return;
                }
                socket.on('disconnect', () => {
                    clearTimeout(timer);
                    resolve();
                });
            });
        } finally {
            socket.disconnect();
        }
    });
});
