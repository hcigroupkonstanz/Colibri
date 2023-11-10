/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable, NgZone } from '@angular/core';
import { Subject, Observable } from 'rxjs';
import * as _ from 'lodash';
import * as io from 'socket.io-client';

@Injectable({
    providedIn: 'root'
})
export class SocketIOService {
    private socket: io.Socket<any, any>;
    private listeners: { [name: string]: Subject<any> } = {};
    private triggerAngularChanges: () => void;

    constructor(private zone: NgZone) {
        this.socket = io.connect('', { query: { app: 'colibri', version: '1' } });
        // eslint-disable-next-line no-empty-function
        this.triggerAngularChanges = _.throttle(() => this.zone.run(() => {}), 100);

        this.socket.emit('log', {
            command: 'requestLog'
        });
    }


    public listen(channel: string): Observable<any> {
        if (!this.listeners[channel]) {
            const msgStream = new Subject<any>();
            this.listeners[channel] = msgStream;

            this.socket.on(channel, (msg: any) => {
                msgStream.next(JSON.parse(msg.payload));
                this.triggerAngularChanges();
            });
        }

        return this.listeners[channel].asObservable();
    }


    public execute(input: string): void {
        this.socket.send('command', input);
    }

    public evaluate(input: string): void {
        this.socket.send('evaluate', input);
    }
}
