import { Service } from '../core/index.js';
import { ConnectionPool, NetworkMessage } from './connection-pool.js';

export class Broadcaster extends Service {
    public serviceName = 'Broadcaster';
    public groupName = 'colibri';

    public constructor(private connectionPool: ConnectionPool) {
        super();

        connectionPool.onMessage(msg => msg.command.startsWith('broadcast::'), this.broadcast.bind(this));
    }

    private broadcast(msg: NetworkMessage): void {
        this.connectionPool.broadcast(msg);
    }
}