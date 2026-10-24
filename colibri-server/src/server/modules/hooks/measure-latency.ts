import { Payload } from '../protocol/payload.js';
import { COLIBRI_CHANNEL } from '../protocol/protocol.js';
import { RingBuffer } from '../core/ring-buffer.js';
import { Service } from '../core/service.js';
import type { ConnectionPool } from './connection-pool.js';
import { hrtime } from 'process';
import type { NetworkMessage, NetworkServer } from '../protocol/network.js';

// 125 s of 100 ms pings: the admin UI asks for the chart's 120 s, plus the 2 s it slides, when it opens.
const MAX_LATENCY_SAMPLES = 1250;

export class MeasureLatency extends Service {
    public get serviceName(): string { return 'MeasureLatency'; }
    public get groupName(): string { return 'hook'; }

    // batch latencies for frontend updates
    private batchedLatencies: { [id: string]: [number, number][] } = {};

    public constructor(pool: ConnectionPool, frontendConnection: NetworkServer) {
        super();

        // Send out latency message
        // TCP clients are pinged by the worker's heartbeat frame (TCPServerWorker.handleHeartbeat,
        // handlePong); a second ping here would double their idle packets. This only reaches Socket.IO clients.
        setInterval(() => this.sendPing(frontendConnection), 100);

        // receive latency
        pool.onCommand('latency', m => this.receiveLatency(m));

        // send out data to server frontend
        setInterval(() => this.sendBatch(frontendConnection), 1000);
    }

    private sendPing(frontendConnection: NetworkServer): void {
        const now = hrtime.bigint();
        frontendConnection.broadcast({
            channel: COLIBRI_CHANNEL,
            command: 'latency',
            payload: Payload.fromString(now.toString()),
        }, frontendConnection.currentClients);
    }

    private receiveLatency(m: NetworkMessage): void {
        if (m.channel !== COLIBRI_CHANNEL) return;

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

                if (this.batchedLatencies[m.origin.id] === undefined) {
                    this.batchedLatencies[m.origin.id] = [];
                }
                this.batchedLatencies[m.origin.id]?.push(l);
            }
        } catch (e) {
            this.logError('Error parsing latency message: ' + e, false);
        }
    }

    private sendBatch(frontendConnection: NetworkServer): void {
        frontendConnection.broadcast({
            channel: 'colibri::latency',
            command: 'update',
            payload: Payload.fromValue(this.batchedLatencies),
        }, frontendConnection.currentClients);
        this.batchedLatencies = {};
    }
}

