import type { Colibri } from '../Colibri';
import type { SyncModel } from '../SyncModel';
import type { AwaitedAnswers } from './AwaitedAnswers';
import type { ChangesByModel } from './ChangesByModel';
import type { Confirmations } from './Confirmations';
import { compareWithShown, judgeConfirmation } from './Confirmations';
import type { GuardWindow } from './GuardWindow';
import type { KnownValues } from './KnownValues';
import { fieldsOnTop, isBare, withoutChanges, withoutKeys } from './modelUpdate';
import type { ReconnectRound } from './ReconnectRound';
import { toJsonOf } from './syncModelMethods';

export interface OwnModelAnswersOptions<T extends SyncModel<T>> {
    readonly heldChanges: ChangesByModel<T>;
    readonly awaitedAnswers: AwaitedAnswers<T>;
    readonly reconnectRound: ReconnectRound;
    readonly confirmations: Confirmations;
    readonly knownValues: KnownValues<T>;
    readonly guardWindow: GuardWindow<T>;
    // Read ModelSyncChannel's model list and own models when called.
    readonly listedModel: (id: string) => T | undefined;
    readonly isListed: (model: T) => boolean;
    readonly isOwn: (model: T) => boolean;
    // ModelSyncChannel's methods of the same names, and askForEnd from ./askForEnd.
    readonly applyUpdate: (model: T | undefined, modelData: Partial<T>) => void;
    readonly sendUpdate: (colibri: Colibri, model: T, update: Partial<T>) => void;
    readonly askFor: (colibri: Colibri, model: T) => void;
    readonly catchUpOnceAnswered: () => boolean;
    readonly guardFrom: (colibri: Colibri) => void;
    readonly askForEnd: (colibri: Colibri) => string;
}

/** Settles own models after their request. */
export class OwnModelAnswers<T extends SyncModel<T>> {
    private readonly heldChanges: ChangesByModel<T>;
    private readonly awaitedAnswers: AwaitedAnswers<T>;
    private readonly reconnectRound: ReconnectRound;
    private readonly confirmations: Confirmations;
    private readonly knownValues: KnownValues<T>;
    private readonly guardWindow: GuardWindow<T>;
    private readonly listedModel: (id: string) => T | undefined;
    private readonly isListed: (model: T) => boolean;
    private readonly isOwn: (model: T) => boolean;
    private readonly applyUpdate: (model: T | undefined, modelData: Partial<T>) => void;
    private readonly sendUpdate: (colibri: Colibri, model: T, update: Partial<T>) => void;
    private readonly askFor: (colibri: Colibri, model: T) => void;
    private readonly catchUpOnceAnswered: () => boolean;
    private readonly guardFrom: (colibri: Colibri) => void;
    private readonly askForEnd: (colibri: Colibri) => string;

    public constructor(options: OwnModelAnswersOptions<T>) {
        this.heldChanges = options.heldChanges;
        this.awaitedAnswers = options.awaitedAnswers;
        this.reconnectRound = options.reconnectRound;
        this.confirmations = options.confirmations;
        this.knownValues = options.knownValues;
        this.guardWindow = options.guardWindow;
        this.listedModel = options.listedModel;
        this.isListed = options.isListed;
        this.isOwn = options.isOwn;
        this.applyUpdate = options.applyUpdate;
        this.sendUpdate = options.sendUpdate;
        this.askFor = options.askFor;
        this.catchUpOnceAnswered = options.catchUpOnceAnswered;
        this.guardFrom = options.guardFrom;
        this.askForEnd = options.askForEnd;
    }

    // The first update for an own model after its request settles it, unless a reconnect round or a
    // confirmation is running: then updates with fields are recorded, and endRound or endWait settles it.
    //
    // That update need not be the answer: the answer to the request for every model carries the id
    // too, and a remote update can arrive first. The real answer, made before the server had the
    // changes sent meanwhile, would then revert them on this client only.
    public takeAnswer(id: string, asker: Colibri, model: T | undefined, modelData: Partial<T>): void {
        if (model) this.awaitedAnswers.markAnswered(model);

        // detach() was called since the request: it takes updates like a non-own model and sends
        // nothing.
        if (model && !this.isOwn(model)) {
            this.settleDetached(id, model, modelData);
            return;
        }

        if (!model || isBare(modelData)) {
            this.settleWithoutFields(id, asker, model, modelData);
            return;
        }

        if (this.reconnectRound.has(id)) {
            this.checkAfterOutage(id, model, modelData);
            return;
        }

        if (this.confirmations.has(id)) {
            this.checkWhileConfirming(id, model, modelData);
            return;
        }

        this.settle(id, asker, model, modelData);
    }

    private settleDetached(id: string, model: T, modelData: Partial<T>): void {
        this.stopWaiting(id);
        if (!isBare(modelData)) this.applyUpdate(model, modelData);
        this.catchUpOnceAnswered();
    }

    // A bare id means the server has nothing: send the whole model. No model any more (deleted
    // meanwhile): nothing to send.
    private settleWithoutFields(id: string, asker: Colibri, model: T | undefined, modelData: Partial<T>): void {
        this.stopWaiting(id);
        if (model) {
            this.heldChanges.drop(model);
            this.sendUpdate(asker, model, toJsonOf(model));
        } else if (!isBare(modelData)) {
            this.applyUpdate(model, modelData);
        }
        this.catchUpOnceAnswered();
    }

    // After a reconnect the answer can show a change sent before the outage that never arrived (see
    // KnownValues.lostChanges), and is indistinguishable from a remote update. Such fields keep their
    // value; the model is settled by endRound once the askForEnd request sent after the reconnect
    // requests is answered (see ReconnectRound).
    private checkAfterOutage(id: string, model: T, modelData: Partial<T>): void {
        const held = this.heldChanges.peek(model);
        const lost = this.reconnectRound.recordAnswer(
            id,
            this.knownValues.lostChanges(model, modelData, held, this.reconnectRound.lastHeard()),
            modelData
        );
        this.applyUpdate(model, withoutKeys(withoutChanges(modelData, model, held), lost));
    }

    // The sent fields that replaced server values stay out of updates until endWait judges what the updates showed.
    private checkWhileConfirming(id: string, model: T, modelData: Partial<T>): void {
        this.confirmations.recordShown(id, modelData);
        const held = this.heldChanges.peek(model);
        this.applyUpdate(model, withoutKeys(withoutChanges(modelData, model, held), this.confirmations.sentKeys(id)));
    }

    // With fields, the server has the model (it stores an update before relaying it): applied as usual,
    // except fields this client changed while waiting, which are sent on top. Changes that replace
    // server values are followed by another request for the model and an askForEnd request; later
    // changes are held and the sent fields kept out of updates until its answer (see endWait).
    // Otherwise ModelSyncChannel.guardFrom keeps the fields sent later out of updates until one more
    // answer.
    private settle(id: string, asker: Colibri, model: T, modelData: Partial<T>): void {
        this.awaitedAnswers.settle(id);
        const held = this.heldChanges.take(model);
        this.applyUpdate(model, withoutChanges(modelData, model, held));
        // Deleted by a subscriber while the list emitted: nothing more to send.
        if (!this.isListed(model)) {
            this.catchUpOnceAnswered();
            return;
        }
        if (this.sendOnTop(asker, model, modelData, held, [])) return;
        if (!this.catchUpOnceAnswered()) this.guardFrom(asker);
        // Whichever of the two calls ran sent a request whose answer comes after this model's.
        this.guardWindow.markAnswerMayFollow(id);
    }

    private stopWaiting(id: string): void {
        this.reconnectRound.delete(id);
        this.awaitedAnswers.settle(id);
        this.confirmations.end(id);
    }

    // The answers to the reconnect requests are over (see checkAfterOutage): settles each own model
    // with the values the updates showed.
    public endRound(): void {
        for (const [id, { shown, lost }] of this.reconnectRound.finish()) {
            const asker = this.awaitedAnswers.askerOf(id);
            const model = this.listedModel(id);
            // Settled already, by the bare id or model::delete.
            if (!asker || !model) continue;

            this.awaitedAnswers.settle(id);
            // detach() was called since: it sends nothing.
            if (!this.isOwn(model)) continue;
            const held = this.heldChanges.take(model);
            // Remember what the server still holds for the lost fields, stamped now: should the value sent
            // again below be lost too, the next outage's answer is judged against it, however long ago the
            // change was made.
            if (lost.size > 0)
                this.knownValues.remember(
                    model,
                    Object.fromEntries([...lost].map(key => [key, shown.get(key)])) as Partial<T>
                );
            this.sendOnTop(asker, model, Object.fromEntries(shown) as Partial<T>, held, [...lost]);
        }
        this.catchUpOnceAnswered();
    }

    // Sends the held changes (property names) and the lost fields (see KnownValues.lostChanges) with their
    // current values, on top of what the server showed (`shown`). True if that replaces server values, in
    // which case the model is asked for again and confirmed (see endWait).
    private sendOnTop(asker: Colibri, model: T, shown: Partial<T>, held: string[], lost: string[]): boolean {
        if (held.length === 0 && lost.length === 0) return false;
        const sent = fieldsOnTop(model, model.id, held, lost);
        this.sendUpdate(asker, model, sent as Partial<T>);

        const compared = compareWithShown(sent, shown);
        if (!compared) return false;
        this.askFor(asker, model);
        this.confirmations.start(model.id, { ...compared, props: held, shown: new Map(), end: this.askForEnd(asker) });
        return true;
    }

    // Every answer made before the server had the sent fields has come (see takeAnswer), so the last
    // update that showed a field has what the server holds. The value sent: it arrived. Another value:
    // another client set it since, applied. The value it replaced, or none: it has not arrived (the
    // server holds back updates over CLIENT_MESSAGE_RATE_LIMIT, but never requests) or another client
    // set it back; sent again.
    //
    // The changes made meanwhile then go out without asking again: nothing stale can come any more.
    public endWait(id: string): void {
        const confirmation = this.confirmations.end(id);
        const asker = this.awaitedAnswers.askerOf(id);
        const model = this.listedModel(id);
        // Settled already, by the bare id or model::delete.
        if (!confirmation || !asker || !model) return;

        this.awaitedAnswers.settle(id);
        const held = this.heldChanges.take(model);
        const { theirs, again } = judgeConfirmation(id, confirmation);
        this.applyUpdate(model, withoutChanges(theirs as Partial<T>, model, held));

        const update = fieldsOnTop(model, id, held, again);
        // detach() was called since: it sends nothing.
        if (this.isOwn(model) && Object.keys(update).length > 1) this.sendUpdate(asker, model, update as Partial<T>);
        this.catchUpOnceAnswered();
    }
}
