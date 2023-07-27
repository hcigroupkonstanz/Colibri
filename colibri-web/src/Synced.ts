import { SyncModel } from './SyncModel';

/**
 *  This decorator can be attached to any property or accessor of a SyncModel. 
 *  It will cause the property to be synchronized with the server.
 *  Refer to https://www.typescriptlang.org/docs/handbook/decorators.html
 */
export const Synced = <T>(syncedName: string = ''): PropertyDecorator => {

    return function (target: any, key: string | symbol, descriptor?: PropertyDescriptor): void {
        if (!syncedName)
            syncedName = key.toString();
        syncedName = syncedName.toLowerCase();

        if (!(target instanceof SyncModel)) {
            console.error('Synced decorator can only be used on SyncModel properties');
            return;
        }

        let original = target[key as keyof Object];
        // FIXME: this sets the property on the prototype, not the instance!
        target.registerSyncedProperty(syncedName, key);

        if (!descriptor?.get) {
            /**
             * TODO: This (i.e., for properties) doesn't work in react for some reason!
             */
            Reflect.deleteProperty(target, key);
            Reflect.defineProperty(target, key, {
                get: () => original,
                set: newVal => {
                    console.log(`Set ${key.toString()} to ${newVal}`);
                    original = newVal;
                },
                enumerable: true,
                configurable: true
            });
        } else {
            const originalAccessors = {
                get: descriptor.get,
                set: descriptor.set
            };

            descriptor.get = function (): T {
                const ret: T = originalAccessors.get.call(this);
                return ret;
            };

            descriptor.set = function (newval: T) {
                const model = this as SyncModel<T>;
                model.modelChanges.next(syncedName);

                if (originalAccessors.set) {
                    originalAccessors.set.call(this, newval);
                }
            };
        }
    };
};
