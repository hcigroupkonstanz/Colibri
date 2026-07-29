import { execFile } from 'node:child_process';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { connect } from 'socket.io-client';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '../../colibri-server');

const HOST = process.env.COLIBRI_E2E_SERVER ?? '127.0.0.1';
const PORT = Number(process.env.COLIBRI_E2E_PORT ?? 9011);

async function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const ok = await new Promise<boolean>(resolve => {
            const socket = net.connect(port, host);
            socket.once('connect', () => {
                socket.end();
                resolve(true);
            });
            socket.once('error', () => {
                resolve(false);
            });
        });
        if (ok) return;
        if (Date.now() >= deadline) {
            throw new Error(`Timed out waiting for ${host}:${port} to accept connections`);
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}

async function waitForSocketIoHandshake(host: string, port: number, timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const socket = connect(`ws://${host}:${port}`, {
            query: { app: 'e2e-globalsetup-probe', version: '2' },
            transports: ['websocket'],
            reconnectionDelay: 250,
            reconnectionDelayMax: 250
        });

        const timer = setTimeout(() => {
            socket.close();
            reject(new Error('Timed out waiting for Socket.IO handshake'));
        }, timeoutMs);

        socket.once('connect', () => {
            clearTimeout(timer);
            socket.close();
            resolve();
        });
    });
}

export default async function setup() {
    if (process.env.COLIBRI_E2E_SERVER) {
        // An already-running server is assumed; nothing for us to build or tear down.
        await waitForPort(HOST, PORT, 30_000);
        await waitForSocketIoHandshake(HOST, PORT, 30_000);
        return async () => {
            /* server lifecycle managed externally */
        };
    }

    const composeArgs = ['compose', 'up', '-d'];
    if (!process.env.COLIBRI_E2E_NO_BUILD) composeArgs.push('--build');

    await execFileAsync('docker', composeArgs, { cwd: SERVER_DIR });

    try {
        await waitForPort(HOST, PORT, 180_000);
        await waitForSocketIoHandshake(HOST, PORT, 30_000);
    } catch (error) {
        await execFileAsync('docker', ['compose', 'down'], {
            cwd: SERVER_DIR
        }).catch(() => undefined);
        throw error;
    }

    return async () => {
        await execFileAsync('docker', ['compose', 'down'], {
            cwd: SERVER_DIR
        });
    };
}
