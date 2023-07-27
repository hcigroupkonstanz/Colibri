import { BehaviorSubject, Observable } from 'rxjs';
import { Message, RegisterChannel, SendMessage } from './Networking';
import { SyncModel } from './SyncModel';

interface ModelSyncMsg<T extends SyncModel<T>> extends Message {
    command: 'model::update' | 'model::delete';
    payload: Partial<T> & { id: string };
}

interface ModelSyncRegistration<T> {
    name?: string;
    type: { new(id: string): T };
}

type ModelSync<T> = [ Observable<T[]>, (model: T) => void ];

export const RegisterModelSync = <T extends SyncModel<T>>(registration: ModelSyncRegistration<T>): ModelSync<T> => {
    const name = registration.name || registration.type.name.toLowerCase();

    // initial data fetch
    SendMessage(`${name}`, 'model::request');

    // Register for updates
    console.log(`Registering model '${name}'`);
    RegisterChannel(`${name}`, (payload: Message) => {
        const msg = payload as ModelSyncMsg<T>;
        if (msg.command === 'model::update') {
            onUpdate(msg.payload);
        } else if (msg.command === 'model::delete') {
            onDelete(msg.payload.id);
        } else {
            console.error(`Unknown model command: ${msg.command}`);
        }
    });

    // Handle updates
    const models = new BehaviorSubject<T[]>([]);

    const onUpdate = (modelData: Partial<T>) => {
        const model = models.value.find(m => m.id === modelData.id);
        if (model) {
            // Update existing model
            model.update(modelData);
            models.next([...models.value]);
        } else if (modelData.id) {
            const newModel = new registration.type(modelData.id);

            newModel.modelChanges$.subscribe(changes => {
                // If we did the changes, we'll ignore it
                if (!newModel.ignoreNextChange) {
                    SendMessage(`${name}`, 'model::update', newModel.toJson());
                }
                newModel.ignoreNextChange = false;
                models.next([...models.value]);
            });

            newModel.update(modelData);
            models.next([...models.value, newModel]);
        }
    };

    const onDelete = (id: string) => {
        const model = models.value.find(m => m.id === id);
        model?.delete();
        models.next(models.value.filter(m => m.id !== id));
    };

    const registerModel = (model: T) => {
        model.modelChanges$.subscribe(changes => {
            // If we did the changes, we'll ignore it
            if (!model.ignoreNextChange) {
                SendMessage(`${name}`, 'model::update', model.toJson());
            }
            model.ignoreNextChange = false;
        });

        // send initial model
        SendMessage(`${name}`, 'model::update', model.toJson());
        models.next([...models.value, model]);
    };

    return [ models.asObservable(), registerModel ];
};
export { SyncModel };

