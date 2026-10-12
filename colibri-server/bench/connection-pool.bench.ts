import { bench, describe } from 'vitest';
import { Subject, Observable } from 'rxjs';
import { Payload } from '../src/server/modules/core/payload.js';
import {
    ConnectionPool,
    NetworkClient,
    NetworkMessage,
    NetworkServer
} from '../src/server/modules/command-hooks/connection-pool.js';

// Minimal stub server: enough surface for ConnectionPool, no sockets involved.
class FakeNetworkServer extends NetworkServer {
    private readonly messages = new Subject<NetworkMessage>();
    private readonly connected = new Subject<NetworkClient>();
    private readonly disconnected = new Subject<NetworkClient>();

    public get currentClients(): ReadonlyArray<NetworkClient> { return []; }
    public get messages$(): Observable<NetworkMessage> { return this.messages.asObservable(); }
    public get clientConnected$(): Observable<NetworkClient> { return this.connected.asObservable(); }
    public get clientDisconnected$(): Observable<NetworkClient> { return this.disconnected.asObservable(); }
    public broadcast(): void { /* no-op */ }

    public emit(msg: NetworkMessage): void {
        this.messages.next(msg);
    }
}

// Mirrors main.ts: 7 command-hook classes each register interest in messages once at
// startup. The Phase 0 baseline measured the old `messages$` getter, where each of the 7
// subscribers independently rebuilt merge(...of every transport's messages$) - 7
// independent merge/filter chains evaluated per message. Phase 1 item 14
// replaces that with a single merge() subscription in the constructor dispatching through
// onCommand's Map<command, handlers[]>.
//
// Setup (constructing the pool and registering handlers) happens once, outside the timed
// bench() callback, so this isolates steady-state dispatch cost from one-time constructor
// work - that construction cost isn't part of the hot path this item targets, and folding
// it into the timed loop would conflate the two. This differs from how the Phase 0 number
// for this file was measured (it built a fresh pool per timed iteration), so a Phase 0
// number recorded before that change is not directly comparable to this one.
const HOOK_COUNT = 7;
const MESSAGE_COUNT = 1000;

const serverA = new FakeNetworkServer();
const serverB = new FakeNetworkServer();
const pool = new ConnectionPool(serverA, serverB);

let received = 0;
for (let i = 0; i < HOOK_COUNT; i++) {
    pool.onCommand('model::update', () => { received++; });
}

describe('ConnectionPool message dispatch (v2: single merge + handler map)', () => {
    bench(`emit ${MESSAGE_COUNT} messages to ${HOOK_COUNT} handlers`, () => {
        for (let i = 0; i < MESSAGE_COUNT; i++) {
            serverA.emit({ channel: 'colibri', command: 'model::update', payload: Payload.fromValue({}) });
        }

        if (received === 0) throw new Error('benchmark did not observe any messages');
    });
});
