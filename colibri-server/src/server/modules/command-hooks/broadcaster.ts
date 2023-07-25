import { filter } from 'rxjs';
import { Service } from '../core';
import { ConnectionPool, NetworkMessage } from './connection-pool';

export class Broadcaster extends Service {
    public serviceName = 'Broadcaster';
    public groupName = 'colibri';

    public constructor(private connectionPool: ConnectionPool) {
        super();

        connectionPool.messages$
            .pipe(filter(msg => msg.command.startsWith('broadcast::')))
            .subscribe(this.broadcast.bind(this));
    }

    private broadcast(msg: NetworkMessage): void {
        this.connectionPool.broadcast(msg);
    }
}