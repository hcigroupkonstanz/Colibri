import type { Observable } from 'rxjs';
import { ModelSyncChannel } from './modelSync/ModelSyncChannel';
import { warnIfMinified } from './modelSync/warnIfMinified';
import type { SyncModel } from './SyncModel';

interface ModelSyncRegistration<T> {
    /** The channel to sync on. Defaults to the class name in lower case, which minifiers change, so always pass it. */
    name?: string;
    type: { new (id: string): T };
}

/** All models, emitting when one is added, changed or deleted, and a function that starts syncing a new model. */
type ModelSync<T> = [Observable<T[]>, (model: T) => void];

/** Syncs the models of a {@link SyncModel} class on one channel with the other clients. */
export const RegisterModelSync = <T extends SyncModel<T>>(registration: ModelSyncRegistration<T>): ModelSync<T> => {
    const name = registration.name || registration.type.name.toLowerCase();
    if (!registration.name) warnIfMinified(registration.type.name, name);

    const channel = new ModelSyncChannel(name, id => new registration.type(id));
    const registerModel = (model: T) => {
        channel.registerModel(model);
    };

    return [channel.models$, registerModel];
};
