import { SyncModel } from './SyncModel';

/**
 *  This decorator can be attached to any `accessor` member of a SyncModel.
 *  It will cause the property to be synchronized with the server.
 *  Refer to https://github.com/tc39/proposal-decorators
 */
export function Synced<This extends SyncModel<unknown>, V>(
    syncedName: string = '',
) {
    return function (
        value: ClassAccessorDecoratorTarget<This, V>,
        context: ClassAccessorDecoratorContext<This, V>,
    ): ClassAccessorDecoratorResult<This, V> {
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
                if (this.modelChanges && !this.applyingRemoteUpdate) {
                    this.modelChanges.next(key);
                }
            },
        };
    };
}
