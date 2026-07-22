import { SyncModel } from './SyncModel';

/**
 *  This decorator can be attached to any property or accessor of a SyncModel.
 *  It will cause the property to be synchronized with the server.
 *  Refer to https://www.typescriptlang.org/docs/handbook/decorators.html
 */
export const Synced = <T>(syncedName: string = ''): PropertyDecorator => {
    return function (
        target: unknown,
        key: string | symbol,
        descriptor?: PropertyDescriptor,
    ): void {
        if (!syncedName) syncedName = key.toString();
        syncedName = syncedName.toLowerCase();

        if (!(target instanceof SyncModel)) {
            console.error(
                'Synced decorator can only be used on SyncModel properties',
            );
            return;
        }

        // The property metadata is correctly set on the prototype so it's shared across instances.
        target.registerSyncedProperty(syncedName, key);

        if (!descriptor?.get) {
            // Create a unique symbol to store the backing value on each instance
            const privateKey = Symbol(String(key));

            Reflect.deleteProperty(target, key);
            Reflect.defineProperty(target, key, {
                get: function (this: SyncModel<T> & Record<symbol, T>) {
                    return this[privateKey];
                },
                set: function (
                    this: SyncModel<T> & Record<symbol, T>,
                    newVal: T,
                ) {
                    this[privateKey] = newVal;

                    // modelChanges might not be initialized yet if the property is set in the constructor
                    if (this.modelChanges) {
                        this.modelChanges.next(String(key));
                    }
                },
                enumerable: true,
                configurable: true,
            });
        } else {
            const originalAccessors = {
                get: descriptor.get,
                set: descriptor.set,
            };

            descriptor.get = function (): T {
                const ret: T = originalAccessors.get.call(this);
                return ret;
            };

            descriptor.set = function (newVal: T) {
                const model = this as SyncModel<T>;
                model.modelChanges.next(String(key));

                if (originalAccessors.set) {
                    originalAccessors.set.call(this, newVal);
                }
            };
        }
    };
};
