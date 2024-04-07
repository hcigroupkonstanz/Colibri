import { Injectable } from '@angular/core';
import { SocketIOService } from './socketio.service';
import { BehaviorSubject } from 'rxjs';

export interface ColibriClient {
    id: string;
    app: string;
    name: string;
    version: string;
    latency: [number, number][]
}

@Injectable({
    providedIn: 'root'
})
export class ClientService {
    public clients: ReadonlyArray<ColibriClient> = [];
    public readonly clients$ = new BehaviorSubject<ReadonlyArray<ColibriClient>>(this.clients);

    constructor(socketio: SocketIOService) {
        socketio
            .listen('colibri::latency')
            .subscribe(msg => {
                for (const clientId in msg.payload) {
                    const client = this.clients.find(c => c.id === clientId);

                    if (client) {
                        client.latency = [
                            ...client.latency,
                            ...msg.payload[clientId]
                        ].slice(-1000);
                    }
                }

                this.clients$.next(this.clients);
            });

        socketio
            .listen('colibri::clients')
            .subscribe(msg => {
                if (msg.command === 'client::connected') {
                    const client = {
                        ...msg.payload,
                        latency: []
                    };
                    this.clients = [...this.clients, client];
                    this.clients$.next(this.clients);
                } else if (msg.command === 'client::disconnected') {
                    this.clients = this.clients.filter(c => c.id !== msg.payload.id);
                    this.clients$.next(this.clients);
                } else {
                    console.error('unknown client command', msg);
                }
            });

        // retrieve initial clients
        socketio.emit('colibri::clients', 'client::request', {});
    }

}
