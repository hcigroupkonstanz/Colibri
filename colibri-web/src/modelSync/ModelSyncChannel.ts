import { BehaviorSubject } from 'rxjs';
import type { Message } from '../Colibri';
import { Colibri, RegisterChannel, SendMessage } from '../Colibri';
import { lastHeardFrom, onColibriDisconnected, onColibriReconnected } from '../lifecycle';
import type { SyncModel } from '../SyncModel';
import { askForEnd, END_CHANNEL } from './askForEnd';
import { AwaitedAnswers } from './AwaitedAnswers';
import { ChangesByModel } from './ChangesByModel';
import { guardChannel, joinChannel, ownedElsewhere } from './channelRegistry';
import { Confirmations } from './Confirmations';
import { DeletedHere } from './DeletedHere';
import { GuardWindow } from './GuardWindow';
import { KnownValues } from './KnownValues';
import { isBare, withoutChanges, withoutKeys } from './modelUpdate';
import { OwnModelAnswers } from './OwnModelAnswers';
import { ReconnectRound } from './ReconnectRound';
import { detachOf, toJsonOf, updateOf } from './syncModelMethods';
import { withColibri } from './withColibri';

interface ModelSyncMsg<T extends SyncModel<T>> extends Message {
    command: 'model::update' | 'model::delete';
    payload: Partial<T> & { id: string };
}

export class ModelSyncChannel<T extends SyncModel<T>> {
    private readonly models = new BehaviorSubject<T[]>([]);
    public readonly models$ = this.models.asObservable();

    private readonly deletedHere = new DeletedHere(() => Date.now());

    // Models passed to registerModel, as opposed to ones created from remote updates. Only these are
    // asked for by id and sent in full.
    private readonly ownModels = new WeakSet<T>();

    private readonly awaitedAnswers = new AwaitedAnswers<T>();

    // Property names of changes to own models that are held back instead of sent: made while
    // disconnected or before the server's answer for the model (see registerModel).
    private readonly heldChanges = new ChangesByModel<T>();

    // Changes waiting for SyncModel's 1 ms buffer to report them, so they go out together. A remote
    // update does not overwrite them (see applyUpdate).
    private readonly changesToSend = new ChangesByModel<T>();

    private readonly confirmations = new Confirmations();

    private readonly knownValues = new KnownValues<T>(() => Date.now());

    private readonly reconnectRound = new ReconnectRound();

    private readonly guardWindow = new GuardWindow<T>();

    private readonly ownModelAnswers = new OwnModelAnswers<T>({
        heldChanges: this.heldChanges,
        awaitedAnswers: this.awaitedAnswers,
        reconnectRound: this.reconnectRound,
        confirmations: this.confirmations,
        knownValues: this.knownValues,
        guardWindow: this.guardWindow,
        listedModel: id => this.models.value.find(m => m.id === id),
        isListed: model => this.models.value.includes(model),
        isOwn: model => this.ownModels.has(model),
        applyUpdate: (model, modelData) => {
            this.applyUpdate(model, modelData);
        },
        sendUpdate: (colibri, model, update) => {
            this.sendUpdate(colibri, model, update);
        },
        askFor: (colibri, model) => {
            this.askFor(colibri, model);
        },
        catchUpOnceAnswered: () => this.catchUpOnceAnswered(),
        guardFrom: colibri => {
            this.guardFrom(colibri);
        },
        askForEnd: colibri => askForEnd(colibri)
    });

    private disconnected = false;

    private readonly hasOwn = (id: string) => this.models.value.some(m => m.id === id && this.ownModels.has(m));
    private readonly guard = (end: string) => {
        this.guardWindow.add(end);
    };

    public constructor(
        private readonly name: string,
        private readonly create: (id: string) => T
    ) {
        joinChannel(this.name, this.hasOwn, this.guard);

        // initial data fetch
        // Repeated after every reconnect, since remote updates relayed meanwhile are lost. Applied to the
        // model with the same id, so nothing is duplicated.
        //
        // The server forgets an app's models when its last client leaves and on restart, so own models are
        // asked for by id first (see askFor), and everything else once all are answered. Also on the first
        // fetch: the answer for every model carries an own model's id too and would be taken for its answer.
        withColibri(colibri => {
            this.attach(colibri);
        });

        // Register for updates
        RegisterChannel(this.name, (payload: Message) => {
            this.onMessage(payload);
        });

        RegisterChannel(END_CHANNEL, (message: Message) => {
            this.onEndMarker(message);
        });
    }

    private onMessage(payload: Message): void {
        if (payload.command === 'model::update') {
            this.onUpdate((payload as ModelSyncMsg<T>).payload);
        } else if (payload.command === 'model::delete') {
            this.onDelete((payload as ModelSyncMsg<T>).payload.id);
        } else {
            console.error(`Unknown model command: ${payload.command}`);
        }
    }

    // Answers to askForEnd requests (see roundEnd, guardEnds, endWait). Every registration receives
    // each one sent on this connection and acts only on the ids it waits for.
    private onEndMarker(message: Message): void {
        if (message.command !== 'model::update') return;
        const id = (message.payload as { id?: unknown } | undefined)?.id;
        if (typeof id !== 'string') return;
        if (this.reconnectRound.isEnd(id)) this.ownModelAnswers.endRound();
        if (this.guardWindow.includes(id)) this.guardWindow.endGuard(id);
        const confirmed = this.confirmations.idEndedBy(id);
        if (confirmed !== undefined) this.ownModelAnswers.endWait(confirmed);
    }

    // Asks the server for an own model by id; the answer arrives through onUpdate or onDelete.
    // `again: true`, for a model already answered for, makes the server reply model::delete if another
    // client deleted it meanwhile, as a relayed delete may not have reached this client. Without it, the
    // server lifts that delete and answers a bare id. After MODEL_TOMBSTONE_SECONDS the server has
    // forgotten the delete, and this client sends the model again.
    private askFor(colibri: Colibri, model: T): void {
        this.awaitedAnswers.ask(model.id, colibri);
        colibri.sendMessage(
            this.name,
            'model::request',
            this.awaitedAnswers.wasAnswered(model) ? { id: model.id, again: true } : { id: model.id }
        );
    }

    // For an id deleted here a moment ago and registered again: the request lifts the server's delete,
    // and the full model follows at once since the server has nothing for the id. Until the bare-id
    // answer, updates for the id are dropped (see onUpdate): a remote update sent before the server
    // had the delete would be taken for the answer.
    private sendAfresh(colibri: Colibri, model: T): void {
        colibri.sendMessage(this.name, 'model::request', { id: model.id });
        this.deletedHere.markAfresh(model.id);
        this.awaitedAnswers.markAnswered(model);
        this.heldChanges.take(model);
        this.sendUpdate(colibri, model, toJsonOf(model));
    }

    // Requests every model once all own models have their answer, so that answer includes what was
    // sent in between (see guardFrom for what is sent after). Returns whether it asked.
    private catchUpOnceAnswered(): boolean {
        const colibri = this.awaitedAnswers.takeCatchUp();
        if (!colibri) return false;
        colibri.sendMessage(this.name, 'model::request');
        this.guardFrom(colibri);
        return true;
    }

    // Keeps the fields this client sends out of updates until the answer to a request sent now. An
    // earlier request is answered with what the server had when it read it, which may predate these
    // fields; applied, that undoes them on this client only, as the server does not relay an update
    // back to its sender. Every registration on the channel receives the answer, so all of them guard.
    private guardFrom(colibri: Colibri): void {
        const end = askForEnd(colibri);
        guardChannel(this.name, end);
    }

    private attach(colibri: Colibri): void {
        this.awaitedAnswers.catchUpThrough(colibri);
        // Deferred so that models registered in the same block of code, or before `new Colibri()`, are asked for first.
        setTimeout(() => this.catchUpOnceAnswered(), 0);
        onColibriDisconnected(colibri, () => {
            this.onDisconnected(colibri);
        });
        onColibriReconnected(colibri, () => {
            this.onReconnected(colibri);
        });
    }

    private onDisconnected(colibri: Colibri): void {
        this.disconnected = true;
        // Answers to the requests on this connection will not come. Ended here, not on reconnect:
        // by then another registration on the channel may have sent the next one (see guardFrom).
        this.guardWindow.endGuard();
        // Not updated while the last reconnect's answers are pending: changes lost in the earlier
        // outage are still in question, so they are judged from then.
        if (this.reconnectRound.isEmpty()) this.reconnectRound.setLastHeard(lastHeardFrom(colibri) ?? Date.now());
        // A delete sent after the last message from the server may have gone into a connection that was
        // already dead (Socket.IO loses what it sends until its ping timeout). Sent again, as colibri-unity
        // does; Socket.IO holds it until the reconnect. A delete that did arrive arrives twice, harmlessly.
        const since = (lastHeardFrom(colibri) ?? Date.now()) - 1000;
        for (const id of this.deletedHere.idsSince(since)) colibri.sendMessage(this.name, 'model::delete', { id });
    }

    private onReconnected(colibri: Colibri): void {
        this.disconnected = false;
        // Requests from the previous connection will not be answered. Changes sent for models still
        // being confirmed may not have arrived, so they are held again and go out with the answer.
        this.awaitedAnswers.clear();
        this.reconnectRound.clear();
        this.deletedHere.clearAfresh();
        this.holdUnconfirmed();
        this.awaitedAnswers.catchUpThrough(colibri);
        this.askAgainForOwnModels(colibri);
        this.reconnectRound.start(() => askForEnd(colibri));
        this.catchUpOnceAnswered();
    }

    private holdUnconfirmed(): void {
        for (const id of this.confirmations.ids()) {
            const confirmation = this.confirmations.end(id);
            const model = this.models.value.find(m => m.id === id);
            if (confirmation && model && this.ownModels.has(model)) this.heldChanges.add(model, confirmation.props);
        }
    }

    private askAgainForOwnModels(colibri: Colibri): void {
        for (const model of this.models.value) {
            if (!this.ownModels.has(model)) continue;
            if (this.awaitedAnswers.wasAnswered(model)) this.reconnectRound.add(model.id);
            this.askFor(colibri, model);
        }
    }

    // Handle updates
    private onUpdate(modelData: Partial<T>): void {
        const model = this.models.value.find(m => m.id === modelData.id);
        const id = modelData.id;
        if (id === undefined) {
            this.applyUpdate(model, modelData);
            return;
        }
        if (this.deletedHere.dropsAfreshUpdate(id, isBare(modelData))) return;
        if (this.awaitedAnswers.takeDeleted(id) && !model && isBare(modelData)) return;
        const asker = this.awaitedAnswers.askerOf(id);
        if (asker) {
            this.ownModelAnswers.takeAnswer(id, asker, model, modelData);
            return;
        }

        // The answer to another registration on this channel that has an own model with this id. Not
        // listed: the full state it sends in reply is not relayed to this client, so the model would stay empty.
        if (!model && isBare(modelData) && ownedElsewhere(this.name, this.hasOwn, id)) return;
        this.applyUpdate(model, modelData);
    }

    // Sends an update for an own model and records it for lostChanges and guardFrom.
    private sendUpdate(colibri: Colibri, model: T, update: Partial<T>): void {
        colibri.sendMessage(this.name, 'model::update', update);
        this.knownValues.remember(model, update, lastHeardFrom(colibri) ?? Number.POSITIVE_INFINITY);
        this.guardWindow.keepOut(model, update);
    }

    // Fields with a change SyncModel has not reported yet keep their value: the update predates the
    // change, and applying it would make the report send the update's value instead.
    private applyUpdate(model: T | undefined, modelData: Partial<T>): void {
        if (model) this.applyToListed(model, modelData);
        else if (modelData.id) this.addRemoteModel(modelData.id, modelData);
    }

    private applyToListed(model: T, modelData: Partial<T>): void {
        const unsent = this.changesToSend.peek(model);
        const update = withoutKeys(withoutChanges(modelData, model, unsent), this.guardWindow.keptOutOf(model));
        if (this.ownModels.has(model)) this.knownValues.remember(model, update);

        // Update existing model
        updateOf(model, update);
        this.models.next([...this.models.value]);
    }

    private addRemoteModel(id: string, modelData: Partial<T>): void {
        if (this.deletedHere.recently(id)) return;
        const newModel = this.create(id);
        this.wireRemoteModel(newModel);

        updateOf(newModel, modelData);
        this.models.next([...this.models.value, newModel]);
    }

    private wireRemoteModel(newModel: T): void {
        newModel.deletions.subscribe(() => {
            this.deleteHere(newModel);
        });

        newModel.modelChanges.subscribe(change => {
            this.changesToSend.add(newModel, [change]);
        });
        newModel.modelChanges$.subscribe(changes => {
            this.changesToSend.drop(newModel);
            const update = toJsonOf(newModel, changes);
            SendMessage(this.name, 'model::update', update);
            this.guardWindow.keepOut(newModel, update);
            this.models.next([...this.models.value]);
        });
    }

    private onDelete(id: string): void {
        const model = this.models.value.find(m => m.id === id);
        detachOf(model);
        this.forget(id, model);
    }

    // Deletes a model here as for a remote delete, then on the server. Ignored unless it is the
    // instance listed for its id: a model replaced by registerModel no longer stands for it.
    private deleteHere(model: T): void {
        if (this.models.value.find(m => m.id === model.id) !== model) return;
        this.deletedHere.remember(model.id);
        this.forget(model.id, model);
        withColibri(colibri => {
            colibri.sendMessage(this.name, 'model::delete', { id: model.id });
        });
    }

    // Takes a deleted model out of the list and out of everything that waits for it.
    private forget(id: string, model: T | undefined): void {
        if (model) this.heldChanges.drop(model);
        this.reconnectRound.delete(id);
        this.models.next(this.models.value.filter(m => m.id !== id));

        // model::delete can answer a request for an own model (another client deleted it during an
        // outage). That settles the model like an update, so catching up must not keep waiting for it.
        this.confirmations.end(id);
        const answerMayFollow = this.guardWindow.takeAnswerMayFollow(id);
        if (this.awaitedAnswers.settle(id)) {
            this.awaitedAnswers.markDeleted(id);
            this.catchUpOnceAnswered();
        } else if (answerMayFollow) {
            // Settled by an update that need not have been the answer, which may still come.
            this.awaitedAnswers.markDeleted(id);
        }
    }

    // The server may already have a model with this id (created by another client, or by this one before
    // a reload). So the model is asked for by id first, as Unity's SyncBehaviour does (see askFor): what
    // the server has wins, and the full model is sent only if it has nothing.
    //
    // If the id is already listed, from a remote update or an earlier instance, the new instance replaces
    // it in place and the listed one is detached. Registering the listed instance does nothing.
    public registerModel(model: T): void {
        const listed = this.models.value.find(m => m.id === model.id);
        if (listed === model) return;
        this.warnIfReplacing(model, listed);

        this.wireOwnModel(model);
        const reused = this.deletedHere.recently(model.id);
        this.deletedHere.forget(model.id);
        this.ownModels.add(model);
        this.listOwnModel(model, listed);
        this.askOnceConnected(model, reused);
    }

    private warnIfReplacing(model: T, listed: T | undefined): void {
        if (listed && this.ownModels.has(listed)) {
            console.warn(
                `Colibri: registerModel was given a second model with the id '${model.id}' on channel ` +
                    `'${this.name}'. It replaces the first one, which no longer syncs.`
            );
        }
    }

    private wireOwnModel(model: T): void {
        // Hold-back is decided when the change is made, not when SyncModel reports it 1 ms later: an answer
        // arriving in between would be applied over it.
        model.modelChanges.subscribe(change => {
            if (this.mustHold(model)) this.heldChanges.add(model, [change]);
            else this.changesToSend.add(model, [change]);
        });
        model.modelChanges$.subscribe({
            next: () => {
                const changes = this.changesToSend.take(model);
                if (changes.length > 0) {
                    const colibri = Colibri.getInstance(false);
                    if (!colibri || this.mustHold(model)) this.heldChanges.add(model, changes);
                    else this.sendUpdate(colibri, model, toJsonOf(model, changes));
                }

                // Emit for own models too, held back or sent: the model has changed here, and a page rendering the
                // list has to show it.
                if (this.models.value.includes(model)) this.models.next([...this.models.value]);
            },
            // delete() and detach() end the stream: nothing more is sent for the model, neither held changes
            // nor the whole model after a reconnect.
            complete: () => {
                this.ownModels.delete(model);
                this.heldChanges.drop(model);
                this.changesToSend.drop(model);
            }
        });

        model.deletions.subscribe(() => {
            this.deleteHere(model);
        });
    }

    // Held until the server has answered for the model, then sent on top of what it has: changes made
    // before `new Colibri()`, or after a reconnect but before the answer, would otherwise be undone by it.
    // Also changes made while disconnected: Socket.IO sends them on reconnect ahead of the model's
    // request, and to a server that forgot the model they would become all of it.
    private mustHold(model: T): boolean {
        return !Colibri.getInstance(false) || this.disconnected || this.awaitedAnswers.isAwaited(model.id);
    }

    private listOwnModel(model: T, listed: T | undefined): void {
        if (listed) {
            this.confirmations.end(model.id);
            this.reconnectRound.delete(model.id);
            detachOf(listed);
            this.models.next(this.models.value.map(m => (m === listed ? model : m)));
        } else {
            this.models.next([...this.models.value, model]);
        }
    }

    private askOnceConnected(model: T, reused: boolean): void {
        // While disconnected, the reconnect asks for it.
        withColibri(colibri => {
            if (this.disconnected || !this.ownModels.has(model)) return;
            if (reused) this.sendAfresh(colibri, model);
            else this.askFor(colibri, model);
        });
    }
}
