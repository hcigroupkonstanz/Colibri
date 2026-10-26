import { Subject, auditTime, buffer, filter, map, share } from 'rxjs';

export abstract class SyncModel<T> {
    // Non-enumerable (stays out of Object.keys() and JSON), defined per instance by registerSyncedProperty().
    // `declare` emits no field initializer.
    declare private __syncedProperties?: Record<string, string | symbol>;

    public readonly id: string;

    // True while update() applies a remote update, so the setters do not echo it.
    public applyingRemoteUpdate = false;

    public readonly modelChanges = new Subject<string>();
    public readonly modelChanges$ = this.modelChanges.pipe(
        // auditTime arms its timer on the first change only; bufferTime keeps an interval running while idle.
        buffer(this.modelChanges.pipe(auditTime(1))),
        map(changes => changes.filter(this.uniq)),
        filter(changes => changes.length > 0),
        share()
    );

    // Emits once on delete(), which RegisterModelSync sends on as model::delete. Public only for RegisterModelSync.
    public readonly deletions = new Subject<void>();
    // ES private: a subclass may have a `deleted` of its own.
    #deleted = false;

    public constructor(id: string) {
        this.id = id;
    }

    private uniq(this: void, value: string, index: number, array: string[]) {
        return array.indexOf(value) === index;
    }

    protected onModelChanges(prop: string): void {
        this.modelChanges.next(prop);
    }

    /**
     * Deletes the model for every client of the app (Unity destroys its GameObject) and removes it
     * from this client's list. The model stops syncing.
     */
    public delete(): void {
        if (this.#deleted) return;
        this.#deleted = true;
        if (!this.deletions.observed) {
            console.warn(
                `Colibri: delete() of '${this.id}', which no RegisterModelSync lists. Register it, or ` +
                    'take it from the list RegisterModelSync gives, to delete it for every client.'
            );
        }
        // Detach first: completing modelChanges flushes a buffered change, which must be sent before the delete.
        // SyncModel's own detach(), as a model class may define one too.
        SyncModel.prototype.detach.call(this);
        this.deletions.next();
        this.deletions.complete();
    }

    /**
     * Stops syncing the model on this client only; every other client keeps it. RegisterModelSync
     * calls it on a remote delete and when registerModel replaces a listed copy.
     */
    public detach(): void {
        this.modelChanges.complete();
    }

    public registerSyncedProperty(name: string, prop: string | symbol): void {
        // Called per instance: by @Synced's initializer for every member in the prototype chain, and by synced().
        let syncedProperties = this.__syncedProperties;
        if (syncedProperties === undefined) {
            syncedProperties = {};
            Object.defineProperty(this, '__syncedProperties', {
                value: syncedProperties,
                enumerable: false,
                writable: true,
                configurable: true
            });
        }

        syncedProperties[name] = prop;
    }

    private getSyncedProperties(): Record<string, string | symbol> {
        return this.__syncedProperties ?? {};
    }

    public update(updates: Partial<T>): void {
        const syncedProps = this.getSyncedProperties();

        this.applyingRemoteUpdate = true;
        try {
            for (const key of Object.keys(updates)) {
                if (key !== 'id') {
                    const localKey = syncedProps[key];
                    if (localKey) {
                        // localKey is only known at runtime, so its type can't be tied to updates[key].
                        (this as unknown as Record<string | symbol, unknown>)[localKey] = updates[key as keyof T];
                    } else {
                        console.warn(`Unknown property ${key} in ${this.constructor.name}`);
                    }
                }
            }
        } finally {
            this.applyingRemoteUpdate = false;
        }
    }

    public toJson(attributes: string[] = []): Partial<T> {
        const json: Record<string, unknown> = { id: this.id };

        const syncedProps = this.getSyncedProperties();
        for (const key of Object.keys(syncedProps)) {
            const localKey = syncedProps[key] as keyof SyncModel<T>;
            if (attributes.length === 0 || attributes.includes(localKey)) {
                // Always a synced data field, never a method, but keyof SyncModel<T> can't express that.
                // eslint-disable-next-line @typescript-eslint/unbound-method
                json[key] = this[localKey];
            }
        }

        return json as Partial<T>;
    }
}
