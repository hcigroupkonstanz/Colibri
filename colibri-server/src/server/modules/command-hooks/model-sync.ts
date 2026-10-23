import { MAX_PAYLOAD_DEPTH, Payload, nestsDeeperThan } from '../core/payload.js';
import { Service } from '../core/service.js';
import type { ConnectionPool } from './connection-pool.js';
import type { NetworkMessage } from '../networking/network.js';
import type { DataStore, SyncModel } from './data-store.js';

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

    // Payload {} requests every model of the channel, { id } is a fresh request for one model.
    // { id, again: true } is a repeat request after a reconnect, for a model the sender held before.
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
                    // The model was deleted while the sender was disconnected, so the relayed delete never reached it.
                    // The tombstone stays for other clients that return.
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
                    // A fresh request means the sender has the object in its scene again, so the id is in use
                    // and its updates must no longer be ignored.
                    this.logDebug(
                        `Client '${msg.origin.name}' (${msg.origin.id}, app '${app}') has '${id}' on channel '${msg.channel}', ` +
                            'which was deleted a moment ago, in its scene again: updates to it are taken from now on'
                    );
                    this.store.forgetDeletion(app, msg.channel, id);
                }

                // No model for this id: the bare id tells the requester the server holds nothing.
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
            // Stored, it would be written out again for every model::request on the channel, and
            // JSON.stringify overflows the stack on deep nesting: each of those requests would fail.
            if (nestsDeeperThan(payload)) {
                this.logError(
                    `Ignoring a model::update for '${payload.id}' on channel '${msg.channel}' from client '${msg.origin.name}' ` +
                        `(${msg.origin.id}, app '${msg.origin.app}'): it nests deeper than ${MAX_PAYLOAD_DEPTH} levels`,
                    false
                );
                return;
            }

            // A late update, sent before its sender received the delete, would recreate the model (see DataStore.removeModel).
            // A client that recreates the object on purpose sends a fresh model::request first, which lifts the tombstone.
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
