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
    private triggerAngularChanges: Function;

    constructor(private zone: NgZone) {
        this.socket = io.connect();
        this.triggerAngularChanges = _.throttle(() => this.zone.run(() => {}), 100);
        this.socket.emit('group', {
            command: 'set',
            group: 'log',
            payload: { empty: 'TODO: should be empty' }
        });

        this.socket.emit('log', {
            command: 'request',
            group: 'log',
            payload: { empty: 'TODO: remains empty' }
        });
    }


    public listen(channel: string): Observable<any> {
        if (!this.listeners[channel]) {
            const msgStream = new Subject<any>();
            this.listeners[channel] = msgStream;

            this.socket.on(channel, (msg: any) => {
                msgStream.next(msg.payload);
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
