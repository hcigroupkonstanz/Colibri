import { Service } from '../core/index.js';
import { ConnectionPool, NetworkMessage } from './connection-pool.js';

export class BroadcastLogger extends Service {
    public get serviceName(): string { return 'BroadcastLogger'; }
    public get groupName(): string { return 'hook'; }

    public constructor(pool: ConnectionPool) {
        super();
        pool.onMessage(msg => msg.command.startsWith('broadcast::'), this.logBroadcast.bind(this));
    }

    // Message text deliberately excludes the payload value: WebLog dedups log entries by
    // exact (message, group, level) match, and embedding the synced value would make every
    // tick's text unique, defeating dedup under continuous sync traffic.
    private logBroadcast(msg: NetworkMessage): void {
        const name = msg.origin?.name ?? 'UNKNOWN';
        this.logDebug(
            `[${name}] broadcast ${msg.channel} (${msg.command})`,
            {
                clientApp: msg.origin?.app ?? 'UNKNOWN',
                clientName: name,
                clientId: msg.origin?.id ?? 'UNKNOWN',
                channel: msg.channel,
                command: msg.command,
                broadcastTraffic: true,
            }
        );
    }
}
