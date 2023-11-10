import { filter } from 'rxjs/operators';
import { Service } from '../core';
import { ConnectionPool } from './connection-pool';

export class ClientLogger extends Service {
    public get serviceName(): string { return 'ClientLogger'; }
    public get groupName(): string { return 'hook'; }

    public constructor(pool: ConnectionPool) {
        super();

        pool.messages$
            .pipe(filter(m => m.channel === 'log' && m.command !== 'requestLog'))
            .subscribe(m => {
                const name = m.origin?.name || 'UNKNOWN';
                switch (m.command) {
                    case 'info':
                        this.logInfo(`[${name}] ${m.payload}`);
                        break;

                    case 'warning':
                        this.logWarning(`[${name}] ${m.payload}`);
                        break;

                    case 'error':
                        this.logError(`[${name}] ${m.payload}`, false);
                        break;

                    case 'debug':
                    default:
                        this.logDebug(`[${name}] ${m.payload}`);
                        break;
                }
            });
    }
}
