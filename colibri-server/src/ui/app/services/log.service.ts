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
    public messages: ReadonlyArray<LogMessage> = [];
    public readonly messages$ = new Subject<LogMessage>();
    public readonly filter$ = new BehaviorSubject<string>('');

    // for quick lookup of messages by id
    private messageIds: { [id: string]: LogMessage } = {};

    constructor(socketio: SocketIOService) {
        socketio
            .listen('colibri::log')
            .subscribe((m: LogMessage) => {
                while (this.messages.length > 10000) {
                    delete this.messageIds[this.messages[0].id];
                    this.messages = this.messages.slice(1);
                }

                if (this.messageIds[m.id]) {
                    // update existing message
                    const existing = this.messageIds[m.id];
                    existing.count = m.count;
                    existing.created = m.created;

                    // put it to the end of the list
                    const index = this.messages.indexOf(existing);
                    this.messages = [ ...this.messages.slice(0, index), ...this.messages.slice(index + 1), existing];

                    this.messages$.next(existing);
                } else {
                    // create new entry
                    this.messages = [ ...this.messages, m ];
                    this.messages$.next(m);
                    this.messageIds[m.id] = m;
                }
            });


        // retrieve current filter from URL hash
        this.filter$.next(location.hash.substring(1));

        this.filter$.subscribe(filter => {
            socketio.emit('colibri::log', 'requestLog', { filter });
            location.hash = filter || '';

            // reload messages
            this.messages = [];
            this.messageIds = {};
        });
    }
}
