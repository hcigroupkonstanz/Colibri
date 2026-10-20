import { Payload, RingBuffer, Service } from '../core/index.js';
import { ConnectionPool } from './connection-pool.js';
import { hrtime } from 'process';
import { SocketIOServer } from '../networking/index.js';

// 125 s of 100 ms pings: the admin UI asks for the chart's 120 s, plus the 2 s it slides, when it opens.
const MAX_LATENCY_SAMPLES = 1250;

export class MeasureLatency extends Service {
    public get serviceName(): string { return 'MeasureLatency'; }
    public get groupName(): string { return 'hook'; }

    public constructor(pool: ConnectionPool, frontendConnection: SocketIOServer) {
        super();

        // Send out latency message
        // TCP clients are pinged by the worker's heartbeat frame (TCPServerWorker.handleHeartbeat,
        // handlePong); a second ping here would double their idle packets. This only reaches Socket.IO clients.
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
                // No timestamp, nothing to measure.
                if (ping === undefined || ping === null || ping === '') return;

                // Timestamps can exceed MAX_SAFE_INTEGER and then arrive as a rounded number; truncate it, BigInt() throws on a fraction.
                // Reject anything else; BigInt() of a huge digit string blocks the main thread.
                if (typeof ping === 'number' ? !Number.isFinite(ping) : typeof ping !== 'string' || !/^\d{1,20}$/.test(ping)) return;
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

