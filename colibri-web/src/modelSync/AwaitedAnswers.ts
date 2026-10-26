import type { Colibri } from '../Colibri';

export class AwaitedAnswers<T extends object> {
    // Own models asked for by id and not answered yet, with the instance that asked.
    private readonly awaitingAnswer = new Map<string, Colibri>();

    // Own models the server has answered for, on this or an earlier connection (see ModelSyncChannel.askFor).
    private readonly answered = new WeakSet<T>();

    // Instance to send the request for every model through, until it is sent.
    private catchingUpThrough: Colibri | undefined;

    // Ids deleted while their answer was, or may still have been, on its way. A bare-id answer,
    // e.g. from a server with MODEL_TOMBSTONE_SECONDS=0, must not become a model.
    private readonly deletedWhileAwaited = new Set<string>();

    public ask(id: string, colibri: Colibri): void {
        this.awaitingAnswer.set(id, colibri);
    }

    public askerOf(id: string): Colibri | undefined {
        return this.awaitingAnswer.get(id);
    }

    public isAwaited(id: string): boolean {
        return this.awaitingAnswer.has(id);
    }

    // True if the id was still awaited.
    public settle(id: string): boolean {
        return this.awaitingAnswer.delete(id);
    }

    public markAnswered(model: T): void {
        this.answered.add(model);
    }

    public wasAnswered(model: T): boolean {
        return this.answered.has(model);
    }

    public catchUpThrough(colibri: Colibri): void {
        this.catchingUpThrough = colibri;
    }

    public takeCatchUp(): Colibri | undefined {
        if (!this.catchingUpThrough || this.awaitingAnswer.size > 0) return undefined;
        const colibri = this.catchingUpThrough;
        this.catchingUpThrough = undefined;
        return colibri;
    }

    public markDeleted(id: string): void {
        this.deletedWhileAwaited.add(id);
    }

    public takeDeleted(id: string): boolean {
        return this.deletedWhileAwaited.delete(id);
    }

    public clear(): void {
        this.awaitingAnswer.clear();
        this.deletedWhileAwaited.clear();
    }
}
