import { Payload, RingBuffer, Service } from '../core/index.js';
import { ConnectionPool } from './connection-pool.js';
import { hrtime } from 'process';
import { SocketIOServer } from '../networking/index.js';

// 125 s of the 100 ms pings: the admin UI's latency chart shows the last 120 s, and asks for them
// when it opens.
const MAX_LATENCY_SAMPLES = 1250;

export class MeasureLatency extends Service {
    public get serviceName(): string { return 'MeasureLatency'; }
    public get groupName(): string { return 'hook'; }

    public constructor(pool: ConnectionPool, frontendConnection: SocketIOServer) {
        super();

        // Send out latency message. TCP clients get their ping merged into the worker's
        // own 100ms heartbeat frame instead (see TCPServerWorker.handleHeartbeat /
        // handlePong) - pinging them here too would double idle packet rate for no
        // reason, so this only targets Socket.IO (web) clients directly.
        setInterval(() => {
            const now = hrtime.bigint();
            frontendConnection.broadcast({
                channel: 'colibri',
                command: 'latency',
                payload: Payload.fromString(now.toString()),
            }, frontendConnection.currentClients);
        }, 100);


        // batch latencies for frontend updates
        let batchedLatencies: { [id: string]: [number, number][] } = {};

        // receive latency
        pool.onCommand('latency', m => {
            if (m.channel !== 'colibri') return;

            try {
                const ping = m.payload?.asValue<number | string>();
                // Defaulting a missing timestamp to 0 turned every payload-less 'latency'
                // message into a multi-million-millisecond sample in the ring buffer and
                // the admin UI's chart. There is nothing to measure here, so skip it.
                if (ping === undefined || ping === null || ping === '') return;

                // hrtime nanoseconds can exceed Number.MAX_SAFE_INTEGER, in which case
                // JSON.parse hands back a rounded float that BigInt() rejects outright -
                // truncating keeps the sample instead of discarding it over a few nanos.
                const pingNanos = typeof ping === 'number' ? BigInt(Math.trunc(ping)) : BigInt(ping);
                const now = hrtime.bigint();
                const latency = Number(now - pingNanos) / 1000000;

                if (m.origin) {
                    if (m.origin.metadata['latency'] === undefined) {
                        m.origin.metadata['latency'] = new RingBuffer<[number, number]>(MAX_LATENCY_SAMPLES);
                    }

                    const latencies = m.origin.metadata['latency'] as RingBuffer<[number, number]>;
                    const l: [number, number] = [Date.now(), Number(latency)];
                    latencies.push(l);

                    if (batchedLatencies[m.origin.id] === undefined) {
                        batchedLatencies[m.origin.id] = [];
                    }
                    batchedLatencies[m.origin.id]?.push(l);
                }
            } catch (e) {
                this.logError('Error parsing latency message: ' + e, false);
            }
        });

        // send out data to server frontend
        setInterval(() => {
            frontendConnection.broadcast({
                channel: 'colibri::latency',
                command: 'update',
                payload: Payload.fromValue(batchedLatencies),
            }, frontendConnection.currentClients);
            batchedLatencies = {};
        }, 1000);
    }
}

