import { SocketIOServer } from './../web/socket-io-server';
import * as _ from 'lodash';
import { UnityServerProxy } from './unity-server-proxy';
import { Service, DataStore } from '../core';
import { filter } from 'rxjs/operators';

export class MessageDistributor extends Service {
    public serviceName = 'MessageDistributor';
    public groupName = 'unity';


    public constructor(unityServer: UnityServerProxy, socketServer: SocketIOServer, store: DataStore) {
        super();

        unityServer.messages$
            .pipe(filter(msg => msg.channel === 'group'))
            .subscribe(msg => {
                try {
                    if (msg.command === 'set') {
                        this.logInfo(`Setting unity client ${msg.origin.id} group to '${msg.group}'`);
                        msg.origin.group = msg.group;
                        msg.origin.name = msg.payload.name;
                    }
                } catch (err) {
                    this.logError(`${err.message}\n${err.stack}`);
                }
            });

        socketServer.messages$
            .pipe(filter(msg => msg.channel === 'group'))
            .subscribe(msg => {
                try {
                    if (msg.command === 'set') {
                        this.logInfo(`Setting socketio client ${msg.origin.socket.id} group to '${msg.group}'`);
                        msg.origin.group = msg.group;
                    }
                } catch (err) {
                    this.logError(`${err.message}\n${err.stack}`);
                }
            });

        unityServer.messages$
            .pipe(filter(msg => msg.group.startsWith('GROUP')))
            .subscribe(msg => {
                try {

                    if (msg.command === 'modelUpdate') {
                        // save model
                        store.updateModel(msg.group, msg.channel, msg.payload);
                    } else if (msg.command === 'modelInitialState') {
                        // send model update via 'model' channel to msg.origin
                        if (msg.payload && msg.payload.Id) {
                            const model = store.getModel(msg.group, msg.channel, msg.payload.Id) || { Id: msg.payload.Id };
                            unityServer.broadcast({
                                channel: msg.channel,
                                group: msg.group,
                                command: 'modelUpdate',
                                payload: model
                            }, [msg.origin]);
                        } else {
                            for (const model of store.getAll(msg.group, msg.channel)) {
                                unityServer.broadcast({
                                    channel: msg.channel,
                                    group: msg.group,
                                    command: 'modelUpdate',
                                    payload: model
                                }, [msg.origin]);
                            }
                        }
                    } else if (msg.command === 'modelDelete') {
                        store.removeModel(msg.group, msg.channel, msg.payload.Id);
                    }

                    const unityClients = _(unityServer.currentClients)
                        .filter(c => msg.group === c.group)
                        .without(msg.origin)
                        .value();

                    if (unityClients.length > 0) {
                        unityServer.broadcast(msg, unityClients);
                    }

                    const socketClients = _(socketServer.currentClients)
                        .filter(c => msg.group === c.group)
                        .value();

                    if (socketClients.length > 0) {
                        socketServer.broadcast(msg, socketClients);
                    }
                } catch (err) {
                    this.logError(`${err.message}\n${err.stack}`);
                }
            });


        socketServer.messages$
            .pipe(filter(msg => msg.group.startsWith('GROUP')))
            .subscribe(msg => {
                try {

                    if (msg.command === 'modelUpdate') {
                        // save model
                        store.updateModel(msg.group, msg.channel, msg.payload);
                    } else if (msg.command === 'modelInitialState') {
                        // send model update via 'model' channel to msg.origin
                        if (msg.payload && msg.payload.Id) {
                            // TODO
                            // const model = store.getModel(msg.group, msg.channel, msg.payload.Id) || { Id: msg.payload.Id };
                            // unityServer.broadcast({
                            //     channel: msg.channel,
                            //     group: msg.group,
                            //     command: 'modelUpdate',
                            //     payload: model
                            // }, [msg.origin]);
                        } else {
                            // TODO
                            // for (const model of store.getAll(msg.group, msg.channel)) {
                            //     unityServer.broadcast({
                            //         channel: msg.channel,
                            //         group: msg.group,
                            //         command: 'modelUpdate',
                            //         payload: model
                            //     }, [msg.origin]);
                            // }
                        }
                    } else if (msg.command === 'modelDelete') {
                        store.removeModel(msg.group, msg.channel, msg.payload.Id);
                    }

                    const unityClients = _(unityServer.currentClients)
                        .filter(c => msg.group === c.group)
                        .value();

                    if (unityClients.length > 0) {
                        // copy message because we can't include origin
                        unityServer.broadcast({
                            channel: msg.channel,
                            command: msg.command,
                            group: msg.group,
                            payload: msg.payload
                        }, unityClients);
                    }

                    const socketClients = _(socketServer.currentClients)
                        .filter(c => msg.group === c.group)
                        .without(msg.origin)
                        .value();

                    if (socketClients.length > 0) {
                        socketServer.broadcast(msg, socketClients);
                    }
                } catch (err) {
                    this.logError(`${err.message}\n${err.stack}`);
                }
            });



        unityServer.clientsRemoved$
            .subscribe(removedClient => {
                let hasClients = false;
                for (const client of unityServer.currentClients) {
                    if (client.group === removedClient.group) {
                        hasClients = true;
                        break;
                    }
                }

                if (!hasClients) {
                    store.clearGroup(removedClient.group);
                    this.logDebug(`Cleared persistent data of ${removedClient.group}`);
                }
            });
    }
}
