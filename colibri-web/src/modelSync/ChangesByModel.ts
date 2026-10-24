// Property names of changes, per model.
export class ChangesByModel<T extends object> {
    private readonly byModel = new WeakMap<T, Set<string>>();

    public add(model: T, changes: readonly string[]): void {
        const known = this.byModel.get(model);
        if (known) for (const change of changes) known.add(change);
        else this.byModel.set(model, new Set(changes));
    }

    public peek(model: T): string[] {
        return [...(this.byModel.get(model) ?? [])];
    }

    public take(model: T): string[] {
        const changes = this.peek(model);
        this.byModel.delete(model);
        return changes;
    }

    public drop(model: T): void {
        this.byModel.delete(model);
    }
}
