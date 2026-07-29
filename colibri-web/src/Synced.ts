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
        // TypeScript's decorator types make this look unreachable, since a
        // correctly-typed usage site can only pass an accessor context here —
        // but plain-JS/Babel consumers get no such guarantee, so this guards
        // against misuse the type system can't observe for them.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (context.kind !== 'accessor') {
            throw new Error('@Synced() must decorate an `accessor` member');
        }

        const key = String(context.name);
        const name = (syncedName || key).toLowerCase();

        // Runs once per instance during construction, after the auto-accessor's
        // own initializer has already set the backing value.
        context.addInitializer(function (this: This) {
            this.registerSyncedProperty(name, key);
        });

        return {
            get(this: This) {
                return value.get.call(this);
            },
            set(this: This, newVal: V) {
                value.set.call(this, newVal);

                // Suppress emission while a remote update is being applied,
                // see SyncModel.update().
                if (!this.applyingRemoteUpdate) {
                    this.modelChanges.next(key);
                }
            }
        };
    };
}
