import { SyncModel } from '../SyncModel';

// Calls SyncModel's own toJson(), update() and detach(), as a model class may define methods of the same name.
export const toJsonOf = <T>(model: SyncModel<T>, attributes?: string[]): Partial<T> =>
    SyncModel.prototype.toJson.call(model, attributes) as Partial<T>;
export const updateOf = <T>(model: SyncModel<T>, updates: Partial<T>): void => {
    SyncModel.prototype.update.call(model, updates);
};
export const detachOf = (model: SyncModel<unknown> | undefined): void => {
    if (model) SyncModel.prototype.detach.call(model);
};
