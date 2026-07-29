import { Subject, bufferTime, filter, map, share } from 'rxjs';

export abstract class SyncModel<T> {
    // Populated per-instance by registerSyncedProperty() via Object.defineProperty
    // as a non-enumerable field, so it stays out of Object.keys()/JSON serialization;
    // `declare` documents the type without emitting a competing field initializer.
    declare private __syncedProperties?: Record<string, string | symbol>;

    public readonly id: string;

    // Set synchronously while a remote update is being applied, so decorated
    // setters can suppress re-emitting the change they were just given.
    public applyingRemoteUpdate = false;

    public readonly modelChanges = new Subject<string>();
    public readonly modelChanges$ = this.modelChanges.pipe(
        bufferTime(1),
        map(changes => changes.filter(this.uniq)),
        filter(changes => changes.length > 0),
        share()
    );

    public constructor(id: string) {
        this.id = id;
    }

    private uniq(this: void, value: string, index: number, array: string[]) {
        return array.indexOf(value) === index;
    }

    protected onModelChanges(prop: string): void {
        this.modelChanges.next(prop);
    }

    public delete(): void {
        this.modelChanges.complete();
    }

    public registerSyncedProperty(name: string, prop: string | symbol): void {
        // Called per-instance (via the accessor decorator's addInitializer), once
        // for every @Synced member declared anywhere in the prototype chain.
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
                        // Reflection-based assignment: `localKey` names whichever
                        // decorated field this network key maps to, so its runtime
                        // type can't be tied to `updates[key]`'s at compile time.
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
                // localKey is always a decorated data field in practice, never a
                // method, but keyof SyncModel<T> can't express that narrowing
                // eslint-disable-next-line @typescript-eslint/unbound-method
                json[key] = this[localKey];
            }
        }

        return json as Partial<T>;
    }
}
