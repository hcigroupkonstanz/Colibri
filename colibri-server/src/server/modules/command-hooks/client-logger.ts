import { filter } from 'rxjs/operators';
import { Service } from '../core';
import { ConnectionPool } from './connection-pool';

export class ClientLogger extends Service {
    public get serviceName(): string { return 'ClientLogger'; }
    public get groupName(): string { return 'unity'; }

    public constructor(pool: ConnectionPool) {
        super();

        pool.messages$
            .pipe(filter(m => m.channel === 'log'))
            .subscribe(m => {
                const id = m.origin?.id || 'UNKNOWN';
                switch (m.command) {
                    case 'info':
                        this.logInfo(`[${id}] ${m.payload}`);
                        break;

                    case 'warning':
                        this.logWarning(`[${id}] ${m.payload}`);
                        break;

                    case 'error':
                        this.logError(`[${id}] ${m.payload}`, false);
                        break;

                    case 'debug':
                    default:
                        this.logDebug(`[${id}] ${m.payload}`);
                        break;
                }
            });
    }
}
