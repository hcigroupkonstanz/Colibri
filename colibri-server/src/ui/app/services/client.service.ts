import { Injectable } from '@angular/core';
import { SocketIOService } from './socketio.service';
import { BehaviorSubject } from 'rxjs';

export interface ColibriClient {
    id: string;
    app: string;
    name: string;
    version: string;
    ip: string;
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
            .subscribe((m: { id: string, latency: [number, number][] }[]) => {
                this.clients$.next(m.map(c => ({
                    ...c,
                    name: 'TODO',
                    app: 'TODO',
                    version: 'TODO',
                    ip: 'TODO'
                })));
            });

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
