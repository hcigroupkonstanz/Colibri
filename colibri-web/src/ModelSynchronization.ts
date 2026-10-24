import type { Observable } from 'rxjs';
import { BehaviorSubject } from 'rxjs';
import type { Message } from './Colibri';
import { Colibri, RegisterChannel, SendMessage } from './Colibri';
import { lastHeardFrom, onColibriDisconnected, onColibriReconnected } from './lifecycle';
import { askForEnd, END_CHANNEL } from './modelSync/askForEnd';
import { ChangesByModel } from './modelSync/ChangesByModel';
import { guardChannel, joinChannel, ownedElsewhere } from './modelSync/channelRegistry';
import { DeletedHere } from './modelSync/DeletedHere';
import { fieldsOnTop, isBare, withoutChanges, withoutKeys } from './modelSync/modelUpdate';
import { detachOf, toJsonOf, updateOf } from './modelSync/syncModelMethods';
import { warnIfMinified } from './modelSync/warnIfMinified';
import { withColibri } from './modelSync/withColibri';
import type { SyncModel } from './SyncModel';

interface ModelSyncMsg<T extends SyncModel<T>> extends Message {
    command: 'model::update' | 'model::delete';
    payload: Partial<T> & { id: string };
}

interface ModelSyncRegistration<T> {
    /** The channel to sync on. Recommended: the default, the lowercased class name, changes when minified. */
    name?: string;
    type: { new (id: string): T };
}

type ModelSync<T> = [Observable<T[]>, (model: T) => void];

// History kept per field to spot changes lost in a dead connection (see keepKnown, lostChanges).
// An earlier value counts only if it was still current within KNOWN_VALUES_MS before the outage:
// a change sent before that has arrived for certain.
const KNOWN_VALUES_KEPT = 8;
const KNOWN_VALUES_MS = 10_000;

export const RegisterModelSync = <T extends SyncModel<T>>(registration: ModelSyncRegistration<T>): ModelSync<T> => {
    const name = registration.name || registration.type.name.toLowerCase();
    if (!registration.name) warnIfMinified(registration.type.name, name);

    const models = new BehaviorSubject<T[]>([]);

    const deletedHere = new DeletedHere(() => Date.now());

    // Models passed to registerModel, as opposed to ones created from remote updates. Only these are
    // asked for by id and sent in full.
    const ownModels = new WeakSet<T>();

    // Own models asked for by id (registerModel, reconnect) and not answered yet, with the instance that asked.
    const awaitingAnswer = new Map<string, Colibri>();

    // Own models the server has answered for, on this or an earlier connection (see askFor).
    const answered = new WeakSet<T>();

    // Instance to send the request for every model through, until it is sent (see catchUpOnceAnswered).
    let catchingUpThrough: Colibri | undefined;

    // Ids deleted while their answer was, or may still have been, on its way (see forget). A bare-id
    // answer, e.g. from a server with MODEL_TOMBSTONE_SECONDS=0, must not become a model.
    const deletedWhileAwaited = new Set<string>();

    // Property names of changes to own models that are held back instead of sent: made while
    // disconnected or before the server's answer for the model (see registerModel).
    const heldChanges = new ChangesByModel<T>();

    // Changes waiting for SyncModel's 1 ms buffer to report them, so they go out together. A remote
    // update does not overwrite them (see applyUpdate).
    const changesToSend = new ChangesByModel<T>();

    // Own models asked for again after sending their held changes (see sendOnTop), until the answers
    // to that are over (see endWait).
    interface Confirmation {
        sent: Map<string, string>; // JSON of the fields sent that differ from what the server showed
        replaced: Map<string, string | undefined>; // the server's JSON for those fields, if it had one
        props: string[]; // property names of the held changes
        shown: Map<string, unknown>; // latest value an update has shown for each sent field
        end: string; // askForEnd id
    }
    const confirming = new Map<string, Confirmation>();

    const endConfirmation = (id: string) => {
        const confirmation = confirming.get(id);
        confirming.delete(id);
        return confirmation;
    };

    // Per own model and field name (as sent), the values the field had, oldest first: the last one the
    // server showed (see applyUpdate), then those sent since that keepKnown keeps (see sendUpdate).
    interface KnownValue {
        json: string;
        at: number;
        sent: boolean; // sent by this client, otherwise shown by the server
    }
    const knownValues = new WeakMap<T, Map<string, KnownValue[]>>();

    // Own models asked for again on a reconnect, until the answers are over (see roundEnd). Their
    // updates are checked for changes lost in the dead connection (see lostChanges): per id, the
    // values shown, and the fields found lost, which keep their value.
    interface AfterOutage {
        shown: Map<string, unknown>;
        lost: Set<string>;
    }
    const askedAfterOutage = new Map<string, AfterOutage>();

    // While reconnect requests are unanswered: the askForEnd id sent after them (see takeAnswer).
    let roundEnd: string | undefined;

    // askForEnd ids whose answers end the window for stale updates (see guardFrom), oldest first.
    let guardEnds: string[] = [];

    // Per model, the field names (as sent) kept out of updates until the answer for the last guardEnds id
    // at the time they were sent. Longer would drop another client's later change to the same field.
    let keptOut = new WeakMap<T, Map<string, string>>();

    // Own models settled by an update that may not have been their answer (see takeAnswer), mapped to
    // the guardEnds id whose answer comes after theirs.
    const answerMayFollow = new Map<string, string>();

    // When the server was last heard from before the last outage (see lastHeardFrom).
    let lastHeardBeforeOutage = 0;

    let disconnected = false;

    const hasOwn = (id: string) => models.value.some(m => m.id === id && ownModels.has(m));
    const guard = (end: string) => {
        guardEnds.push(end);
    };
    joinChannel(name, hasOwn, guard);

    // Asks the server for an own model by id; the answer arrives through onUpdate or onDelete.
    // `again: true`, for a model already answered for, makes the server reply model::delete if another
    // client deleted it meanwhile, as a relayed delete may not have reached this client. Without it, the
    // server lifts that delete and answers a bare id. After MODEL_TOMBSTONE_SECONDS the server has
    // forgotten the delete, and this client sends the model again.
    const askFor = (colibri: Colibri, model: T) => {
        awaitingAnswer.set(model.id, colibri);
        colibri.sendMessage(
            name,
            'model::request',
            answered.has(model) ? { id: model.id, again: true } : { id: model.id }
        );
    };

    // For an id deleted here a moment ago and registered again: the request lifts the server's delete,
    // and the full model follows at once since the server has nothing for the id. Until the bare-id
    // answer, updates for the id are dropped (see onUpdate): a remote update sent before the server
    // had the delete would be taken for the answer.
    const sendAfresh = (colibri: Colibri, model: T) => {
        colibri.sendMessage(name, 'model::request', { id: model.id });
        deletedHere.markAfresh(model.id);
        answered.add(model);
        heldChanges.take(model);
        sendUpdate(colibri, model, toJsonOf(model));
    };

    // Requests every model once all own models have their answer, so that answer includes what was
    // sent in between (see guardFrom for what is sent after). Returns whether it asked.
    const catchUpOnceAnswered = () => {
        if (!catchingUpThrough || awaitingAnswer.size > 0) return false;
        const colibri = catchingUpThrough;
        catchingUpThrough = undefined;
        colibri.sendMessage(name, 'model::request');
        guardFrom(colibri);
        return true;
    };

    // Keeps the fields this client sends out of updates until the answer to a request sent now. An
    // earlier request is answered with what the server had when it read it, which may predate these
    // fields; applied, that undoes them on this client only, as the server does not relay an update
    // back to its sender. Every registration on the channel receives the answer, so all of them guard.
    const guardFrom = (colibri: Colibri) => {
        const end = askForEnd(colibri);
        guardChannel(name, end);
    };

    const keepOut = (model: T, update: object) => {
        const end = guardEnds.at(-1);
        if (end === undefined) return;
        let kept = keptOut.get(model);
        if (!kept) keptOut.set(model, (kept = new Map<string, string>()));
        for (const key of Object.keys(update)) if (key !== 'id') kept.set(key, end);
    };

    const keptOutOf = (model: T) =>
        [...(keptOut.get(model) ?? [])].filter(([, end]) => guardEnds.includes(end)).map(([key]) => key);

    // The answer for `end` has come, and with it those for earlier requests; without `end`, none will come.
    const endGuard = (end?: string) => {
        guardEnds = end === undefined ? [] : guardEnds.slice(guardEnds.indexOf(end) + 1);
        if (guardEnds.length > 0) return;
        keptOut = new WeakMap<T, Map<string, string>>();
        answerMayFollow.clear();
    };

    // initial data fetch
    // Repeated after every reconnect, since remote updates relayed meanwhile are lost. Applied to the
    // model with the same id, so nothing is duplicated.
    //
    // The server forgets an app's models when its last client leaves and on restart, so own models are
    // asked for by id first (see askFor), and everything else once all are answered. Also on the first
    // fetch: the answer for every model carries an own model's id too and would be taken for its answer.
    withColibri(colibri => {
        catchingUpThrough = colibri;
        // Deferred so that models registered in the same block of code, or before `new Colibri()`, are asked for first.
        setTimeout(catchUpOnceAnswered, 0);
        onColibriDisconnected(colibri, () => {
            disconnected = true;
            // Answers to the requests on this connection will not come. Ended here, not on reconnect:
            // by then another registration on the channel may have sent the next one (see guardFrom).
            endGuard();
            // Not updated while the last reconnect's answers are pending: changes lost in the earlier
            // outage are still in question, so they are judged from then.
            if (askedAfterOutage.size === 0) lastHeardBeforeOutage = lastHeardFrom(colibri) ?? Date.now();
            // A delete sent after the last message from the server may have gone into a connection that was
            // already dead (Socket.IO loses what it sends until its ping timeout). Sent again, as colibri-unity
            // does; Socket.IO holds it until the reconnect. A delete that did arrive arrives twice, harmlessly.
            const since = (lastHeardFrom(colibri) ?? Date.now()) - 1000;
            for (const id of deletedHere.idsSince(since)) colibri.sendMessage(name, 'model::delete', { id });
        });
        onColibriReconnected(colibri, () => {
            disconnected = false;
            // Requests from the previous connection will not be answered. Changes sent for models still
            // being confirmed may not have arrived, so they are held again and go out with the answer.
            awaitingAnswer.clear();
            deletedWhileAwaited.clear();
            askedAfterOutage.clear();
            deletedHere.clearAfresh();
            for (const id of [...confirming.keys()]) {
                const confirmation = endConfirmation(id);
                const model = models.value.find(m => m.id === id);
                if (confirmation && model && ownModels.has(model)) heldChanges.add(model, confirmation.props);
            }
            catchingUpThrough = colibri;
            for (const model of models.value) {
                if (!ownModels.has(model)) continue;
                if (answered.has(model)) askedAfterOutage.set(model.id, { shown: new Map(), lost: new Set() });
                askFor(colibri, model);
            }
            roundEnd = askedAfterOutage.size > 0 ? askForEnd(colibri) : undefined;
            catchUpOnceAnswered();
        });
    });

    // Register for updates
    RegisterChannel(name, (payload: Message) => {
        if (payload.command === 'model::update') {
            onUpdate((payload as ModelSyncMsg<T>).payload);
        } else if (payload.command === 'model::delete') {
            onDelete((payload as ModelSyncMsg<T>).payload.id);
        } else {
            console.error(`Unknown model command: ${payload.command}`);
        }
    });

    // Answers to askForEnd requests (see roundEnd, guardEnds, endWait). Every registration receives
    // each one sent on this connection and acts only on the ids it waits for.
    RegisterChannel(END_CHANNEL, (message: Message) => {
        if (message.command !== 'model::update') return;
        const id = (message.payload as { id?: unknown } | undefined)?.id;
        if (typeof id !== 'string') return;
        if (id === roundEnd) endRound();
        if (guardEnds.includes(id)) endGuard(id);
        const confirmed = [...confirming].find(([, confirmation]) => confirmation.end === id);
        if (confirmed) endWait(confirmed[0]);
    });

    // Handle updates
    const onUpdate = (modelData: Partial<T>) => {
        const model = models.value.find(m => m.id === modelData.id);
        const id = modelData.id;
        if (deletedHere.dropsAfreshUpdate(id, isBare(modelData))) return;
        if (id !== undefined && deletedWhileAwaited.delete(id) && !model && isBare(modelData)) return;
        const asker = id === undefined ? undefined : awaitingAnswer.get(id);
        if (id !== undefined && asker) {
            takeAnswer(id, asker, model, modelData);
            return;
        }

        // The answer to another registration on this channel that has an own model with this id. Not
        // listed: the full state it sends in reply is not relayed to this client, so the model would stay empty.
        if (!model && id !== undefined && isBare(modelData) && ownedElsewhere(name, hasOwn, id)) return;
        applyUpdate(model, modelData);
    };

    // The first update for an own model after its request settles it. With fields, the server has the
    // model (it stores an update before relaying it): applied as usual, except fields this client
    // changed while waiting, which are sent on top. A bare id means the server has nothing: send the
    // whole model. No model any more (deleted meanwhile): nothing to send.
    //
    // That update need not be the answer: the answer to the request for every model carries the id
    // too, and a remote update can arrive first. The real answer, made before the server had the
    // changes sent meanwhile, would then revert them on this client only. So changes that replace
    // server values are followed by another request for the model and an askForEnd request; later
    // changes are held and the sent fields kept out of updates until its answer (see endWait).
    // Otherwise guardFrom keeps the fields sent later out of updates until one more answer.
    //
    // After a reconnect the answer may also show a change sent before the outage that never arrived
    // (see lostChanges), and is again indistinguishable from a remote update. One more request follows
    // (see roundEnd), updates before its answer are checked, then the model is settled (see endRound).
    const takeAnswer = (id: string, asker: Colibri, model: T | undefined, modelData: Partial<T>) => {
        if (model) answered.add(model);

        // detach() was called since the request: it takes updates like a non-own model and sends
        // nothing.
        if (model && !ownModels.has(model)) {
            askedAfterOutage.delete(id);
            awaitingAnswer.delete(id);
            endConfirmation(id);
            if (!isBare(modelData)) applyUpdate(model, modelData);
            catchUpOnceAnswered();
            return;
        }

        if (!model || isBare(modelData)) {
            askedAfterOutage.delete(id);
            awaitingAnswer.delete(id);
            endConfirmation(id);
            if (model) {
                heldChanges.drop(model);
                sendUpdate(asker, model, toJsonOf(model));
            } else if (!isBare(modelData)) {
                applyUpdate(model, modelData);
            }
            catchUpOnceAnswered();
            return;
        }

        const afterOutage = askedAfterOutage.get(id);
        if (afterOutage) {
            const held = heldChanges.peek(model);
            for (const key of lostChanges(model, modelData, held)) afterOutage.lost.add(key);
            for (const [key, value] of Object.entries(modelData)) afterOutage.shown.set(key, value);
            applyUpdate(model, withoutKeys(withoutChanges(modelData, model, held), afterOutage.lost));
            return;
        }

        const confirmation = confirming.get(id);
        if (confirmation) {
            for (const key of confirmation.sent.keys()) {
                if (key in modelData) confirmation.shown.set(key, modelData[key as keyof T]);
            }
            const held = heldChanges.peek(model);
            applyUpdate(model, withoutKeys(withoutChanges(modelData, model, held), confirmation.sent.keys()));
            return;
        }

        awaitingAnswer.delete(id);
        const held = heldChanges.take(model);
        applyUpdate(model, withoutChanges(modelData, model, held));
        // Deleted by a subscriber while the list emitted: nothing more to send.
        if (!models.value.includes(model)) {
            catchUpOnceAnswered();
            return;
        }
        if (sendOnTop(id, asker, model, modelData, held, [])) return;
        if (!catchUpOnceAnswered()) guardFrom(asker);
        // Whichever of the two calls ran sent a request whose answer comes after this model's.
        const end = guardEnds.at(-1);
        if (end !== undefined) answerMayFollow.set(id, end);
    };

    // The answers to the reconnect requests are over (see takeAnswer): settles each own model with
    // the values the updates showed.
    const endRound = () => {
        roundEnd = undefined;
        const asked = [...askedAfterOutage];
        askedAfterOutage.clear();
        for (const [id, { shown, lost }] of asked) {
            const asker = awaitingAnswer.get(id);
            const model = models.value.find(m => m.id === id);
            // Settled already, by the bare id or model::delete.
            if (!asker || !model) continue;

            awaitingAnswer.delete(id);
            // detach() was called since: it sends nothing.
            if (!ownModels.has(model)) continue;
            const held = heldChanges.take(model);
            // Remember what the server still holds for the lost fields, stamped now: should the value sent
            // again below be lost too, the next outage's answer is judged against it, however long ago the
            // change was made.
            if (lost.size > 0)
                remember(model, Object.fromEntries([...lost].map(key => [key, shown.get(key)])) as Partial<T>);
            sendOnTop(id, asker, model, Object.fromEntries(shown) as Partial<T>, held, [...lost]);
        }
        catchUpOnceAnswered();
    };

    // Sends the held changes (property names) and the lost fields (see lostChanges) with their current
    // values, on top of what the server showed (`shown`). True if that replaces server values, in which
    // case the model is asked for again (see takeAnswer).
    const sendOnTop = (id: string, asker: Colibri, model: T, shown: Partial<T>, held: string[], lost: string[]) => {
        if (held.length === 0 && lost.length === 0) return false;
        const sent = fieldsOnTop(model, id, held, lost);
        sendUpdate(asker, model, sent as Partial<T>);

        // An undefined field is not sent, so no update shows it.
        const differs = new Map<string, string>();
        for (const [key, value] of Object.entries(sent)) {
            const json = JSON.stringify(value) as string | undefined;
            if (key === 'id' || json === undefined) continue;
            if (!(key in shown) || JSON.stringify(shown[key as keyof T]) !== json) differs.set(key, json);
        }
        if (differs.size === 0) return false;
        const replaced = new Map<string, string | undefined>();
        for (const key of differs.keys()) {
            replaced.set(key, key in shown ? JSON.stringify(shown[key as keyof T]) : undefined);
        }
        askFor(asker, model);
        confirming.set(id, { sent: differs, replaced, props: held, shown: new Map(), end: askForEnd(asker) });
        return true;
    };

    // Every answer made before the server had the sent fields has come (see takeAnswer), so the last
    // update that showed a field has what the server holds. The value sent: it arrived. Another value:
    // another client set it since, applied. The value it replaced, or none: it has not arrived (the
    // server holds back updates over CLIENT_MESSAGE_RATE_LIMIT, but never requests) or another client
    // set it back; sent again.
    //
    // The changes made meanwhile then go out without asking again: nothing stale can come any more.
    const endWait = (id: string) => {
        const confirmation = endConfirmation(id);
        const asker = awaitingAnswer.get(id);
        const model = models.value.find(m => m.id === id);
        // Settled already, by the bare id or model::delete.
        if (!confirmation || !asker || !model) return;

        awaitingAnswer.delete(id);
        const held = heldChanges.take(model);
        const theirs: Record<string, unknown> = { id };
        const again: string[] = [];
        for (const [key, json] of confirmation.sent) {
            const shown = confirmation.shown.has(key)
                ? (JSON.stringify(confirmation.shown.get(key)) as string | undefined)
                : undefined;
            if (shown === json) continue;
            if (shown === undefined || shown === confirmation.replaced.get(key)) again.push(key);
            else theirs[key] = confirmation.shown.get(key);
        }
        applyUpdate(model, withoutChanges(theirs as Partial<T>, model, held));

        const update = fieldsOnTop(model, id, held, again);
        // detach() was called since: it sends nothing.
        if (ownModels.has(model) && Object.keys(update).length > 1) sendUpdate(asker, model, update as Partial<T>);
        catchUpOnceAnswered();
    };

    // Sends an update for an own model and records it for lostChanges and guardFrom.
    const sendUpdate = (colibri: Colibri, model: T, update: Partial<T>) => {
        colibri.sendMessage(name, 'model::update', update);
        remember(model, update, lastHeardFrom(colibri) ?? Number.POSITIVE_INFINITY);
        keepOut(model, update);
    };

    // Records `fields` in knownValues: as sent by this client if `heardAt` (when it last heard from the
    // server) is given, otherwise as shown by the server, which replaces the history. Undefined fields
    // are not sent at all, so they are skipped.
    const remember = (model: T, fields: Partial<T>, heardAt?: number) => {
        let known = knownValues.get(model);
        if (!known) knownValues.set(model, (known = new Map<string, KnownValue[]>()));
        const at = Date.now();
        for (const [key, field] of Object.entries(fields)) {
            const json = JSON.stringify(field) as string | undefined;
            if (key === 'id' || json === undefined) continue;
            const value = { json, at, sent: heardAt !== undefined };
            known.set(key, heardAt === undefined ? [value] : keepKnown([...(known.get(key) ?? []), value], heardAt));
        }
    };

    // Trims a field's values (oldest first) to the latest KNOWN_VALUES_KEPT up to `heardAt`, the first
    // KNOWN_VALUES_KEPT after it, and the newest. The server's latency probe comes every 100 ms, so the
    // connection died about when `heardAt` was: the last value that reached the server was sent around
    // then, and later ones went into the dead link, where only the newest counts.
    const keepKnown = (values: KnownValue[], heardAt: number): KnownValue[] => {
        const split = values.findIndex(v => v.at > heardAt);
        if (split < 0) return values.slice(-KNOWN_VALUES_KEPT);
        const after = values.slice(split);
        const newest = after.slice(KNOWN_VALUES_KEPT).slice(-1);
        return [...values.slice(0, split).slice(-KNOWN_VALUES_KEPT), ...after.slice(0, KNOWN_VALUES_KEPT), ...newest];
    };

    // Fields of an own model that an update in the reconnect round shows with a value from before this
    // client's last change: that change never reached the server (Socket.IO loses what is sent into a
    // dead connection until its ping timeout). Applied, the update would revert it on this client only,
    // so the value is kept and sent again.
    //
    // Any other value is applied: one the field never had is another client's, and so is one shown again
    // after this client's last change. An earlier value counts only if it was still current
    // KNOWN_VALUES_MS before the outage, counted from lastHeardBeforeOutage since Socket.IO notices the
    // outage late: a change that replaced it earlier arrived for certain.
    const lostChanges = (model: T, modelData: Partial<T>, held: string[]): string[] => {
        const known = knownValues.get(model);
        if (!known) return [];
        const since = lastHeardBeforeOutage - KNOWN_VALUES_MS;
        const heldKeys = new Set(held.length > 0 ? Object.keys(toJsonOf(model, held)) : []);
        const current = toJsonOf(model) as Record<string, unknown>;
        return Object.entries(modelData)
            .filter(([key, value]) => {
                const values = known.get(key) ?? [];
                const last = values.at(-1);
                if (!last?.sent || heldKeys.has(key) || !(key in current)) return false;
                const json = JSON.stringify(value) as string | undefined;
                const earlier = values.filter((_, i) => i + 1 < values.length && values[i + 1].at >= since);
                return (
                    json !== last.json &&
                    earlier.some(v => v.json === json) &&
                    // Nothing to send when this client has what the server has anyway.
                    JSON.stringify(current[key]) !== json
                );
            })
            .map(([key]) => key);
    };

    // Fields with a change SyncModel has not reported yet keep their value: the update predates the
    // change, and applying it would make the report send the update's value instead.
    const applyUpdate = (model: T | undefined, modelData: Partial<T>) => {
        if (model) {
            const unsent = changesToSend.peek(model);
            const update = withoutKeys(withoutChanges(modelData, model, unsent), keptOutOf(model));
            if (ownModels.has(model)) remember(model, update);

            // Update existing model
            updateOf(model, update);
            models.next([...models.value]);
        } else if (modelData.id) {
            if (deletedHere.recently(modelData.id)) return;
            const newModel = new registration.type(modelData.id);
            newModel.deletions.subscribe(() => {
                deleteHere(newModel);
            });

            newModel.modelChanges.subscribe(change => {
                changesToSend.add(newModel, [change]);
            });
            newModel.modelChanges$.subscribe(changes => {
                changesToSend.drop(newModel);
                const update = toJsonOf(newModel, changes);
                SendMessage(name, 'model::update', update);
                keepOut(newModel, update);
                models.next([...models.value]);
            });

            updateOf(newModel, modelData);
            models.next([...models.value, newModel]);
        }
    };

    const onDelete = (id: string) => {
        const model = models.value.find(m => m.id === id);
        detachOf(model);
        forget(id, model);
    };

    // Deletes a model here as for a remote delete, then on the server. Ignored unless it is the
    // instance listed for its id: a model replaced by registerModel no longer stands for it.
    const deleteHere = (model: T) => {
        if (models.value.find(m => m.id === model.id) !== model) return;
        deletedHere.remember(model.id);
        forget(model.id, model);
        withColibri(colibri => {
            colibri.sendMessage(name, 'model::delete', { id: model.id });
        });
    };

    // Takes a deleted model out of the list and out of everything that waits for it.
    const forget = (id: string, model: T | undefined) => {
        if (model) heldChanges.drop(model);
        askedAfterOutage.delete(id);
        models.next(models.value.filter(m => m.id !== id));

        // model::delete can answer a request for an own model (another client deleted it during an
        // outage). That settles the model like an update, so catching up must not keep waiting for it.
        endConfirmation(id);
        const answerEnd = answerMayFollow.get(id);
        answerMayFollow.delete(id);
        if (awaitingAnswer.delete(id)) {
            deletedWhileAwaited.add(id);
            catchUpOnceAnswered();
        } else if (answerEnd !== undefined && guardEnds.includes(answerEnd)) {
            // Settled by an update that need not have been the answer, which may still come.
            deletedWhileAwaited.add(id);
        }
    };

    // The server may already have a model with this id (created by another client, or by this one before
    // a reload). So the model is asked for by id first, as Unity's SyncBehaviour does (see askFor): what
    // the server has wins, and the full model is sent only if it has nothing.
    //
    // If the id is already listed, from a remote update or an earlier instance, the new instance replaces
    // it in place and the listed one is detached. Registering the listed instance does nothing.
    const registerModel = (model: T) => {
        const listed = models.value.find(m => m.id === model.id);
        if (listed === model) return;
        if (listed && ownModels.has(listed)) {
            console.warn(
                `Colibri: registerModel was given a second model with the id '${model.id}' on channel ` +
                    `'${name}'. It replaces the first one, which no longer syncs.`
            );
        }

        // Hold-back is decided when the change is made, not when SyncModel reports it 1 ms later: an answer
        // arriving in between would be applied over it.
        //
        // Held until the server has answered for the model, then sent on top of what it has: changes made
        // before `new Colibri()`, or after a reconnect but before the answer, would otherwise be undone by it.
        // Also changes made while disconnected: Socket.IO sends them on reconnect ahead of the model's
        // request, and to a server that forgot the model they would become all of it.
        const mustHold = () => !Colibri.getInstance(false) || disconnected || awaitingAnswer.has(model.id);
        model.modelChanges.subscribe(change => {
            if (mustHold()) heldChanges.add(model, [change]);
            else changesToSend.add(model, [change]);
        });
        model.modelChanges$.subscribe({
            next: () => {
                const changes = changesToSend.take(model);
                if (changes.length > 0) {
                    const colibri = Colibri.getInstance(false);
                    if (!colibri || mustHold()) heldChanges.add(model, changes);
                    else sendUpdate(colibri, model, toJsonOf(model, changes));
                }

                // Emit for own models too, held back or sent: the model has changed here, and a page rendering the
                // list has to show it.
                if (models.value.includes(model)) models.next([...models.value]);
            },
            // delete() and detach() end the stream: nothing more is sent for the model, neither held changes
            // nor the whole model after a reconnect.
            complete: () => {
                ownModels.delete(model);
                heldChanges.drop(model);
                changesToSend.drop(model);
            }
        });

        model.deletions.subscribe(() => {
            deleteHere(model);
        });
        const reused = deletedHere.recently(model.id);
        deletedHere.forget(model.id);
        ownModels.add(model);
        if (listed) {
            endConfirmation(model.id);
            askedAfterOutage.delete(model.id);
            detachOf(listed);
            models.next(models.value.map(m => (m === listed ? model : m)));
        } else {
            models.next([...models.value, model]);
        }

        // While disconnected, the reconnect asks for it.
        withColibri(colibri => {
            if (disconnected || !ownModels.has(model)) return;
            if (reused) sendAfresh(colibri, model);
            else askFor(colibri, model);
        });
    };

    return [models.asObservable(), registerModel];
};
