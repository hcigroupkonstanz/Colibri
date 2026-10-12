import { Payload, Service } from '../core/index.js';
import { ConnectionPool, NetworkMessage } from './connection-pool.js';
import { DataStore, SyncModel } from './data-store.js';

export class ModelSynchronization extends Service {
    public serviceName = 'ModelSync';
    public groupName = 'colibri';

    public constructor(private connectionPool: ConnectionPool, private store: DataStore) {
        super();

        connectionPool.onCommand('model::request', this.sendInitialState.bind(this));
        connectionPool.onCommand('model::update', this.onModelUpdate.bind(this));
        connectionPool.onCommand('model::delete', this.onModelDelete.bind(this));


        // clear datastore when all clients from the same app disconnect
        connectionPool.clientDisconnected$.subscribe(client => {
            const hasClients = this.connectionPool.currentClients.some(c => c.app === client.app);
            if (!hasClients) {
                this.store.clearApp(client.app);
            }
        });
    }

    // A model::request comes in three forms:
    // - {} asks for every model of the channel.
    // - { id } is a fresh request: the sender has this object in its scene now, or is creating it
    //   (a SyncBehaviour placed in a scene that has just loaded, colibri-web's registerModel).
    // - { id, again: true } asks again, after a reconnect, for an object the sender held before
    //   the outage (colibri-unity's Sync.RequestModelsAgain, colibri-web's reconnect).
    // Any other field is ignored.
    public sendInitialState(msg: NetworkMessage): void {
        if (!msg.origin) {
            this.logError('Cannot send initial state to unknown client', false);
            return;
        }

        const app = msg.origin.app;
        try {
            const payload = (msg.payload?.asValue<{ id?: string; again?: unknown }>()) || {};

            if (typeof(payload?.id) === 'string') {
                const id = payload.id;
                const model = this.store.getModel(app, msg.channel, id);
                const deletion = model ? undefined : this.store.deletion(app, msg.channel, id);

                if (deletion && payload.again === true) {
                    // The sender held a copy before its outage, and another client deleted the
                    // model meanwhile: the relayed delete never reached it, so it is told now, or it
                    // keeps a copy nobody else has. The tombstone stays, for whoever else returns.
                    this.logDebug(
                        `Answering client '${msg.origin.name}' (${msg.origin.id}, app '${app}') with model::delete for '${id}' ` +
                            `on channel '${msg.channel}': it asked again after a reconnect, and that model was deleted meanwhile`
                    );
                    this.connectionPool.emit({
                        channel: msg.channel,
                        command: 'model::delete',
                        payload: Payload.fromValue({ id })
                    }, msg.origin);
                    return;
                }

                if (deletion) {
                    // A fresh request: the sender has the object in its scene now, e.g. a scene with
                    // placed objects of fixed ids loaded again, by the client that unloaded it or by
                    // any other. The id is in use again, so its updates are no longer ignored.
                    this.logDebug(
                        `Client '${msg.origin.name}' (${msg.origin.id}, app '${app}') has '${id}' on channel '${msg.channel}', ` +
                            'which was deleted a moment ago, in its scene again: updates to it are taken from now on'
                    );
                    this.store.forgetDeletion(app, msg.channel, id);
                }

                // An id the server has no model for is answered with the bare id: the requester's
                // copy is all there is, and the full state it sends then creates the model here.
                this.connectionPool.emit({
                    channel: msg.channel,
                    command: 'model::update',
                    payload: Payload.fromValue(model || { id })
                }, msg.origin);
            } else {
                for (const model of this.store.getAll(app, msg.channel)) {
                    this.connectionPool.emit({
                        channel: msg.channel,
                        command: 'model::update',
                        payload: Payload.fromValue(model)
                    }, msg.origin);
                }
            }
        } catch (error) {
            this.logError(`Failed to send initial state to client ${msg.origin.id}: ${error}`, false);
        }
    }

    public onModelUpdate(msg: NetworkMessage): void {
        if (!msg.origin) {
            this.logError('Cannot send initial state to unknown client', false);
            return;
        }

        try {
            const payload = (msg.payload?.asValue<{ id?: string }>()) || {};
            if (typeof(payload?.id) !== 'string') {
                this.logError('Cannot update model without "id" attribute', false);
                return;
            }

            // An update to a model deleted a moment ago would create it afresh, here and in every
            // other client (see DataStore.removeModel): one another client sent before the delete
            // reached it, say. A client that creates the object again on purpose, the one that
            // deleted it included, sends a fresh model::request { id } first, and that lifts the
            // tombstone (see sendInitialState).
            if (this.store.deletion(msg.origin.app, msg.channel, payload.id)) {
                this.logDebug(
                    `Ignoring a model::update for '${payload.id}' on channel '${msg.channel}' from client '${msg.origin.name}' ` +
                        `(${msg.origin.id}, app '${msg.origin.app}'): that model was deleted (MODEL_TOMBSTONE_SECONDS)`
                );
                return;
            }

            this.store.updateModel(msg.origin.app, msg.channel, payload as SyncModel);
            this.connectionPool.broadcast(msg);
        } catch (error) {
            this.logError(`Failed to update model: ${error}`, false);
        }
    }

    public onModelDelete(msg: NetworkMessage): void {
        if (!msg.origin) {
            this.logError('Cannot send initial state to unknown client', false);
            return;
        }

        try {
            const payload = msg.payload?.asValue<{ id?: string }>();

            if (payload?.id) {
                this.store.removeModel(msg.origin.app, msg.channel, payload.id);
                this.connectionPool.broadcast(msg);
            } else {
                this.logWarning('Received delete message without payload');
            }
        } catch (error) {
            this.logError(`Failed to delete model: ${error}`, false);
        }
    }
}
