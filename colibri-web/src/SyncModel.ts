import _ from 'lodash';
import { Subject, auditTime, filter, map, share } from 'rxjs';

export abstract class SyncModel<T> {
    public readonly id: string;

    // FIXME: this is set in 'registerSyncedProperty' but the decorator is called after the constructor
    // FIXME: -> therefore only available via prototype!
    private syncedProperties!: { [key: string]: (string | symbol) };

    // TODO: move to ModelSynchronization or use a much better structure or something like that?
    public ignoreNextChange = false;

    public readonly modelChanges = new Subject<string>();
    public readonly modelChanges$ = this.modelChanges.pipe(
        auditTime(1),
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
        this.ignoreNextChange = true;
        for (const key of Object.keys(updates)) {
            if (key !== 'id') {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (this as any)[key as keyof SyncModel<T>] = updates[key as keyof T];
            }
        }
    }

    public toJson(attributes: string[] = []): Partial<T> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const json: any = { id: this.id };

        // TODO: only changed properties
        const syncedProps = Object.getPrototypeOf(this).syncedProperties;
        for (const key of Object.keys(syncedProps)) {
            json[key] = this[syncedProps[key] as keyof SyncModel<T>];
        }

        return json;
    }
}