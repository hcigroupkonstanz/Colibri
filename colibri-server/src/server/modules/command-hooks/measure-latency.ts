import { filter } from 'rxjs/operators';
import { Service } from '../core';
import { ConnectionPool } from './connection-pool';
import { hrtime } from 'process';
import { SocketIOServer } from 'modules/networking';

export class MeasureLatency extends Service {
    public get serviceName(): string { return 'MeasureLatency'; }
    public get groupName(): string { return 'hook'; }

    public constructor(pool: ConnectionPool, frontendConnection: SocketIOServer) {
        super();

        // Send out latency message
        setInterval(() => {
            const now = hrtime.bigint();
            pool.broadcast({
                channel: 'colibri',
                command: 'latency',
                payload: now.toString(),
            });
        }, 100);


        // receive latency
        pool.messages$
            .pipe(filter(m => m.channel === 'colibri' && m.command === 'latency'))
            .subscribe(m => {
                try {
                    const now = hrtime.bigint();
                    const latency = Number(now - BigInt(JSON.parse(m.payload as string))) / 1000000;

                    if (m.origin) {
                        if (m.origin.metadata['latency'] === undefined) {
                            m.origin.metadata['latency'] = [];
                        }

                        const latencies = m.origin.metadata['latency'] as [number, number][];
                        latencies.push([Date.now(), Number(latency)]);

                        while (latencies.length > 1000) {
                            latencies.shift();
                        }
                    }
                } catch (e) {
                    this.logError('Error parsing latency message: ' + e);
                }
            });

        // send out data to server frontend
        setInterval(() => {
            frontendConnection.broadcast({
                channel: 'colibri::latency',
                command: 'update',
                payload: JSON.stringify(pool.currentClients.filter(c => c.app !== 'colibri').map(c => ({
                    id: c.id,
                    latency: c.metadata['latency'],
                }))),
            }, frontendConnection.currentClients);
        }, 100);
    }
}

