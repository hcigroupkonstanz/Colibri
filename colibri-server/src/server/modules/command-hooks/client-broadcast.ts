import { Payload, Service } from '../core/index.js';
import { ConnectionPool, NetworkClient, NetworkMessage } from './connection-pool.js';

/**
 *  Broadcasts infos about current clients (i.e., client dis-/connected)
 */
export class ClientBroadcast extends Service {
    public get serviceName(): string { return 'ClientBroadcast'; }
    public get groupName(): string { return 'hook'; }

    public constructor(private pool: ConnectionPool) {
        super();

        pool.clientConnected$
            .subscribe(c => this.broadcastClient(c, 'client::connected'));

        pool.clientDisconnected$
            .subscribe(c => this.broadcastClient(c, 'client::disconnected'));

        pool.onCommand('client::request', msg => {
            if (msg.channel === 'colibri::clients') this.sendInitialState(msg);
        });
    }

    private broadcastClient(client: NetworkClient, event: string): void {
        const msg = {
            channel: 'colibri::clients',
            command: event,
            payload: Payload.fromValue({
                id: client.id,
                name: client.name,
                app: client.app
            }),
        };

        // ignore frontend clients
        if (client.app && client.app !== 'colibri') {
            this.pool.broadcast(msg, client.app);
            // broadcast to frontend
            this.pool.broadcast(msg, 'colibri');
        }
    }

    private sendInitialState(msg: NetworkMessage): void {
        this.logDebug('initial state');
        if (msg.origin === undefined)
            return;

        // typescript being a bit stupid
        const origin = msg.origin;

        const clients = this.pool.currentClients
            .filter(c => {
                // send all clients to frontend
                if (origin.app === 'colibri')
                    return c.app !== 'colibri';
                // send only clients of the same app to other clients
                return c.app === origin.app;
            })
            .map(c => ({
                id: c.id,
                name: c.name,
                app: c.app,
                version: c.version,
            }));

        for (const client of clients) {
            this.pool.emit({
                channel: 'colibri::clients',
                command: 'client::connected',
                payload: Payload.fromValue(client),
            }, msg.origin);
        }
    }
}


