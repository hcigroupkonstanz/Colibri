import * as io from 'socket.io';
import * as _ from 'lodash';
import { Server as HttpServer } from 'http';
import { Observable, Subject } from 'rxjs';

import { Service, Message } from '../core';

class SocketIoClient {
    socket: io.Socket;
    group: string;
}

interface SocketMessage extends Message {
    origin: SocketIoClient;
}

export class SocketIOServer extends Service {
    public get serviceName(): string { return 'SocketIO'; }
    public get groupName(): string { return 'tangibles'; }

    private ioServer: io.Server;

    private readonly clients: SocketIoClient[] = [];
    private readonly clientStream = new Subject<SocketIoClient[]>();
    private readonly clientConnectedStream = new Subject<SocketIoClient>();
    private readonly clientDisconnectedStream = new Subject<SocketIoClient>();
    private readonly messageStream = new Subject<SocketMessage>();

    public constructor() {
        super();
    }


    public start(server: HttpServer): void {
        this.ioServer = new io.Server(server, {
            cors: {
                origin: '*'
            }
        });

        this.ioServer.on('connection', (socket) => {
            this.handleNewClient(socket);
        });

        this.logInfo('Successfully attached SocketIO to webserver');
        this.clientStream.next(this.clients);
    }

    public stop(): void {
        this.ioServer.close();
        this.logInfo('Stopped SocketIO server');
    }

    public get clients$(): Observable<SocketIoClient[]> {
        return this.clientStream.asObservable();
    }

    public get clientConnected$(): Observable<SocketIoClient> {
        return this.clientConnectedStream.asObservable();
    }

    public get clientDisconnected$(): Observable<SocketIoClient> {
        return this.clientDisconnectedStream.asObservable();
    }

    public get currentClients(): ReadonlyArray<SocketIoClient> {
        return this.clients;
    }

    public get messages$(): Observable<SocketMessage> {
        return this.messageStream.asObservable();
    }


    public broadcast(msg: Message, clients: ReadonlyArray<SocketIoClient> = this.clients): void {
        for (const client of clients) {
            client.socket.emit(msg.channel, msg);
        }
    }


    private handleNewClient(socket: io.Socket): void {
        const client = new SocketIoClient();
        client.socket = socket;

        this.clients.push(client);
        this.clientConnectedStream.next(client);
        this.clientStream.next(this.clients);

        socket.use(([channel, content]: io.Event, next) => {
            const msg: SocketMessage = {
                origin: client,
                group: content.group || '',
                channel: channel,
                command: content.command,
                payload: content.payload
            };
            this.messageStream.next(msg);
            next();
        });

        socket.on('error', error => {
            this.logError(JSON.stringify(error));
        });

        socket.on('disconnect', () => {
            this.handleSocketDisconnect(socket);
        });
    }

    private handleSocketDisconnect(socket: io.Socket): void {
        const removedClients = _.remove(this.clients, client => client.socket === socket);
        this.clientStream.next(this.clients);

        for (const rc of removedClients) {
            this.clientDisconnectedStream.next(rc);
        }
    }
}
