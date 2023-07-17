import { Service } from '../core';
import { SocketIOServer } from './socket-io-server';
import { filter, merge } from 'rxjs';
import * as _ from 'lodash';

const LOGGING_GROUP = 'log';

interface WebMessage {
    origin: string;
    level: number;
    message: string;
    group: string;
    created: number;
}

export class WebLog extends Service {
    public serviceName = 'WebLog';
    public groupName = 'web';

    private logMessages: WebMessage[] = [];

    public constructor(private socketio: SocketIOServer) {
        super();
    }

    public init(): void {
        super.init();

        this.socketio.messages$
            .pipe(filter(msg => msg.group === LOGGING_GROUP && msg.command === 'request'))
            .subscribe(c => {
                for (const msg of this.logMessages) {
                    this.socketio.broadcast({
                        channel: 'log',
                        command: 'message',
                        payload: msg,
                        group: LOGGING_GROUP
                    }, [c.origin]);
                }
            });

        const outputs = _.map(Service.Current, s => s.output$);
        merge(...outputs).subscribe(log => {
            while (this.logMessages.length > 1000) {
                this.logMessages.shift();
            }

            const webMsg: WebMessage = {
                origin: log.origin,
                level: log.level,
                group: log.group,
                message: log.message,
                created: log.created.getTime()
            };
            this.logMessages.push(webMsg);

            const clients = this.socketio.currentClients.filter(c => c.group === LOGGING_GROUP);
            this.socketio.broadcast({
                channel: 'log',
                command: 'message',
                payload: webMsg,
                group: 'log'
            }, clients);
        });
    }
}
