import { Subject, merge } from 'rxjs';
import { buffer, auditTime, share, map, filter } from 'rxjs/operators';

/**
 * Base class for model objects whose property changes are emitted in batches on `modelChanges$`.
 * @deprecated Not used by any current command-hook. Prefer `DataStore`'s plain `SyncModel`
 * records for new synchronized state.
 */
export abstract class Serializable<T> {
    public id: string;

    // Set only for the duration of update(). changeSource flushes synchronously there, so the
    // batch picks up this value.
    private currentChangeSource: unknown = null;
    private readonly changeSource = new Subject<unknown>();
    protected readonly modelChanges = new Subject<string>();
    /**
     * Emits `{ changes, source }` batches of distinct changed property names, each tagged with the
     * source of the update() call that flushed it, or null when the 1 ms timer flushed it.
     */
    public readonly modelChanges$ = this.modelChanges.pipe(
        buffer(
            merge(
                this.modelChanges.pipe(auditTime(1)),
                this.changeSource.asObservable()
            )
        ),
        map(changes => [...new Set(changes)]),
        filter(changes => changes.length > 0),
        map(changes => ({ changes: changes, source: this.currentChangeSource })),
        share());

    protected onModelChanges(prop: string): void {
        this.modelChanges.next(prop);
    }

    public constructor(id: string) {
        this.id = id;
    }

    /** Completes `modelChanges$`, so subscribers get no further batches. */
    public delete(): void {
        this.modelChanges.complete();
    }


    /**
     * Assigns each key of `updates` except `id`, then flushes the pending changes as one batch
     * tagged with `source`.
     */
    public update(updates: Partial<T>, source: unknown): void {
        this.currentChangeSource = source;
        for (const key of Object.keys(updates)) {
            if (key !== 'id') {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (this as any)[key as keyof Serializable<T>] = updates[key as keyof T];
            }
        }
        this.changeSource.next(source);
        this.currentChangeSource = null;
    }

    /**
     * Returns `id` plus the named attributes, read from their `_` fields, or every `_` field when
     * none are named.
     */
    public toJson(attributes: string[] = []): {[key: string]: unknown} {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const json: any = { id: this.id };

        if (attributes.length === 0) {
            attributes = Object
                .keys(this)
                .filter(k => k[0] === '_')
                .map(k => k.slice(1)); // remove leading _ to match original attributes
        }

        for (const attribute of attributes) {
            json[attribute] = this[`_${attribute}` as keyof Serializable<T>];
        }

        return json;
    }
}
