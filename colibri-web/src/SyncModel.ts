import _ from 'lodash';
import { Subject, auditTime, buffer, bufferTime, filter, map, share } from 'rxjs';

export abstract class SyncModel<T> {
    public readonly id: string;

    // FIXME: this is set in 'registerSyncedProperty' but the decorator is called after the constructor
    // FIXME: -> therefore only available via prototype!
    private syncedProperties!: { [key: string]: (string | symbol) };

    // TODO: move to ModelSynchronization or use a much better structure or something like that?
    public ignoreNextChange = false;

    public readonly modelChanges = new Subject<string>();
    public readonly modelChanges$ = this.modelChanges.pipe(
        bufferTime(1),
        map(changes => _.uniq(changes)),
        filter(changes => changes.length > 0),
        share());

    public constructor(id: string) {
        this.id = id;
    }

    protected onModelChanges(prop: string): void {
        this.modelChanges.next(prop);
    }

    public delete(): void {
        this.modelChanges.complete();
    }

    public registerSyncedProperty(name: string, prop: string | symbol): void {
        // workaround since decorators are called before constructors
        if (!this.syncedProperties) {
            this.syncedProperties = {};
        }

        this.syncedProperties[name] = prop;
    }

    public update(updates: Partial<T>): void {
        const syncedProps = Object.getPrototypeOf(this).syncedProperties;

        for (const key of Object.keys(updates)) {
            if (key !== 'id') {
                const localKey = syncedProps[key];
                if (localKey) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (this as any)[localKey as keyof SyncModel<T>] = updates[key as keyof T];
                    this.ignoreNextChange = true;
                } else {
                    console.warn(`Unknown property ${key} in ${this.constructor.name}`);
                }
            }
        }
    }

    public toJson(attributes: string[] = []): Partial<T> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const json: any = { id: this.id };

        // TODO: only changed properties
        const syncedProps = Object.getPrototypeOf(this).syncedProperties;
        for (const key of Object.keys(syncedProps)) {
            const localKey = syncedProps[key] as keyof SyncModel<T>;
            if (attributes.length === 0 || attributes.includes(localKey)) {
                json[key] = this[localKey];
            }
        }

        return json;
    }
}