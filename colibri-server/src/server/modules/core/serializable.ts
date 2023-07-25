import * as _ from 'lodash';
import { Subject, merge } from 'rxjs';
import { buffer, auditTime, share, map, filter } from 'rxjs/operators';

export abstract class Serializable<T> {
    public id: string;

    private currentChangeSource: unknown = null;
    private readonly changeSource = new Subject<unknown>();
    protected readonly modelChanges = new Subject<string>();
    public readonly modelChanges$ = this.modelChanges.pipe(
        buffer(
            merge(
                this.modelChanges.pipe(auditTime(1)),
                this.changeSource.asObservable()
            )
        ),
        map(changes => _.uniq(changes)),
        filter(changes => changes.length > 0),
        map(changes => ({ changes: changes, source: this.currentChangeSource })),
        share());

    protected onModelChanges(prop: string): void {
        this.modelChanges.next(prop);
    }

    public constructor(id: string) {
        this.id = id;
    }

    public delete(): void {
        this.modelChanges.complete();
    }


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

    public toJson(attributes: string[] = []): {[key: string]: unknown} {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const json: any = { id: this.id };

        if (attributes.length === 0) {
            attributes = _
                .keys(this)
                .filter(k => k[0] === '_')
                .map(k => k.substr(1)); // remove leading _ to match original attributes
        }

        for (const attribute of attributes) {
            json[attribute] = this[`_${attribute}` as keyof Serializable<T>];
        }

        return json;
    }
}
