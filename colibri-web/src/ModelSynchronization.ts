import type { Observable } from 'rxjs';
import { ModelSyncChannel } from './modelSync/ModelSyncChannel';
import { warnIfMinified } from './modelSync/warnIfMinified';
import type { SyncModel } from './SyncModel';

interface ModelSyncRegistration<T> {
    /** The channel to sync on. Recommended: the default, the lowercased class name, changes when minified. */
    name?: string;
    type: { new (id: string): T };
}

type ModelSync<T> = [Observable<T[]>, (model: T) => void];

export const RegisterModelSync = <T extends SyncModel<T>>(registration: ModelSyncRegistration<T>): ModelSync<T> => {
    const name = registration.name || registration.type.name.toLowerCase();
    if (!registration.name) warnIfMinified(registration.type.name, name);

    const channel = new ModelSyncChannel(name, id => new registration.type(id));
    const registerModel = (model: T) => {
        channel.registerModel(model);
    };

    return [channel.models$, registerModel];
};
