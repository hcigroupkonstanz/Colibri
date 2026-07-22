import { Subject, bufferTime, filter, map, share } from 'rxjs';

export abstract class SyncModel<T> {
    public readonly id: string;

    // TODO: move to ModelSynchronization or use a much better structure or something like that?
    public ignoreNextChange = false;

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
        // Decorators are applied to the class prototype when the class is defined.
        // We define __syncedProperties on the prototype, ensuring it doesn't mutate parent classes.
        if (!Object.prototype.hasOwnProperty.call(this, '__syncedProperties')) {
            Object.defineProperty(this, '__syncedProperties', {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                value: { ...((this as any).__syncedProperties || {}) },
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

        for (const key of Object.keys(updates)) {
            if (key !== 'id') {
                const localKey = syncedProps[key];
                if (localKey) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (this as any)[localKey as keyof SyncModel<T>] =
                        updates[key as keyof T];
                    this.ignoreNextChange = true;
                } else {
                    console.warn(
                        `Unknown property ${key} in ${this.constructor.name}`,
                    );
                }
            }
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
