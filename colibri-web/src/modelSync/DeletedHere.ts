// How long updates for an id deleted here are ignored, as in colibri-unity's LocallyDeletedModels:
// a remote update relayed before the server had the delete can still arrive after it. Later ones
// are ignored by the server (MODEL_TOMBSTONE_SECONDS).
const DELETED_HERE_MS = 60_000;

// Fallback for sendAfresh: how long updates for the id are dropped if the bare-id answer never comes.
const AFRESH_ANSWER_MS = 10_000;

export class DeletedHere {
    // Ids deleted here and when (see DELETED_HERE_MS), oldest first.
    private readonly deleted = new Map<string, number>();
    // Ids deleted here and registered again, and when (see sendAfresh).
    private readonly afresh = new Map<string, number>();

    public constructor(private readonly now: () => number) {}

    public remember(id: string): void {
        const now = this.now();
        for (const [old, at] of this.deleted) {
            if (now - at < DELETED_HERE_MS) break;
            this.deleted.delete(old);
        }
        this.deleted.delete(id);
        this.deleted.set(id, now);
    }

    public recently(id: string): boolean {
        const at = this.deleted.get(id);
        if (at === undefined) return false;
        if (this.now() - at < DELETED_HERE_MS) return true;
        this.deleted.delete(id);
        return false;
    }

    public forget(id: string): void {
        this.deleted.delete(id);
    }

    public idsSince(since: number): string[] {
        const ids: string[] = [];
        for (const [id, at] of this.deleted) {
            if (at >= since) ids.push(id);
        }
        return ids;
    }

    public markAfresh(id: string): void {
        this.afresh.set(id, this.now());
    }

    public clearAfresh(): void {
        this.afresh.clear();
    }

    public dropsAfreshUpdate(id: string | undefined, bare: boolean): boolean {
        const afreshSince = id === undefined ? undefined : this.afresh.get(id);
        if (id === undefined || afreshSince === undefined) return false;
        // Until the bare-id answer, updates are ones sent before the server had the delete (see
        // sendAfresh).
        const waiting = this.now() - afreshSince < AFRESH_ANSWER_MS;
        if (bare || !waiting) this.afresh.delete(id);
        return bare || waiting;
    }
}
