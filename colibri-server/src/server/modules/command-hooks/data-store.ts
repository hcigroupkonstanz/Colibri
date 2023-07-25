import * as _ from 'lodash';
import { Service } from '../core/service';

export interface SyncModel {
    id: string;
    [key: string]: unknown;
}

export class DataStore extends Service {
    public serviceName = 'DataStore';
    public groupName = 'core';

    private store: { [key: string]: SyncModel[] } = {};

    public constructor() {
        super();
    }

    public addModel(group: string, channel: string, id: string): void {
        const key = group + channel;
        if (!this.store[key]) {
            this.store[key] = [];
        }

        if (!this.getModel(group, channel, id)) {
            this.store[key].push({ id });
        }
    }


    public updateModel(group: string, channel: string, model: SyncModel): void {
        const key = group + channel;
        if (!this.store[key]) {
            this.store[key] = [];
        }

        const existingModel = this.getModel(group, channel, model.id);
        if (!existingModel) {
            this.store[key].push(model);
        } else {
            for (const k of Object.keys(model)) {
                existingModel[k] = model[k];
            }
        }
    }


    public removeModel(group: string, channel: string, id: string): void {
        const key = group + channel;
        if (this.store[key]) {
            _.remove(this.store[key], m => m.id === id);
        }
    }

    public clear(group: string, channel: string): void {
        delete this.store[group + channel];
    }

    public clearGroup(group: string): void {
        for (const key of Object.keys(this.store)) {
            if (key.startsWith(group)) {
                delete this.store[key];
            }
        }
    }

    public getModel(group: string, channel: string, id: string): SyncModel | undefined {
        const key = group + channel;
        if (this.store[key]) {
            return _.find(this.store[key], m => m.id === id);
        }
        return undefined;
    }

    public getAll(group: string, channel: string): SyncModel[] {
        const key = group + channel;
        return this.store[key] || [];
    }
}
