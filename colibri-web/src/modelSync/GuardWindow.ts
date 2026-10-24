// Keeps fields this client sent out of updates until the answers to earlier requests are over, as those
// may predate them.
export class GuardWindow<T extends object> {
    // askForEnd ids whose answers end the window for stale updates, oldest first.
    private guardEnds: string[] = [];

    // Per model, the field names (as sent) kept out of updates until the answer for the last guardEnds id
    // at the time they were sent. Longer would drop another client's later change to the same field.
    private keptOut = new WeakMap<T, Map<string, string>>();

    // Own models settled by an update that may not have been their answer, mapped to the guardEnds id
    // whose answer comes after theirs.
    private readonly answerMayFollow = new Map<string, string>();

    // Ends come from every registration on the channel: each receives the answers to the others' requests.
    public add(end: string): void {
        this.guardEnds.push(end);
    }

    public includes(end: string): boolean {
        return this.guardEnds.includes(end);
    }

    public keepOut(model: T, update: object): void {
        const end = this.guardEnds.at(-1);
        if (end === undefined) return;
        let kept = this.keptOut.get(model);
        if (!kept) this.keptOut.set(model, (kept = new Map<string, string>()));
        for (const key of Object.keys(update)) if (key !== 'id') kept.set(key, end);
    }

    public keptOutOf(model: T): string[] {
        return [...(this.keptOut.get(model) ?? [])]
            .filter(([, end]) => this.guardEnds.includes(end))
            .map(([key]) => key);
    }

    // The answer for `end` has come, and with it those for earlier requests; without `end`, none will come.
    public endGuard(end?: string): void {
        this.guardEnds = end === undefined ? [] : this.guardEnds.slice(this.guardEnds.indexOf(end) + 1);
        if (this.guardEnds.length > 0) return;
        this.keptOut = new WeakMap<T, Map<string, string>>();
        this.answerMayFollow.clear();
    }

    public markAnswerMayFollow(id: string): void {
        const end = this.guardEnds.at(-1);
        if (end !== undefined) this.answerMayFollow.set(id, end);
    }

    // True if the id's answer may still come: the end it was marked with is still pending.
    public takeAnswerMayFollow(id: string): boolean {
        const end = this.answerMayFollow.get(id);
        this.answerMayFollow.delete(id);
        return end !== undefined && this.guardEnds.includes(end);
    }
}
