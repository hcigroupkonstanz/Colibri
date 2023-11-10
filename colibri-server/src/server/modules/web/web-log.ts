import { Service } from '../core';
import { SocketIOServer } from '../networking/socket-io-server';
import { filter, merge } from 'rxjs';
import * as _ from 'lodash';

const LOGGING_APP = 'colibri';

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

    public override async init(): Promise<void> {
        super.init();

        this.socketio.messages$
            .pipe(filter(msg => msg.origin !== undefined && msg.origin.app === LOGGING_APP && msg.command === 'requestLog'))
            .subscribe(networkMsg => {
                const socketClient = this.socketio.currentClients.find(c => c === networkMsg.origin);

                if (socketClient) {
                    for (const msg of this.logMessages) {
                        this.socketio.broadcast({
                            channel: 'log',
                            command: 'message',
                            payload: JSON.stringify(msg)
                        }, [ socketClient ]);
                    }
                } else {
                    this.logError('Unkown origin requested log messages');
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

            const clients = this.socketio.currentClients.filter(c => c.app === LOGGING_APP);
            this.socketio.broadcast({
                channel: 'log',
                command: 'message',
                payload: JSON.stringify(webMsg)
            }, clients);
        });
    }
}
