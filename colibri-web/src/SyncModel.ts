import { Subject, bufferTime, filter, map, share } from 'rxjs';

export abstract class SyncModel<T> {
    public readonly id: string;

    // Set synchronously while a remote update is being applied, so decorated
    // setters can suppress re-emitting the change they were just given.
    public applyingRemoteUpdate = false;

    public readonly modelChanges = new Subject<string>();
    public readonly modelChanges$ = this.modelChanges.pipe(
        bufferTime(1),
        map((changes) => changes.filter(this.uniq)),
        filter((changes) => changes.length > 0),
        share(),
    );

    public constructor(id: string) {
        this.id = id;
    }

    private uniq(value: string, index: number, array: string[]) {
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
        if (!Object.prototype.hasOwnProperty.call(this, '__syncedProperties')) {
            Object.defineProperty(this, '__syncedProperties', {
                value: {},
                enumerable: false,
                writable: true,
                configurable: true,
            });
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this as any).__syncedProperties[name] = prop;
    }

    private getSyncedProperties(): { [key: string]: string | symbol } {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (this as any).__syncedProperties || {};
    }

    public update(updates: Partial<T>): void {
        const syncedProps = this.getSyncedProperties();

        this.applyingRemoteUpdate = true;
        try {
            for (const key of Object.keys(updates)) {
                if (key !== 'id') {
                    const localKey = syncedProps[key];
                    if (localKey) {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        (this as any)[localKey as keyof SyncModel<T>] =
                            updates[key as keyof T];
                    } else {
                        console.warn(
                            `Unknown property ${key} in ${this.constructor.name}`,
                        );
                    }
                }
            }
        } finally {
            this.applyingRemoteUpdate = false;
        }
    }

    public toJson(attributes: string[] = []): Partial<T> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const json: any = { id: this.id };

        const syncedProps = this.getSyncedProperties();
        for (const key of Object.keys(syncedProps)) {
            const localKey = syncedProps[key] as keyof SyncModel<T>;
            if (
                attributes.length === 0 ||
                attributes.includes(localKey as string)
            ) {
                json[key] = this[localKey];
            }
        }

        return json;
    }
}
