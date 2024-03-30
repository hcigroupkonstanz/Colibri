import { Observable, merge } from 'rxjs';
import { Service } from '../core';

export interface NetworkMessage {
    origin?: NetworkClient;
    channel: string;
    command: string;
    payload?: string;
}

export interface NetworkClient {
    id: string;
    app: string;
    name: string;
    metadata: Record<string, unknown>;
}

export abstract class NetworkServer {
    public abstract get currentClients(): ReadonlyArray<NetworkClient>;
    public abstract get messages$(): Observable<NetworkMessage>;
    public abstract get clientConnected$(): Observable<NetworkClient>;
    public abstract get clientDisconnected$(): Observable<NetworkClient>;
    public abstract broadcast(message: NetworkMessage, clients: ReadonlyArray<NetworkClient>): void;
}

export class ConnectionPool extends Service {
    public serviceName = 'ConnectionPool';
    public groupName = 'colibri';

    private readonly servers: NetworkServer[];

    public get messages$(): Observable<NetworkMessage> {
        return merge(...this.servers.map(c => c.messages$));
    }

    public get clientConnected$(): Observable<NetworkClient> {
        return merge(...this.servers.map(c => c.clientConnected$));
    }

    public get clientDisconnected$(): Observable<NetworkClient> {
        return merge(...this.servers.map(c => c.clientDisconnected$));
    }

    public get currentClients(): NetworkClient[] {
        return this.servers.flatMap(c => c.currentClients);
    }

    public constructor(...servers: NetworkServer[]) {
        super();
        this.servers = servers;
    }


    public broadcast(message: NetworkMessage, app = message.origin?.app): void {
        for (const connection of this.servers) {
            let clients = connection.currentClients;
            if (app) {
                clients = clients.filter(client => client.app === app && client.id !== message.origin?.id);
            }

            connection.broadcast(message, clients);
        }
    }

    public emit(message: NetworkMessage, client: NetworkClient): void {
        for (const connection of this.servers) {
            if (connection.currentClients.find(c => c.id === client.id)) {
                connection.broadcast(message, [ client ]);
            }
        }
    }
}