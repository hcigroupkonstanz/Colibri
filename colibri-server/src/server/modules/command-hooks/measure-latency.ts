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
            const hrt = hrtime();
            const now = hrt[0] * 1000000 + hrt[1] / 1000;
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
                const hrt = hrtime();
                const now = hrt[0] * 1000000 + hrt[1] / 1000;
                const latency = (now - JSON.parse(m.payload as string)) / 1000;

                if (m.origin) {
                    if (m.origin.metadata['latency'] === undefined) {
                        m.origin.metadata['latency'] = [];
                    }

                    const latencies = m.origin.metadata['latency'] as number[];
                    latencies.push(latency);

                    while (latencies.length > 100) {
                        latencies.shift();
                    }
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
        }, 1000);
    }
}

