import * as net from 'node:net';
import { firstValueFrom } from 'rxjs';
import { filter, timeout } from 'rxjs/operators';
import { connect, type Socket } from 'socket.io-client';
import { Colibri, PROTOCOL_VERSION, type Message } from '../src/Colibri';

export const HOST = process.env.COLIBRI_E2E_SERVER ?? '127.0.0.1';
export const PORT = Number(process.env.COLIBRI_E2E_PORT ?? 9211);
// Where startLinkProxy listens; 0, the default, is any free port.
const PROXY_PORT = Number(process.env.COLIBRI_E2E_PROXY_PORT ?? 0);

let uniqueCounter = 0;

/**
 * Monotonic, per-process-unique app/key name
 * so parallel test runs never collide server-side state.
 */
export function uniqueApp(prefix: string): string {
    uniqueCounter += 1;
    return `${prefix}-${Date.now()}-${uniqueCounter}`;
}

/** Leaves no Colibri instance, as at the top of a module that runs before `new Colibri()`. */
export function resetSingleton(): void {
    (Colibri as unknown as { instance: Colibri | null }).instance = null;
}

function rawSocket(client: Colibri) {
    return (
        client as unknown as {
            socket: {
                connected: boolean;
                connect(): void;
                disconnect(): void;
                on(event: string, cb: () => void): void;
                once(event: string, cb: () => void): void;
                io: { engine: { close(): void }; reconnection(on: boolean): void };
            };
        }
    ).socket;
}

function closeSocket(client: Colibri): void {
    rawSocket(client).disconnect();
}

/**
 * Resolves once `client`'s underlying socket has completed its handshake.
 * Broadcast/model-sync relay is fire-and-forget with no replay for a client
 * that connects late, so every propagation test must await this for both
 * sides before sending the message under test; otherwise the message can
 * reach the server before the recipient has finished connecting and is lost
 * for good.
 */
function waitForConnect(client: Colibri): Promise<void> {
    const socket = rawSocket(client);
    if (socket.connected) return Promise.resolve();
    return new Promise(resolve => {
        socket.once('connect', resolve);
    });
}

/**
 * Cuts `client`'s connection the way a network drop does: underneath Socket.IO rather than through
 * disconnect(), so Socket.IO treats it as lost and reconnects by itself after its usual backoff
 * (0.5-1.5s by default). Resolves once the client has noticed it is disconnected.
 */
export function dropConnection(client: Colibri): Promise<void> {
    const socket = rawSocket(client);
    return new Promise(resolve => {
        socket.once('disconnect', resolve);
        socket.io.engine.close();
    });
}

/**
 * Like {@link dropConnection}, but the client stays away until the function this resolves with is
 * called - for a test that needs something to happen on the server first. That function reconnects
 * the same socket, as Socket.IO would have by itself, and resolves once it is connected again.
 */
export async function dropConnectionUntilReleased(client: Colibri): Promise<() => Promise<void>> {
    const socket = rawSocket(client);
    socket.io.reconnection(false);
    await dropConnection(client);

    return () => {
        socket.io.reconnection(true);
        const connected = new Promise<void>(resolve => {
            socket.once('connect', resolve);
        });
        socket.connect();
        return connected;
    };
}

export function isConnected(client: Colibri): boolean {
    return rawSocket(client).connected;
}

/** Resolves on `client`'s next connect, once Colibri itself has handled it (a reconnect included). */
export function nextConnect(client: Colibri): Promise<void> {
    return new Promise(resolve => {
        rawSocket(client).once('connect', resolve);
    });
}

/** A TCP proxy in front of the server, for a client to connect through (see {@link startLinkProxy}). */
export interface LinkProxy {
    readonly port: number;
    /**
     * From now on, drops whatever either end of each connection made so far writes, and tells
     * neither: a network that drops out (Wi-Fi, say) closes nothing.
     */
    freeze(): void;
    /**
     * Closes the client's end of each connection made so far, which is how the client finally
     * notices: Socket.IO's ping timeout, 45 s with the server's defaults, cut short. The server's
     * end stays open, and frozen, as the server has not noticed either.
     */
    cut(): void;
}

const proxies: { server: net.Server; sockets: Set<net.Socket> }[] = [];

/**
 * Starts a {@link LinkProxy} to the server. A client connects through it with
 * {@link createClientThrough}; {@link disconnectAll} closes it. With `delayMs`, whatever either end
 * writes reaches the other that much later, in order, as over a slow network; what is still on its
 * way when the link is frozen is lost.
 */
export async function startLinkProxy(delayMs = 0): Promise<LinkProxy> {
    const sockets = new Set<net.Socket>();
    const links: { client: net.Socket; upstream: net.Socket; frozen: boolean }[] = [];

    const server = net.createServer(client => {
        const upstream = net.connect(PORT, HOST);
        const link = { client, upstream, frozen: false };
        links.push(link);
        for (const socket of [client, upstream]) {
            sockets.add(socket);
            socket.on('close', () => sockets.delete(socket));
            // A reset after cut() is expected, and an unhandled 'error' would end the test run.
            socket.on('error', () => undefined);
        }

        const later = (pass: () => void) => {
            if (delayMs <= 0) {
                if (!link.frozen) pass();
                return;
            }
            setTimeout(() => {
                if (!link.frozen) pass();
            }, delayMs);
        };
        client.on('data', data => {
            later(() => upstream.write(data));
        });
        upstream.on('data', data => {
            later(() => client.write(data));
        });
        client.on('close', () => {
            later(() => upstream.destroy());
        });
        upstream.on('close', () => {
            later(() => client.destroy());
        });
    });
    proxies.push({ server, sockets });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(PROXY_PORT, '127.0.0.1', () => {
            resolve();
        });
    });

    return {
        port: (server.address() as net.AddressInfo).port,
        freeze: () => {
            for (const link of links) link.frozen = true;
        },
        cut: () => {
            for (const link of links.splice(0)) {
                link.frozen = true;
                link.client.destroy();
            }
        }
    };
}

/** Like {@link createClient}, but connecting through `proxy`. */
export async function createClientThrough(app: string, proxy: LinkProxy): Promise<Colibri> {
    return connectNew(() => new Colibri(app, '127.0.0.1', proxy.port));
}

/** Resolves once `client` has failed `count` connection attempts. */
export function connectErrors(client: Colibri, count: number): Promise<void> {
    const socket = rawSocket(client);
    let seen = 0;
    return new Promise(resolve => {
        socket.on('connect_error', () => {
            seen += 1;
            if (seen === count) resolve();
        });
    });
}

const activeClients: Colibri[] = [];

/**
 * Creates another client of `app`, connected, without making it the singleton: whatever was the
 * singleton stays so, and the high-level API (Sync, RegisterModelSync) goes on using it.
 */
export async function createPeer(app: string): Promise<Colibri> {
    const singleton = Colibri.getInstance(false);
    const peer = await createClient(app);
    (Colibri as unknown as { instance: Colibri | null }).instance = singleton;
    return peer;
}

/**
 * Creates a client for `server` and `port` without waiting for it to connect - for an address
 * that is not expected to answer. Disconnected by {@link disconnectAll} like any other.
 */
export function createUnconnectedClient(app: string, server: string, port: number): Colibri {
    resetSingleton();
    const client = new Colibri(app, server, port);
    activeClients.push(client);
    return client;
}

/** Creates a standalone client against the real server, becoming the current singleton. */
export async function createClient(app: string): Promise<Colibri> {
    return connectNew(() => new Colibri(app, HOST, PORT));
}

/**
 * Like {@link createClient}, but connecting to `server` exactly as given, with no port argument -
 * for the address forms a user would paste, which must name this server (and its port) by
 * themselves.
 */
export async function createClientWithAddress(app: string, server: string): Promise<Colibri> {
    return connectNew(() => new Colibri(app, server));
}

async function connectNew(construct: () => Colibri): Promise<Colibri> {
    resetSingleton();
    const client = construct();
    activeClients.push(client);
    await waitForConnect(client);
    return client;
}

/**
 * Creates a raw peer client (constructed first, never the singleton) plus a
 * singleton client (constructed last) on the *same* app (broadcast/model-sync
 * relay is scoped per-app server-side, so the two must share one to talk to
 * each other at all) for exercising the high-level API
 * (Sync/RegisterModelSync/RemoteLogger) which only ever talks through
 * Colibri.getInstance().
 */
export async function createSingletonWithPeer(app: string): Promise<{
    singleton: Colibri;
    peer: Colibri;
}> {
    resetSingleton();
    const peer = new Colibri(app, HOST, PORT);
    activeClients.push(peer);
    await waitForConnect(peer);

    resetSingleton();
    const singleton = new Colibri(app, HOST, PORT);
    activeClients.push(singleton);
    await waitForConnect(singleton);

    return { singleton, peer };
}

const adminSockets: Socket[] = [];

/**
 * Connects the way the server's admin UI does - a raw socket, since the Colibri class is for
 * applications - and so is told about every client that connects or disconnects. Its
 * `disconnected(app)` resolves once the server has seen a client of `app` go, by which time the
 * server is done with it: if it was the app's last client, the app's models are gone.
 */
export async function connectAsAdminUi(): Promise<{ disconnected(app: string): Promise<void> }> {
    const socket = connect(`ws://${HOST}:${PORT}`, {
        query: { app: 'colibri', version: PROTOCOL_VERSION },
        transports: ['websocket'],
        reconnection: false
    });
    adminSockets.push(socket);
    await new Promise<void>(resolve => {
        socket.once('connect', () => {
            resolve();
        });
    });

    return {
        disconnected: (app: string) =>
            new Promise(resolve => {
                const onClients = (msg: { command: string; payload?: { app?: string } }) => {
                    if (msg.command !== 'client::disconnected' || msg.payload?.app !== app) return;
                    socket.off('colibri::clients', onClients);
                    resolve();
                };
                socket.on('colibri::clients', onClients);
            })
    };
}

/**
 * Disconnects and forgets every client created via this module, closes every proxy, and clears the
 * singleton.
 */
export function disconnectAll(): void {
    let client: Colibri | undefined;
    while ((client = activeClients.pop()) !== undefined) {
        closeSocket(client);
    }
    let admin: Socket | undefined;
    while ((admin = adminSockets.pop()) !== undefined) {
        admin.disconnect();
    }
    for (const { server, sockets } of proxies.splice(0)) {
        server.close();
        for (const socket of sockets) socket.destroy();
    }
    resetSingleton();
}

/**
 * Resolves with the first inbound message on `channel` (optionally filtered
 * by `command`), or rejects if none arrives within `timeoutMs`.
 */
export function nextMessage(
    client: Colibri,
    match: { channel: string; command?: string },
    timeoutMs = 8000
): Promise<Message> {
    return firstValueFrom(
        client.messages.pipe(
            filter(
                msg => msg.channel === match.channel && (match.command === undefined || msg.command === match.command)
            ),
            timeout(timeoutMs)
        )
    );
}
