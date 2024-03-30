import { Injectable } from '@angular/core';
import { SocketIOService } from './socketio.service';
import { BehaviorSubject } from 'rxjs';

export interface ColibriClient {
    id: string;
    app: string;
    name: string;
    version: string;
    ip: string;
    latency: number[]
}

@Injectable({
    providedIn: 'root'
})
export class ClientService {
    public clients: ReadonlyArray<ColibriClient> = [
        {
            id: '1',
            app: 'colibri',
            name: 'client1',
            version: '1',
            ip: '::1',
            latency: [
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
            ]
        },
        {
            id: '2',
            app: 'myApp',
            name: 'client2',
            version: '1',
            ip: '::1',
            latency: [
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
                Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 100 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 1000 + 10, Math.random() * 100 + 10,
            ]
        }
    ];
    public readonly clients$ = new BehaviorSubject<ReadonlyArray<ColibriClient>>(this.clients);

    constructor(socketio: SocketIOService) {
        socketio
            .listen('colibri::clients')
            .subscribe((m: Partial<ColibriClient> | { id: string }) => {
                const existingClient = this.clients.find(c => c.id === m.id);

                if (existingClient) {
                    // update existing client
                } else {
                    this.clients = [...this.clients, m as ColibriClient];
                    this.clients$.next(this.clients);
                }
            });


        // retrieve initial clients
        socketio.emit('colibri::clients', 'requestClients', {});
    }

}
