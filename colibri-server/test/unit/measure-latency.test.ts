import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Subject } from 'rxjs';
import { ConnectionPool } from '../../src/server/modules/command-hooks/connection-pool.js';
import type { NetworkClient, NetworkMessage, NetworkServer } from '../../src/server/modules/networking/network.js';
import { MeasureLatency } from '../../src/server/modules/command-hooks/measure-latency.js';
import { SocketIOServer } from '../../src/server/modules/networking/socket-io-server.js';
import { Payload } from '../../src/server/modules/core/payload.js';
import { RingBuffer } from '../../src/server/modules/core/ring-buffer.js';
import { Service } from '../../src/server/modules/core/service.js';
import { LogLevel, LogMessage } from '../../src/server/modules/core/log-message.js';

class FakeServer implements NetworkServer {
    public messagesSource = new Subject<NetworkMessage>();
    public get currentClients(): ReadonlyArray<NetworkClient> { return []; }
    public get clientConnected$() { return new Subject<NetworkClient>().asObservable(); }
    public get clientDisconnected$() { return new Subject<NetworkClient>().asObservable(); }
    public get messages$() { return this.messagesSource.asObservable(); }
    public broadcast(): void { /* nothing to record */ }
}

describe('MeasureLatency', () => {
    let server: FakeServer;
    let client: NetworkClient;
    let logs: LogMessage[];

    beforeEach(() => {
        vi.useFakeTimers();
        server = new FakeServer();
        const frontend = { broadcast: () => undefined, currentClients: [] } as unknown as SocketIOServer;
        new MeasureLatency(new ConnectionPool(server), frontend);
        client = { id: 'w1', app: 'appA', name: 'w1', version: '2', metadata: {} };
        logs = [];
        Service.output$.subscribe(m => logs.push(m));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    const ping = (payload: Payload): void =>
        server.messagesSource.next({ origin: client, channel: 'colibri', command: 'latency', payload });

    const samples = (): number => (client.metadata['latency'] as RingBuffer<[number, number]> | undefined)?.length ?? 0;

    it('takes a timestamp as a number or as a string of digits', () => {
        ping(Payload.fromValue(Number(process.hrtime.bigint())));
        ping(Payload.fromString(process.hrtime.bigint().toString()));

        expect(samples()).toBe(2);
    });

    // BigInt() of a string of millions of digits blocked the main thread for seconds.
    it('ignores anything else, quickly and without an error', () => {
        const started = performance.now();
        ping(Payload.fromValue('1'.repeat(2_000_000)));
        ping(Payload.fromValue('not a time'));
        ping(Payload.fromValue(Number.POSITIVE_INFINITY));
        ping(Payload.fromValue({ at: 1 }));

        expect(performance.now() - started).toBeLessThan(200);
        expect(samples()).toBe(0);
        expect(logs.filter(l => l.level === LogLevel.Error)).toEqual([]);
    });
});
