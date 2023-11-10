import { Injectable } from '@angular/core';
import { SocketIOService } from './socketio.service';
import { Subject } from 'rxjs';

export interface GroupedLogMessage {
    id: number;
    count: number;

    origin: string;
    level: number;
    message: string;
    group: string;
    created: number;
    createdDate: Date;
    metadata: { [key: string]: string | number | boolean };
}

@Injectable({
    providedIn: 'root'
})
export class LogService {
    public readonly messages: GroupedLogMessage[] = [];
    public readonly messages$ = new Subject<GroupedLogMessage>();

    constructor(socketio: SocketIOService) {
        let idCounter = 0;
        socketio
            .listen('log')
            .subscribe((m: GroupedLogMessage) => {
                while (this.messages.length > 1000) {
                    this.messages.shift();
                }

                let foundSimilarMsg = false;
                // search last few messages for identical messages, group them together
                for (let i = this.messages.length - 1; i >= 0 && i > this.messages.length - 5 && !foundSimilarMsg; i--) {
                    if (this.messages[i].message === m.message) {
                        foundSimilarMsg = true;
                        this.messages[i].count += 1;
                        this.messages[i].created = m.created;
                        this.messages[i].createdDate = new Date(m.created);
                    }
                }

                if (!foundSimilarMsg) {
                    m.id = idCounter;
                    m.count = 1;
                    m.createdDate = new Date(m.created);
                    this.messages.push(m);
                    this.messages$.next(m);
                    idCounter++;
                }
            });
    }
}
