export interface AfterOutage {
    shown: Map<string, unknown>;
    lost: Set<string>;
}

export class ReconnectRound {
    // Own models asked for again on a reconnect, until the answers are over (see roundEnd). Their
    // updates are checked for changes lost in the dead connection (see lostChanges): per id, the
    // values shown, and the fields found lost, which keep their value.
    private readonly askedAfterOutage = new Map<string, AfterOutage>();

    // While reconnect requests are unanswered: the askForEnd id sent after them (see takeAnswer).
    private roundEnd: string | undefined;

    // When the server was last heard from before the last outage (see lastHeardFrom).
    private lastHeardBeforeOutage = 0;

    public isEmpty(): boolean {
        return this.askedAfterOutage.size === 0;
    }

    public setLastHeard(at: number): void {
        this.lastHeardBeforeOutage = at;
    }

    public lastHeard(): number {
        return this.lastHeardBeforeOutage;
    }

    public clear(): void {
        this.askedAfterOutage.clear();
    }

    public add(id: string): void {
        this.askedAfterOutage.set(id, { shown: new Map(), lost: new Set() });
    }

    public start(askForEnd: () => string): void {
        this.roundEnd = this.askedAfterOutage.size > 0 ? askForEnd() : undefined;
    }

    public isEnd(id: string): boolean {
        return id === this.roundEnd;
    }

    public has(id: string): boolean {
        return this.askedAfterOutage.has(id);
    }

    public recordAnswer(id: string, lost: Iterable<string>, shown: object): ReadonlySet<string> {
        const afterOutage = this.askedAfterOutage.get(id);
        if (!afterOutage) return new Set();
        for (const key of lost) afterOutage.lost.add(key);
        for (const [key, value] of Object.entries(shown)) afterOutage.shown.set(key, value);
        return afterOutage.lost;
    }

    public delete(id: string): void {
        this.askedAfterOutage.delete(id);
    }

    public finish(): [string, AfterOutage][] {
        this.roundEnd = undefined;
        const asked = [...this.askedAfterOutage];
        this.askedAfterOutage.clear();
        return asked;
    }
}
