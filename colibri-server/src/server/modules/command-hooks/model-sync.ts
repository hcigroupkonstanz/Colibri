import { filter } from 'rxjs';
import { Service } from '../core';
import { ConnectionPool, NetworkMessage } from './connection-pool';
import { DataStore, SyncModel } from './data-store';

export class ModelSynchronization extends Service {
    public serviceName = 'ModelSync';
    public groupName = 'colibri';

    public constructor(private connectionPool: ConnectionPool, private store: DataStore) {
        super();

        connectionPool.messages$
            .pipe(filter(msg => msg.command === 'model::request'))
            .subscribe(this.sendInitialState.bind(this));

        connectionPool.messages$
            .pipe(filter(msg => msg.command === 'model::update'))
            .subscribe(this.onModelUpdate.bind(this));

        connectionPool.messages$
            .pipe(filter(msg => msg.command === 'model::delete'))
            .subscribe(this.onModelDelete.bind(this));

        
        // clear datastore when all clients from the same app disconnect
        connectionPool.clientDisconnected$.subscribe(client => {
            const hasClients = this.connectionPool.currentClients.some(c => c.app === client.app);
            if (!hasClients) {
                this.store.clearApp(client.app);
            }
        });
    }

    public sendInitialState(msg: NetworkMessage): void {
        if (!msg.origin) {
            this.logError('Cannot send initial state to unknown client');
            return;
        }

        const app = msg.origin.app;
        try {
            const payload = JSON.parse(msg.payload || '{}') as { id?: string };

            if (typeof(payload?.id) === 'string') {
                const model = this.store.getModel(app, msg.channel, payload.id) || { id: payload.id };
                this.connectionPool.emit({
                    channel: msg.channel,
                    command: 'model::update',
                    payload: JSON.stringify(model)
                }, msg.origin);
            } else {
                for (const model of this.store.getAll(app, msg.channel)) {
                    this.connectionPool.emit({
                        channel: msg.channel,
                        command: 'model::update',
                        payload: JSON.stringify(model)
                    }, msg.origin);
                }
            }
        } catch (error) {
            this.logError(`Failed to send initial state to client ${msg.origin.id}: ${error}`);
        }
    }

    public onModelUpdate(msg: NetworkMessage): void {
        if (!msg.origin) {
            this.logError('Cannot send initial state to unknown client');
            return;
        }

        const payload = msg.payload as { id?: string };
        if (typeof(payload?.id) !== 'string') {
            this.logError('Cannot update model without "id" attribute');
            return;
        }

        this.store.updateModel(msg.origin.app, msg.channel, payload as SyncModel);
        this.connectionPool.broadcast(msg);
    }

    public onModelDelete(msg: NetworkMessage): void {
        if (!msg.origin) {
            this.logError('Cannot send initial state to unknown client');
            return;
        }

        if (typeof(msg.payload) === 'string') {
            this.logError('Invalid delete message!');
            return;
        }

        if (msg.payload) {
            this.store.removeModel(msg.origin.app, msg.channel, msg.payload);
            this.connectionPool.broadcast(msg);
        } else {
            this.logWarning('Received delete message without payload');
        }
    }
}