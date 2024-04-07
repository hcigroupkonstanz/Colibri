import * as _ from 'lodash';
import { TCP_SERVER_WORKER } from './tcp-server-worker';
import { WorkerServiceProxy } from '../core';
import { Observable, Subject } from 'rxjs';
import { NetworkClient, NetworkMessage, NetworkServer } from '../command-hooks';

export class TCPServerProxy
    extends WorkerServiceProxy
    implements NetworkServer {
    public serviceName = 'UnityServer';
    public groupName = 'unity';

    private clients: NetworkClient[] = [];
    private clientStream = new Subject<NetworkClient[]>();
    private clientAddedStream = new Subject<NetworkClient>();
    private clientRemovedStream = new Subject<NetworkClient>();

    private messageStream = new Subject<NetworkMessage>();

    public get clients$(): Observable<NetworkClient[]> {
        return this.clientStream.asObservable();
    }
    public get currentClients(): ReadonlyArray<NetworkClient> {
        return this.clients;
    }
    public get clientConnected$(): Observable<NetworkClient> {
        return this.clientAddedStream.asObservable();
    }
    public get clientDisconnected$(): Observable<NetworkClient> {
        return this.clientRemovedStream.asObservable();
    }
    public get messages$(): Observable<NetworkMessage> {
        return this.messageStream.asObservable();
    }

    public constructor() {
        super();
        this.initWorker(TCP_SERVER_WORKER);

        this.workerMessages$.subscribe((msg) => {
            switch (msg.channel) {
                case 'clientConnected$':
                    this.onClientConnected({
                        id: msg.content.id as string,
                        app: msg.content.app as string,
                        name: msg.content.name as string,
                        version: msg.content.version as string,
                        metadata: {},
                    });
                    break;

                case 'clientDisconnected$':
                    this.onClientDisconnected(msg.content.id as string);
                    break;

                case 'clientMessage$': {
                    const networkMessage = msg.content as unknown as NetworkMessage;
                    this.onClientMessage({
                        ...networkMessage,
                        origin: this.clients.find((c) => c.id === networkMessage.origin?.id),
                    });
                    break;
                }
            }
        });
    }

    public start(port: number, host: string): void {
        this.postMessage('m:start', { port: port, host: host });
        this.clientStream.next(this.clients);
    }

    public stop(): void {
        this.postMessage('m:stop');
    }

    public broadcast(
        msg: NetworkMessage,
        clients: ReadonlyArray<NetworkClient> = this.clients
    ): void {
        this.postMessage('m:broadcast', {
            msg: {
                channel: msg.channel,
                command: msg.command,
                payload: msg.payload,
            },
            clients: clients.map((c) => c.id),
        });
    }

    private onClientConnected(client: NetworkClient): void {
        this.clients.push(client);

        this.clientAddedStream.next(client);
        this.clientStream.next(this.clients);
    }

    private onClientDisconnected(id: string): void {
        const removedClients = _.remove(this.clients, (c) => c.id === id);
        for (const client of removedClients) {
            this.clientRemovedStream.next(client);
        }
        this.clientStream.next(this.clients);
    }

    private onClientMessage(msg: NetworkMessage): void {
        this.messageStream.next(msg);
    }
}
