import { SyncModel } from './SyncModel';

/**
 *  This decorator can be attached to any `accessor` member of a SyncModel.
 *  It will cause the property to be synchronized with the server.
 *  Refer to https://github.com/tc39/proposal-decorators
 */
export function Synced<This extends SyncModel<unknown>, V>(syncedName: string = '') {
    return function (
        value: ClassAccessorDecoratorTarget<This, V>,
        context: ClassAccessorDecoratorContext<This, V>
    ): ClassAccessorDecoratorResult<This, V> {
        // Unreachable for typed callers; plain-JS/Babel callers are not covered by the decorator types.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (context.kind !== 'accessor') {
            throw new Error('@Synced() must decorate an `accessor` member');
        }

        const key = String(context.name);
        const name = (syncedName || key).toLowerCase();

        // Per instance, after the accessor's own initializer.
        context.addInitializer(function (this: This) {
            this.registerSyncedProperty(name, key);
        });

        return {
            get(this: This) {
                return value.get.call(this);
            },
            set(this: This, newVal: V) {
                value.set.call(this, newVal);

                // No echo of a remote update (SyncModel.update()).
                if (!this.applyingRemoteUpdate) {
                    this.modelChanges.next(key);
                }
            }
        };
    };
}

/**
 *  Declares synchronized properties without a decorator, for plain JavaScript. Call it in the
 *  constructor of a SyncModel subclass, after `super(id)`, with each property and its start value:
 *
 *  ```js
 *  class Cube extends SyncModel {
 *      constructor(id) {
 *          super(id);
 *          synced(this, { x: 0, y: 0, color: 'red' });
 *      }
 *  }
 *  ```
 *
 *  Each property syncs as with `@Synced()`, under its lowercased name or under `names[property]`.
 *  Throws for a property the model already has as a member, and for a start value of `undefined`.
 */
export function synced<M extends SyncModel<unknown>, P extends Record<string, unknown>>(
    model: M,
    values: P,
    names: Partial<Record<keyof P & string, string>> = {}
): asserts model is M & P {
    for (const [key, initial] of Object.entries(values)) {
        if (initial === undefined) {
            throw new Error(`synced(): '${key}' has no start value. undefined is not JSON: use null for none.`);
        }
        if (key in model) {
            throw new Error(
                `synced(): '${key}' is already a member of ${model.constructor.name}, a synced property or one of ` +
                    "SyncModel's. Give it another name."
            );
        }

        let value: unknown = initial;
        model.registerSyncedProperty((names[key as keyof P & string] || key).toLowerCase(), key);
        Object.defineProperty(model, key, {
            enumerable: true,
            get: () => value,
            set: (newValue: unknown) => {
                value = newValue;
                // No echo of a remote update (SyncModel.update()).
                if (!model.applyingRemoteUpdate) model.modelChanges.next(key);
            }
        });
    }
}
