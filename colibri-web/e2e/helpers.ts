import { firstValueFrom } from 'rxjs';
import { filter, timeout } from 'rxjs/operators';
import { Colibri, type Message } from '../src/Colibri';

export const HOST = process.env.COLIBRI_E2E_SERVER ?? '127.0.0.1';
export const PORT = Number(process.env.COLIBRI_E2E_PORT ?? 9011);

let uniqueCounter = 0;

/** Monotonic, per-process-unique app/key name so parallel test runs never collide server-side state. */
export function uniqueApp(prefix: string): string {
    uniqueCounter += 1;
    return `${prefix}-${Date.now()}-${uniqueCounter}`;
}

function resetSingleton(): void {
    (Colibri as unknown as { instance: Colibri | null }).instance = null;
}

function rawSocket(client: Colibri) {
    return (
        client as unknown as {
            socket: {
                connected: boolean;
                disconnect(): void;
                once(event: string, cb: () => void): void;
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
 * sides before sending the message under test — otherwise the message can
 * reach the server before the recipient has finished connecting and is lost
 * for good.
 */
function waitForConnect(client: Colibri): Promise<void> {
    const socket = rawSocket(client);
    if (socket.connected) return Promise.resolve();
    return new Promise((resolve) => {
        socket.once('connect', resolve);
    });
}

const activeClients: Colibri[] = [];

/** Creates a standalone client against the real server, becoming the current singleton. */
export async function createClient(app: string): Promise<Colibri> {
    resetSingleton();
    const client = new Colibri(app, HOST, PORT);
    activeClients.push(client);
    await waitForConnect(client);
    return client;
}

/**
 * Creates a raw peer client (constructed first, never the singleton) plus a
 * singleton client (constructed last) on the *same* app — broadcast/model-sync
 * relay is scoped per-app server-side, so the two must share one to talk to
 * each other at all — for exercising the high-level API
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

/** Disconnects and forgets every client created via this module, and clears the singleton. */
export function disconnectAll(): void {
    let client: Colibri | undefined;
    while ((client = activeClients.pop()) !== undefined) {
        closeSocket(client);
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
                msg =>
                    msg.channel === match.channel
                    && (match.command === undefined
                        || msg.command === match.command)
            ),
            timeout(timeoutMs)
        )
    );
}
