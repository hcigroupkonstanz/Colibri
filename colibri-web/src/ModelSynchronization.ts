import { BehaviorSubject, Observable } from 'rxjs';
import { Colibri, Message, RegisterChannel, SendMessage } from './Colibri';
import { lastHeardFrom, onColibriDisconnected, onColibriReconnected, whenColibriCreated } from './lifecycle';
import { SyncModel } from './SyncModel';

interface ModelSyncMsg<T extends SyncModel<T>> extends Message {
    command: 'model::update' | 'model::delete';
    payload: Partial<T> & { id: string };
}

interface ModelSyncRegistration<T> {
    /**
     * The channel to sync on. **Recommended.** Defaults to the class name lowercased, which a
     * minifying production build changes - so without this, two builds of the same app, or a
     * minified web build and Unity, can silently stop syncing with each other.
     */
    name?: string;
    type: { new (id: string): T };
}

type ModelSync<T> = [Observable<T[]>, (model: T) => void];

// Runs `action` against the Colibri instance now, or as soon as `new Colibri()` constructs one.
// Sending through SendMessage instead would drop the message, with nothing but a warning, when
// RegisterModelSync runs first - which, in a module-level `const [models$] = RegisterModelSync(...)`,
// is the usual order rather than a mistake.
const withColibri = (action: (colibri: Colibri) => void) => {
    const colibri = Colibri.getInstance(false);
    if (colibri) action(colibri);
    else whenColibriCreated(action);
};

// Channels already warned about, so that registering the same type again (on every render of a
// component, say) does not repeat it.
const warnedMinifiedNames = new Set<string>();

// A production bundler renames classes - typically to one or two letters, or to something with a
// `$` in it - so a channel derived from the class name differs between two builds of the same
// app, and between a minified web build and Unity, and they silently stop syncing.
const warnIfMinified = (className: string, channel: string) => {
    if ((channel.length > 2 && !channel.includes('$')) || warnedMinifiedNames.has(channel)) return;
    warnedMinifiedNames.add(channel);
    console.warn(
        `Colibri: RegisterModelSync is syncing on channel '${channel}', derived from the class name ` +
            `'${className}', which looks minified. A minified build renames classes, so this will not ` +
            `sync with another build or with Unity. Pass the channel explicitly: ` +
            `RegisterModelSync({ name: '...', type: ${className || 'YourModel'} }).`
    );
};

// Whether a model::update carries nothing but the id - which is how the server answers a request
// for a model it does not have. A change always has a field in it; only a model with no synced
// fields at all is ever sent like this.
const isBare = (modelData: object) => Object.keys(modelData).every(key => key === 'id');

// For each channel, whether a RegisterModelSync on it has a model of its own with a given id: every
// RegisterModelSync on the channel receives the server's answer to a request one of them sent, on
// the same connection, and a bare { id } there is that instance's answer, not a model.
const ownOnChannel = new Map<string, Set<(id: string) => boolean>>();

// For each channel, how each RegisterModelSync on it starts keeping the fields it sends out of every
// update until the answer for an id (see guardFrom): every one of them receives the answers to the
// requests the others send.
const guardsOnChannel = new Map<string, Set<(end: string) => void>>();

// The channel the requests that tell when the answers to the earlier ones are over go out on (see
// askForEnd), the one colibri-unity uses after a reconnect. No model is ever put on it.
const END_CHANNEL = 'colibri::reconnect';

// How many of those requests this page has sent, so that each asks for an id of its own.
let endRequests = 0;

// Asks for an id nobody has, on a channel with no models, and returns it. The server handles one
// client's messages in the order they come and answers them in that order, so its answer, the bare
// id, comes after the answers to every request this client sent before.
const askForEnd = (colibri: Colibri) => {
    const id = `colibri-web-${++endRequests}`;
    colibri.sendMessage(END_CHANNEL, 'model::request', { id, again: true });
    return id;
};

// How much of what an own model's fields were is kept, to tell whether the last change this client
// sent for one reached the server (see lostChanges). Per field, the newest value, and of the ones
// before it this many from each side of when this client last heard from the server: the latest
// ones up to then, and the first ones after (see keepKnown). Of those, only the ones still the
// latest at most KNOWN_VALUES_MS before the connection stopped working count. A change sent any
// earlier arrived for certain, so the server showing the value it replaced means another client set
// that again.
const KNOWN_VALUES_KEPT = 8;
const KNOWN_VALUES_MS = 10_000;

export const RegisterModelSync = <T extends SyncModel<T>>(registration: ModelSyncRegistration<T>): ModelSync<T> => {
    const name = registration.name || registration.type.name.toLowerCase();
    if (!registration.name) warnIfMinified(registration.type.name, name);

    const models = new BehaviorSubject<T[]>([]);

    // The models this client registered itself with registerModel, as opposed to those the server
    // told it about. Only these are this client's to send again (see below).
    const ownModels = new WeakSet<T>();

    // Own models asked for by id, on registerModel or after a reconnect, whose answer has not
    // arrived yet - and the instance that asked, which is the one to answer through.
    const awaitingAnswer = new Map<string, Colibri>();

    // Own models the server has answered for, on this connection or an earlier one: those this
    // client held before an outage, and asks for again after it.
    const answered = new WeakSet<T>();

    // From a reconnect until everything else is asked for, the instance to ask through.
    let catchingUpThrough: Colibri | undefined;

    // Own models whose wait for an answer a model::delete ended (see onDelete), or that one removed
    // while their answer may still have been on its way (see answerMayFollow). That delete may
    // have been relayed from another client just before the answer, and a server that does not
    // remember deletes (MODEL_TOMBSTONE_SECONDS=0) still answers with the bare id, which must not
    // become a model of its own.
    const deletedWhileAwaited = new Set<string>();

    // Changes to own models held back instead of sent, by the property names SyncModel reports
    // them under: made while the connection was down, or since registering the model or since a
    // reconnect but before the server answered for it (see registerModel).
    const heldChanges = new WeakMap<T, Set<string>>();

    // Changes to models, own ones made while nothing was held back, waiting for SyncModel to report
    // them (it buffers for 1 ms) to go out together. An update that arrives before then leaves them
    // as they are (see applyUpdate).
    const changesToSend = new WeakMap<T, Set<string>>();

    const noteChangeToSend = (model: T, change: string) => {
        const toSend = changesToSend.get(model);
        if (toSend) toSend.add(change);
        else changesToSend.set(model, new Set([change]));
    };

    // Own models asked for again after sending the changes held back for them (see takeAnswer),
    // until the answers to that are over: by id, the fields sent that replaced a value the server
    // showed, as they were sent (JSON), and that value (JSON, or none); the properties the changes
    // were sent for; the last value an update showed for each of those fields since; and the id
    // asked for by the request sent after it (see askForEnd).
    interface Confirmation {
        sent: Map<string, string>;
        replaced: Map<string, string | undefined>;
        props: string[];
        shown: Map<string, unknown>;
        end: string;
    }
    const confirming = new Map<string, Confirmation>();

    const endConfirmation = (id: string) => {
        const confirmation = confirming.get(id);
        confirming.delete(id);
        return confirmation;
    };

    // For each field of an own model, by the name it is sent under, the values it had, oldest first:
    // the last one the server showed this client (see applyUpdate), then the ones this client sent
    // since (see sendUpdate) that keepKnown keeps - as JSON, with when, and whether it was this
    // client's. See lostChanges.
    interface KnownValue {
        json: string;
        at: number;
        sent: boolean;
    }
    const knownValues = new WeakMap<T, Map<string, KnownValue[]>>();

    // Own models asked for again on a reconnect, until the answers are over (see roundEnd): every
    // update for one until then is checked for changes lost in the connection that died (see
    // lostChanges). For each, the values those updates showed, and the fields found lost, which keep
    // their value and take nothing more from them.
    interface AfterOutage {
        shown: Map<string, unknown>;
        lost: Set<string>;
    }
    const askedAfterOutage = new Map<string, AfterOutage>();

    // While own models asked for again on a reconnect wait for the answers: the id asked for by the
    // request sent after theirs, whose answer comes after all of theirs (see takeAnswer).
    let roundEnd: string | undefined;

    // While updates made before the server had what this client sends now may still arrive (see
    // guardFrom): the ids asked for by the requests whose answers come after them, oldest first.
    let guardEnds: string[] = [];

    // For each model, own or not, the fields kept out of every update for it, by the names they are
    // sent under, each until the answer for the last id in guardEnds when it was sent. A later answer
    // is too late: another client may set the field once the server has this client's value, and its
    // update can come before that answer.
    let keptOut = new WeakMap<T, Map<string, string>>();

    // Own models settled by an update that need not have been their answer (see takeAnswer), by id:
    // the id in guardEnds whose answer comes after theirs. Until it comes, the answer may still be on
    // its way.
    const answerMayFollow = new Map<string, string>();

    // When this client last heard from the server before the connection was lost (see lastHeardFrom).
    let lastHeardBeforeOutage = 0;

    // From a disconnect until the next connect.
    let disconnected = false;

    const hasOwn = (id: string) => models.value.some(m => m.id === id && ownModels.has(m));
    const onChannel = ownOnChannel.get(name);
    if (onChannel) onChannel.add(hasOwn);
    else ownOnChannel.set(name, new Set([hasOwn]));

    const guard = (end: string) => {
        guardEnds.push(end);
    };
    const guards = guardsOnChannel.get(name);
    if (guards) guards.add(guard);
    else guardsOnChannel.set(name, new Set([guard]));

    // Asks the server for an own model by id; onUpdate or onDelete takes the answer. The server
    // answers with what it has - or, for a model it does not have, a bare { id }, and only then
    // does onUpdate send the model's full state. What the server does have is applied rather than
    // overwritten, since it is what every other client has - except what this client changed
    // itself since registering the model or while it waited, which it sends instead.
    //
    // A model the server has answered for is asked for `again: true`: one this client held before
    // an outage, or one asked for again to see that the server has the changes sent for it (see
    // takeAnswer). Another client may have deleted it meanwhile, and after an outage the delete it
    // relayed never arrived here. The server remembers a delete for a while
    // (MODEL_TOMBSTONE_SECONDS) and answers such a request with model::delete, which onDelete
    // applies. Asked for without the flag, as a model this client has right now (registerModel,
    // or one registered while the connection was down), the server forgets that delete and
    // answers with the bare id: the model is in use again. Once that while is over, a deleted model
    // looks the same as one the server forgot, and is sent again.
    const askFor = (colibri: Colibri, model: T) => {
        awaitingAnswer.set(model.id, colibri);
        colibri.sendMessage(
            name,
            'model::request',
            answered.has(model) ? { id: model.id, again: true } : { id: model.id }
        );
    };

    // At first and after a reconnect, everything else is asked for once every own model asked for
    // has its answer, so that that answer has what was sent in between. What is sent after it is
    // not in it (see guardFrom). True if it asked.
    const catchUpOnceAnswered = () => {
        if (!catchingUpThrough || awaitingAnswer.size > 0) return false;
        const colibri = catchingUpThrough;
        catchingUpThrough = undefined;
        colibri.sendMessage(name, 'model::request');
        guardFrom(colibri);
        return true;
    };

    // From now until the answer to a request sent now, the fields this client sends for a model are
    // kept out of every update for it. The answer to a request sent before, made before the server had
    // them, may still be on its way: the server answers a request, for every model or for an own
    // model's id (see takeAnswer), with what it has when it reads that request, and reads a change
    // sent just after it only then. Applied, that answer undid the change on this client alone, for
    // good, since the server relays an update to every client but the one that sent it. Every update
    // that arrives before the answer to the request sent now was made before the server read these
    // fields, another client's too, so what it shows for them is older. Every RegisterModelSync on
    // the channel receives the answers to this one's requests, so each of them does the same.
    const guardFrom = (colibri: Colibri) => {
        const end = askForEnd(colibri);
        for (const guardOnChannel of guardsOnChannel.get(name) ?? []) guardOnChannel(end);
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

    // The answer for `end` has come, and with it those to the requests sent before; or, without
    // `end`, none of them is going to.
    const endGuard = (end?: string) => {
        guardEnds = end === undefined ? [] : guardEnds.slice(guardEnds.indexOf(end) + 1);
        if (guardEnds.length > 0) return;
        keptOut = new WeakMap<T, Map<string, string>>();
        answerMayFollow.clear();
    };

    // initial data fetch - and the same again after every reconnect, since an update relayed while
    // this client was disconnected is gone for it, and only asking again brings it back. The
    // server answers with one model::update per model it has, which onUpdate applies to the
    // model with that id where there is one, so this catches up without duplicating anything.
    //
    // The server may have lost this client's own models meanwhile, though: it forgets every model
    // of an app when the app's last client leaves, and when it restarts. Nothing sent them again,
    // so a client that joined later never saw them. So after a reconnect each own model is asked
    // for by id first (see askFor), and everything else only once they all have their answer.
    //
    // The first time too, everything is asked for only once the models registered by then have
    // their answer: those registered before `new Colibri()`, or in the same block of code as this.
    // Asked for first, the answer for every model came first, carried the id as well, and was
    // taken for the answer to the request for the id; the real one came next, without the changes
    // this client had sent in between, and undid them here.
    withColibri(colibri => {
        catchingUpThrough = colibri;
        setTimeout(catchUpOnceAnswered, 0);
        onColibriDisconnected(colibri, () => {
            disconnected = true;
            // The answers to the requests sent on this connection are not going to come. Ended here
            // rather than on the reconnect, by when another RegisterModelSync on the channel may
            // have sent the next one (see guardFrom).
            endGuard();
            // Not before the answers to asking again after the last reconnect are over: the
            // connection died again before that, and a change lost in the one before is still in
            // question, so it is judged from when this client last heard from the server then.
            if (askedAfterOutage.size === 0) lastHeardBeforeOutage = lastHeardFrom(colibri) ?? Date.now();
        });
        onColibriReconnected(colibri, () => {
            disconnected = false;
            // Whatever was asked on the connection before this one is not going to be answered.
            // The changes sent before a model was asked for again may not have arrived either, so
            // they are held back again, to go out with the answer.
            awaitingAnswer.clear();
            deletedWhileAwaited.clear();
            askedAfterOutage.clear();
            for (const id of [...confirming.keys()]) {
                const confirmation = endConfirmation(id);
                const model = models.value.find(m => m.id === id);
                if (confirmation && model && ownModels.has(model)) holdChanges(model, confirmation.props);
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

    // Register for updates (RegisterChannel itself waits for `new Colibri()` if it has to)
    RegisterChannel(name, (payload: Message) => {
        if (payload.command === 'model::update') {
            onUpdate((payload as ModelSyncMsg<T>).payload);
        } else if (payload.command === 'model::delete') {
            onDelete((payload as ModelSyncMsg<T>).payload.id);
        } else {
            console.error(`Unknown model command: ${payload.command}`);
        }
    });

    // The answer to a request that tells when the answers to the earlier ones are over (see
    // askForEnd): after a reconnect or asking an own model again (see takeAnswer), or to stop keeping
    // fields out (see guardFrom). Every RegisterModelSync receives each one sent on this connection,
    // and takes only its own.
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
        if (id !== undefined && deletedWhileAwaited.delete(id) && !model && isBare(modelData)) return;
        const asker = id === undefined ? undefined : awaitingAnswer.get(id);
        if (id !== undefined && asker) {
            takeAnswer(id, asker, model, modelData);
            return;
        }

        // The answer to another RegisterModelSync on this channel, which has its own model with
        // the id. Listed here, it became a model with no fields, which nothing ever filled in: the
        // full state that instance sends in reply is relayed to every client but this one.
        if (!model && id !== undefined && isBare(modelData) && ownElsewhere(id)) return;
        applyUpdate(model, modelData);
    };

    const ownElsewhere = (id: string) => [...(ownOnChannel.get(name) ?? [])].some(has => has !== hasOwn && has(id));

    // The first update for an own model after its request settles it. One with fields in it means
    // the server has the model - the server stores an update before it relays it - and is applied
    // like any other, save for what this client changed while it waited: that is sent instead,
    // once the rest is applied, as it would have been when it was made. A bare one means the
    // server has nothing for it: send all of it. No model any more - deleted since it was asked
    // for - means nothing to send.
    //
    // That first update need not be the answer, though. The answer to the request for every model
    // has the id in it too, and comes first when it was asked before the id; and an update another
    // client made is relayed as it comes. The answer itself then follows, made before the server
    // had the changes sent in between, and put the old values back here only: this client showed
    // them while the server and every other client had its own. So when changes are sent in place
    // of values the server had, the model is asked for again, with one more request after that
    // (see askForEnd); the changes made from then on are held back too, and what was sent is kept
    // out of every update until the answer to that one, when every answer made before the server
    // had it has come (see endWait). When the changes are what the server had anyway, or there are
    // none, nothing is asked: an answer still on its way has the same values for them, or ones
    // another client set since. A change made after that goes out at once, though, and that answer,
    // made before the server had it, undid it here only. So what this client sends from then on is
    // kept out of every update until the answer to one more request (see guardFrom); asking for
    // every model, when that comes next, does the same.
    //
    // After a reconnect, what the server answers for a model it had answered for before may also
    // show that a change this client sent before the outage never reached the server (see
    // lostChanges). Which update is that answer cannot be told either, and the server relays an
    // update another client made to the new connection as soon as it accepts it, so one made just
    // then comes first. Taken for the answer, it settled the model without checking the field lost,
    // which it did not have, and the answer itself then put the old value back. So, as colibri-unity
    // does, one more request follows those (see roundEnd), on a channel with no models, for an id
    // nobody has. The server handles one client's messages in the order they come and answers them
    // in that order, so its answer, the bare id, comes after every one of theirs. Until it comes,
    // each update for such a model is checked, and applied save for what was held back and the
    // fields found lost. Then the model is settled as on an answer, those fields sent again with
    // what was held (see endRound).
    const takeAnswer = (id: string, asker: Colibri, model: T | undefined, modelData: Partial<T>) => {
        if (model) answered.add(model);

        // A model whose delete() was called since it was asked for: that ended what it sends, so it
        // takes what comes like a model another client registered, and sends nothing.
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
                heldChanges.delete(model);
                sendUpdate(asker, model, model.toJson());
            } else if (!isBare(modelData)) {
                applyUpdate(model, modelData);
            }
            catchUpOnceAnswered();
            return;
        }

        const afterOutage = askedAfterOutage.get(id);
        if (afterOutage) {
            const held = [...(heldChanges.get(model) ?? [])];
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
            const held = [...(heldChanges.get(model) ?? [])];
            applyUpdate(model, withoutKeys(withoutChanges(modelData, model, held), confirmation.sent.keys()));
            return;
        }

        awaitingAnswer.delete(id);
        const held = releaseHeldChanges(model);
        applyUpdate(model, withoutChanges(modelData, model, held));
        if (sendOnTop(id, asker, model, modelData, held, [])) return;
        if (!catchUpOnceAnswered()) guardFrom(asker);
        // Either sends a request whose answer comes after the one for this model.
        const end = guardEnds.at(-1);
        if (end !== undefined) answerMayFollow.set(id, end);
    };

    // The answers to asking again after a reconnect are over (see takeAnswer): each own model asked
    // for is settled with what they showed.
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
            // delete() was called on it since an update for it came: that ended what it sends.
            if (!ownModels.has(model)) continue;
            const held = releaseHeldChanges(model);
            // What the server showed for those is what it still holds. Should the value sent again
            // below be lost as well, in a connection that dies soon after, the next answer is told by
            // it, however long before the change itself was made.
            if (lost.size > 0)
                remember(model, Object.fromEntries([...lost].map(key => [key, shown.get(key)])) as Partial<T>);
            sendOnTop(id, asker, model, Object.fromEntries(shown) as Partial<T>, held, [...lost]);
        }
        catchUpOnceAnswered();
    };

    // Sends, on top of what the server showed for an own model (`shown`), what this client changed
    // while it waited for the answer (`held`, as property names) and the fields found lost in the
    // connection that died (`lost`, see lostChanges), with the values it has now. When they replace
    // values the server had, the model is asked for again (see takeAnswer), and this is true.
    const sendOnTop = (id: string, asker: Colibri, model: T, shown: Partial<T>, held: string[], lost: string[]) => {
        if (held.length === 0 && lost.length === 0) return false;
        // toJson() with no properties named is all of them.
        const current = model.toJson() as Record<string, unknown>;
        const sent: Record<string, unknown> = held.length > 0 ? model.toJson(held) : { id };
        for (const key of lost) sent[key] = current[key];
        sendUpdate(asker, model, sent as Partial<T>);

        // A field without a JSON value (undefined) is not sent at all, so no update shows it.
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

    // The answers to asking an own model again are over (see takeAnswer): every one made before the
    // server had what was sent has come, and the last update that showed a field sent has what the
    // server has for it. The value sent means it arrived. Another value is another client's, set
    // since, and is applied. The value it replaced, or none, means it has not arrived yet: the
    // server holds back the updates of a client over its limit (CLIENT_MESSAGE_RATE_LIMIT), but
    // never a request. Or another client set it back meanwhile. Either way it is sent again.
    //
    // Then the changes made meanwhile go out, without asking once more: nothing made before the
    // server had them can come any more. Asked again, a model that changes all the time, a tracked
    // pose say, stayed asked for, one update a round trip went out, and everything else was never
    // asked for.
    const endWait = (id: string) => {
        const confirmation = endConfirmation(id);
        const asker = awaitingAnswer.get(id);
        const model = models.value.find(m => m.id === id);
        // Settled already, by the bare id or model::delete.
        if (!confirmation || !asker || !model) return;

        awaitingAnswer.delete(id);
        const held = releaseHeldChanges(model);
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

        const current = model.toJson() as Record<string, unknown>;
        const update: Record<string, unknown> = held.length > 0 ? model.toJson(held) : { id };
        for (const key of again) update[key] = current[key];
        // Not for a model whose delete() was called since: that ended what it sends.
        if (ownModels.has(model) && Object.keys(update).length > 1) sendUpdate(asker, model, update as Partial<T>);
        catchUpOnceAnswered();
    };

    // Sends an update for an own model, and remembers the values it sent (see lostChanges).
    const sendUpdate = (colibri: Colibri, model: T, update: Partial<T>) => {
        colibri.sendMessage(name, 'model::update', update);
        remember(model, update, lastHeardFrom(colibri) ?? Number.POSITIVE_INFINITY);
        keepOut(model, update);
    };

    // Remembers the values `fields` has for an own model (see knownValues): sent by this client, after
    // what it knew of each field before, when it last heard from the server at `heardAt` (see
    // keepKnown); or, without `heardAt`, shown by the server, in place of that. A field without a JSON
    // value (undefined) is not sent at all, so there is nothing to remember for it.
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

    // What is kept of a field's values, oldest first, when this client last heard from the server at
    // `heardAt`. The server's latency probe comes every 100 ms, so a connection that dies stops
    // working at most about that long after `heardAt`, and the last value that reached the server,
    // the one its answer after the reconnect has, was sent shortly before or after `heardAt`. Every
    // value sent later went into the dead link, one for each key typed while Socket.IO takes up to
    // most of a minute to notice, and only the newest of those counts: it is what the server should
    // have. So what is kept is the latest KNOWN_VALUES_KEPT values up to `heardAt`, the first
    // KNOWN_VALUES_KEPT after it, and the newest. While the connection works, this client hears from
    // the server all the time, and a value dropped from in between was replaced by a later one that
    // reached the server as well.
    const keepKnown = (values: KnownValue[], heardAt: number): KnownValue[] => {
        const split = values.findIndex(v => v.at > heardAt);
        if (split < 0) return values.slice(-KNOWN_VALUES_KEPT);
        const after = values.slice(split);
        const newest = after.slice(KNOWN_VALUES_KEPT).slice(-1);
        return [...values.slice(0, split).slice(-KNOWN_VALUES_KEPT), ...after.slice(0, KNOWN_VALUES_KEPT), ...newest];
    };

    // The fields of an own model that an update after asking for it again on a reconnect, before the
    // answers are over (see takeAnswer), shows with a value they had before the last change this
    // client sent for them: that change never reached the server. Socket.IO notices a connection
    // that died without closing (Wi-Fi dropping out, say) only once its ping timeout has run out, and
    // whatever is sent until then is lost. Applied, the answer undid the change on this client alone,
    // and nobody else ever saw it; so for these fields, the value this client has is kept and sent
    // again instead.
    //
    // Any other value is applied as it always was: one the field never had here is another client's,
    // set while this one was away, and so is one the server showed again after this client's last
    // change for the field. An earlier value counts only while it was still the latest at most
    // KNOWN_VALUES_MS before the outage, counted back from when this client last heard from the
    // server rather than from now, since Socket.IO may take most of a minute to notice that it no
    // longer does: the change that replaced it any earlier arrived for certain, so the server showing
    // it again means another client set it again.
    const lostChanges = (model: T, modelData: Partial<T>, held: string[]): string[] => {
        const known = knownValues.get(model);
        if (!known) return [];
        const since = lastHeardBeforeOutage - KNOWN_VALUES_MS;
        const heldKeys = new Set(held.length > 0 ? Object.keys(model.toJson(held)) : []);
        const current = model.toJson() as Record<string, unknown>;
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

    const withoutKeys = (modelData: Partial<T>, keys: Iterable<string>): Partial<T> => {
        const drop = new Set(keys);
        return Object.fromEntries(Object.entries(modelData).filter(([key]) => !drop.has(key))) as Partial<T>;
    };

    // A change SyncModel has not reported yet is left as it is: the update was made before the server
    // had the change, which reaches the server after it. Applied over it, the update undid the
    // change, and the report sent the update's value in its place.
    const applyUpdate = (model: T | undefined, modelData: Partial<T>) => {
        if (model) {
            const unsent = [...(changesToSend.get(model) ?? [])];
            const update = withoutKeys(withoutChanges(modelData, model, unsent), keptOutOf(model));
            if (ownModels.has(model)) remember(model, update);

            // Update existing model
            model.update(update);
            models.next([...models.value]);
        } else if (modelData.id) {
            const newModel = new registration.type(modelData.id);

            newModel.modelChanges.subscribe(change => {
                noteChangeToSend(newModel, change);
            });
            newModel.modelChanges$.subscribe(changes => {
                changesToSend.delete(newModel);
                const update = newModel.toJson(changes);
                SendMessage(name, 'model::update', update);
                keepOut(newModel, update);
                models.next([...models.value]);
            });

            newModel.update(modelData);
            models.next([...models.value, newModel]);
        }
    };

    const holdChanges = (model: T, changes: string[]) => {
        const held = heldChanges.get(model);
        if (held) for (const change of changes) held.add(change);
        else heldChanges.set(model, new Set(changes));
    };

    const releaseHeldChanges = (model: T): string[] => {
        const held = [...(heldChanges.get(model) ?? [])];
        heldChanges.delete(model);
        return held;
    };

    // `modelData` without the fields that `changes` - property names, as SyncModel reports them -
    // are sent as.
    const withoutChanges = (modelData: Partial<T>, model: T, changes: string[]): Partial<T> => {
        if (changes.length === 0) return modelData;
        const changed = new Set(Object.keys(model.toJson(changes)).filter(key => key !== 'id'));
        return Object.fromEntries(Object.entries(modelData).filter(([key]) => !changed.has(key))) as Partial<T>;
    };

    const onDelete = (id: string) => {
        const model = models.value.find(m => m.id === id);
        if (model) heldChanges.delete(model);
        askedAfterOutage.delete(id);
        model?.delete();
        models.next(models.value.filter(m => m.id !== id));

        // A request for an own model can be answered with model::delete instead of the model: the
        // server's answer for one another client deleted while this client was away. That settles
        // the model as much as an update would, and after a reconnect, once every own model is
        // settled, everything else is still to be asked for. Left waiting, the id kept that from
        // ever happening, and every other model stayed as it was before the outage.
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

    // The server may already have a model with this id: one another client created, or this
    // client before the page was reloaded, kept while another client of the app stayed connected.
    // Sending the model in full straight away overwrote that copy on the server and every other
    // client, while the answer to the request for every model, already on its way, overwrote this
    // client's copy with the old one, so the two ended up apart. So the model is asked for by id
    // first, the way Unity's SyncBehaviour does it (see askFor): what the server has wins, and the
    // model is sent in full only when the server has nothing for it.
    //
    // The id can also be listed already: as the copy the server told this client about, or as
    // another instance registered earlier. Both used to stay, and every later update for the id went
    // to whichever came first, so the instance registered last never received one. Now the instance
    // registered last replaces the listed one, in place, and the listed one is ended as delete()
    // ends it: it no longer sends its changes. Registering the instance already listed does nothing.
    const registerModel = (model: T) => {
        const listed = models.value.find(m => m.id === model.id);
        if (listed === model) return;
        if (listed && ownModels.has(listed)) {
            console.warn(
                `Colibri: registerModel was given a second model with the id '${model.id}' on channel ` +
                    `'${name}'. It replaces the first one, which no longer syncs.`
            );
        }

        // Whether a change is held back is decided as it is made, not once SyncModel reports it
        // 1 ms later: an answer that came in between was applied over it, and the report then sent
        // the server's old value in its place, to every client.
        //
        // Held back until the server has answered for the model, and then sent on top of what it
        // has: a change made since registering (before `new Colibri()` included), or after a
        // reconnect but before the answer, which the answer would otherwise undo. Also one made
        // while disconnected, which Socket.IO would buffer and send on the reconnect ahead of the
        // request for the model: to a server that had forgotten the model, that change alone
        // became all of it, the answer had fields in it, and the rest was never sent again.
        const mustHold = () => !Colibri.getInstance(false) || disconnected || awaitingAnswer.has(model.id);
        model.modelChanges.subscribe(change => {
            if (mustHold()) holdChanges(model, [change]);
            else noteChangeToSend(model, change);
        });
        model.modelChanges$.subscribe({
            next: () => {
                const changes = [...(changesToSend.get(model) ?? [])];
                changesToSend.delete(model);
                if (changes.length === 0) return;

                const colibri = Colibri.getInstance(false);
                if (!colibri || mustHold()) holdChanges(model, changes);
                else sendUpdate(colibri, model, model.toJson(changes));
            },
            // delete() ends the stream: this client sends nothing more for the model - so neither
            // a held change, nor the whole model again after a reconnect.
            complete: () => {
                ownModels.delete(model);
                heldChanges.delete(model);
                changesToSend.delete(model);
            }
        });

        ownModels.add(model);
        if (listed) {
            endConfirmation(model.id);
            askedAfterOutage.delete(model.id);
            listed.delete();
            models.next(models.value.map(m => (m === listed ? model : m)));
        } else {
            models.next([...models.value, model]);
        }

        // While disconnected, the reconnect asks for it.
        withColibri(colibri => {
            if (!disconnected && ownModels.has(model)) askFor(colibri, model);
        });
    };

    return [models.asObservable(), registerModel];
};
