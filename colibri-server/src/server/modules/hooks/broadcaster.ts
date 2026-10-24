import { Service } from '../core/service.js';
import type { ConnectionPool } from './connection-pool.js';
import type { NetworkMessage } from '../protocol/network.js';

export class Broadcaster extends Service {
    public serviceName = 'Broadcaster';
    public groupName = 'colibri';

    public constructor(private readonly connectionPool: ConnectionPool) {
        super();

        connectionPool.onMessage(msg => msg.command.startsWith('broadcast::'), this.broadcast.bind(this));
    }

    private broadcast(msg: NetworkMessage): void {
        this.connectionPool.broadcast(msg);
    }
}