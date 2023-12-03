import { Injectable } from '@angular/core';
import { SocketIOService } from './socketio.service';
import { BehaviorSubject, Subject } from 'rxjs';

export interface LogMessage {
    id: string;
    origin: string;
    level: number;
    message: string;
    group: string;
    created: number;
    count: number;
    metadata: Record<string, unknown>;
}

@Injectable({
    providedIn: 'root'
})
export class LogService {
    public readonly messages: LogMessage[] = [];
    public readonly messages$ = new Subject<LogMessage>();
    public readonly filter$ = new BehaviorSubject<string>('');

    // for quick lookup of messages by id
    private messageIds: { [id: string]: LogMessage } = {};

    constructor(socketio: SocketIOService) {
        socketio
            .listen('colibri::log')
            .subscribe((m: LogMessage) => {
                while (this.messages.length > 10000) {
                    const rm = this.messages.shift();
                    if (rm)
                        delete this.messageIds[rm.id];
                }

                if (this.messageIds[m.id]) {
                    // update existing message
                    const existing = this.messageIds[m.id];
                    existing.count = m.count;
                    existing.created = m.created;
                    // put it to the end of the list
                    this.messages.splice(this.messages.indexOf(existing), 1);
                    this.messages.push(existing);
                    this.messages$.next(existing);
                } else {
                    // create new entry
                    this.messages.push(m);
                    this.messages$.next(m);
                    this.messageIds[m.id] = m;
                }
            });


        // retrieve current filter from URL hash
        this.filter$.next(location.hash.substring(1));

        this.filter$.subscribe(filter => {
            console.log('requesting log messages for filter', filter);
            socketio.emit('colibri::log', 'requestLog', { filter });
            location.hash = filter;

            // reload messages
            while (this.messages.length > 0)
                this.messages.shift();
            this.messageIds = {};
        });
    }
}
