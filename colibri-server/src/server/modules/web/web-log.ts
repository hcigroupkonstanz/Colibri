import { LogMessage, Metadata, Service } from '../core';
import { SocketIOServer } from '../networking/socket-io-server';
import { filter, merge } from 'rxjs';
import { v4 as uuid } from 'uuid';

const LOGGING_APP = 'colibri';
const MAX_LOG_SIZE = 1000000;
const LOOKUP_COUNT = 5; // how far back log messages are searched for identical messages

interface WebMessage {
    id: string;
    origin: string;
    level: number;
    message: string;
    group: string;
    created: number;
    count: number;
    metadata: Metadata;
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
            .pipe(filter(msg => msg.channel === 'colibri::log' && msg.command === 'requestLog'))
            .subscribe(networkMsg => {
                const socketClient = this.socketio.currentClients.find(c => c === networkMsg.origin);

                if (networkMsg.origin) {
                    networkMsg.origin.metadata['log::filter'] = JSON.parse(networkMsg.payload || '{}')?.filter || '';
                }

                if (socketClient) {
                    const filter = socketClient.metadata['log::filter'] || '';

                    // client can't handle too many messages at once
                    let counter = 0;
                    const clientLimit = 10000;

                    for (const msg of this.logMessages.filter(msg => !filter || msg.metadata.clientApp === filter)) {
                        this.socketio.broadcast({
                            channel: 'colibri::log',
                            command: 'message',
                            payload: JSON.stringify(msg)
                        }, [ socketClient ]);

                        if (++counter > clientLimit)
                            break;
                    }
                } else {
                    this.logError('Unkown origin requested log messages');
                }
            });

        merge(...Service.Current.map(s => s.output$)).subscribe(this.redirectLogMessage.bind(this));
    }

    private redirectLogMessage(log: LogMessage): void {
        // remove old messages
        while (this.logMessages.length > MAX_LOG_SIZE) {
            this.logMessages.shift();
        }
        
        // search last few messages for identical messages, group them together
        let webMsg: WebMessage | undefined = undefined;
        for (let i = this.logMessages.length - 1; i >= 0 && i > this.logMessages.length - LOOKUP_COUNT && !webMsg; i--) {
            const tmpMsg = this.logMessages[i];

            if (tmpMsg.message === log.message && tmpMsg.group === log.group && tmpMsg.level === log.level) {
                webMsg = this.logMessages[i];
                webMsg.count += 1;
                webMsg.created = log.created.getTime();
            }
        }

        // if no similar message was found, add a new one
        if (!webMsg) {
            webMsg = {
                id: uuid(),
                origin: log.origin,
                level: log.level,
                group: log.group,
                message: log.message,
                created: log.created.getTime(),
                count: 0,
                metadata: log.metadata
            };
            this.logMessages.push(webMsg);
        }

        const clients = this.socketio.currentClients
            .filter(c => c.app === LOGGING_APP)
            .filter(c => !c.metadata['log::filter'] || c.metadata['log::filter'] === log.metadata.clientApp);
        this.socketio.broadcast({
            channel: 'colibri::log',
            command: 'message',
            payload: JSON.stringify(webMsg)
        }, clients);
    }
}
