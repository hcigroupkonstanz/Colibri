import { Service } from '../core/service.js';

export interface SyncModel {
    id: string;
    [key: string]: unknown;
}

// How long a deleted model's id is remembered; see DataStore.removeModel.
export const DEFAULT_TOMBSTONE_MILLIS = 600_000;

// How many deleted ids one app remembers at most. Far more than a typical scene deletes in the
// tombstones' lifetime - only a scene that spawns and destroys synced objects in a loop comes near -
// and a bound on what such a scene, or a client deleting ids in a runaway loop, can make the server
// keep. Past it the oldest is forgotten first.
export const MAX_TOMBSTONES_PER_APP = 10_000;

// A stored model, and what the admin UI's model inspector shows about it besides its value.
export interface ModelEntry {
    readonly model: SyncModel;
    // Date.now() of its latest update.
    updatedAt: number;
    // Counts its updates, so that the admin UI can tell whether what it measured or formatted of
    // the model (see ModelMeasures) is still its current value. Nothing is measured per update,
    // which would cost a JSON.stringify per model::update.
    version: number;
}

// What is left of a deleted model.
//
// Who deleted it is not part of it. A client is known only by its connection id, which is new
// after every reconnect, so "the client that deleted it may create it again" did not hold for a
// headset that had reconnected in between. A client that creates the object again says so instead,
// with a fresh model::request { id } (see ModelSynchronization.sendInitialState).
export interface Tombstone {
    readonly channel: string;
    readonly id: string;
    // performance.now() of the latest delete.
    deletedAt: number;
}

// One app's tombstones: by channel and id for lookups, and in the order they were last deleted
// for expiry and eviction, which only ever take the oldest.
interface AppTombstones {
    byChannel: Map<string, Map<string, Tombstone>>;
    oldestFirst: Set<Tombstone>;
}

export class DataStore extends Service {
    public serviceName = 'DataStore';
    public groupName = 'core';

    // How long removeModel() remembers a deleted model's id. 0 remembers none.
    public tombstoneMillis = DEFAULT_TOMBSTONE_MILLIS;

    // Nested by app -> channel -> model id, instead of a flat `group + channel` string key.
    // That flat key was ambiguous (app 'ab' + channel 'c' collided with app 'a' + channel
    // 'bc') and made clearApp() match with a prefix scan (`key.startsWith(group)`), which
    // wiped app 'test2' when the last client of app 'test' disconnected. Both bugs are
    // structural here: clearApp() just deletes the one Map entry for that app.
    private readonly store = new Map<string, Map<string, Map<string, ModelEntry>>>();

    private readonly tombstones = new Map<string, AppTombstones>();

    public constructor() {
        super();
    }

    /** @deprecated No current caller - `updateModel` already creates a model on first write. */
    public addModel(group: string, channel: string, id: string): void {
        const models = this.getOrCreateChannel(group, channel);
        if (!models.has(id)) {
            models.set(id, { model: { id }, updatedAt: Date.now(), version: 0 });
        }
    }

    public updateModel(group: string, channel: string, model: SyncModel): void {
        const models = this.getOrCreateChannel(group, channel);
        const existing = models.get(model.id);
        if (!existing) {
            models.set(model.id, { model, updatedAt: Date.now(), version: 0 });
        } else {
            const existingModel = existing.model;
            for (const k of Object.keys(model)) {
                existingModel[k] = model[k];
            }
            existing.updatedAt = Date.now();
            existing.version += 1;
        }
    }

    // Removes the model and, for tombstoneMillis, remembers that it was deleted.
    //
    // updateModel() creates whatever model it is handed, so without that memory any update that
    // arrives after a delete brings the model back: one another client sent before the delete
    // reached it, one this server held back under a limit and passed on after the delete (order
    // is only kept per client), or one a client queued while it was offline. Relayed, it has every
    // client's manager spawn the object again, with nobody left to delete it.
    public removeModel(group: string, channel: string, id: string): void {
        this.store.get(group)?.get(channel)?.delete(id);
        if (this.tombstoneMillis > 0) {
            this.addTombstone(group, channel, id);
        }
    }

    // The tombstone of a model deleted no longer than tombstoneMillis ago, if there is one.
    public deletion(group: string, channel: string, id: string): Tombstone | undefined {
        const app = this.tombstones.get(group);
        if (!app) return undefined;

        const tombstone = app.byChannel.get(channel)?.get(id);
        if (!tombstone) return undefined;

        if (performance.now() - tombstone.deletedAt >= this.tombstoneMillis) {
            this.forgetTombstone(group, app, tombstone);
            return undefined;
        }
        return tombstone;
    }

    // For an id a client has in its scene again; see ModelSynchronization.sendInitialState.
    public forgetDeletion(group: string, channel: string, id: string): void {
        const app = this.tombstones.get(group);
        const tombstone = app?.byChannel.get(channel)?.get(id);
        if (app && tombstone) this.forgetTombstone(group, app, tombstone);
    }

    /** @deprecated No current caller - `clearApp` is what actually runs on disconnect. */
    public clear(group: string, channel: string): void {
        this.store.get(group)?.delete(channel);
    }

    // Forgets the app's models and its tombstones: with no client left, nothing is left that could
    // bring a deleted model back, and whatever the next client brings is the app's state afresh.
    public clearApp(group: string): void {
        this.store.delete(group);
        this.tombstones.delete(group);
    }

    public getModel(group: string, channel: string, id: string): SyncModel | undefined {
        return this.store.get(group)?.get(channel)?.get(id)?.model;
    }

    public getAll(group: string, channel: string): SyncModel[] {
        const models = this.store.get(group)?.get(channel);
        return models ? Array.from(models.values(), entry => entry.model) : [];
    }

    // The rest of this class's public methods are for the admin UI (see AdminData), and read only:
    // none of them changes a model, or forgets a tombstone, expired or not.

    // A model with what the admin UI shows about it.
    public getEntry(group: string, channel: string, id: string): Readonly<ModelEntry> | undefined {
        return this.store.get(group)?.get(channel)?.get(id);
    }

    // Every app's channels, in the order they were first written to, with their models in the order
    // they were created. A channel whose models have all been deleted is still listed, empty.
    public *channels(): Generator<{ app: string; channel: string; models: ReadonlyMap<string, Readonly<ModelEntry>> }> {
        for (const [app, byChannel] of this.store) {
            for (const [channel, models] of byChannel) {
                yield { app, channel, models };
            }
        }
    }

    // The model's tombstone if it has one that has not expired. Unlike deletion(), leaves an
    // expired one where it is.
    public liveDeletion(group: string, channel: string, id: string): Readonly<Tombstone> | undefined {
        const tombstone = this.tombstones.get(group)?.byChannel.get(channel)?.get(id);
        if (!tombstone || performance.now() - tombstone.deletedAt >= this.tombstoneMillis) return undefined;
        return tombstone;
    }

    // The apps that hold tombstones, which may be apps without any model left.
    public tombstoneApps(): string[] {
        return Array.from(this.tombstones.keys());
    }

    // The app's tombstones that have not expired, the oldest first. Unlike deletion(), leaves the
    // expired ones where they are.
    public *liveTombstones(group: string): Generator<Readonly<Tombstone>> {
        const app = this.tombstones.get(group);
        if (!app) return;

        const now = performance.now();
        for (const tombstone of app.oldestFirst) {
            if (now - tombstone.deletedAt < this.tombstoneMillis) yield tombstone;
        }
    }

    // How many tombstones the app holds, expired ones not yet dropped included. For the tests.
    public tombstoneCount(group: string): number {
        return this.tombstones.get(group)?.oldestFirst.size ?? 0;
    }

    private getOrCreateChannel(group: string, channel: string): Map<string, ModelEntry> {
        let byChannel = this.store.get(group);
        if (!byChannel) {
            byChannel = new Map();
            this.store.set(group, byChannel);
        }

        let models = byChannel.get(channel);
        if (!models) {
            models = new Map();
            byChannel.set(channel, models);
        }
        return models;
    }

    private addTombstone(group: string, channel: string, id: string): void {
        const now = performance.now();

        let app = this.tombstones.get(group);
        if (!app) {
            app = { byChannel: new Map(), oldestFirst: new Set() };
            this.tombstones.set(group, app);
        }

        let byId = app.byChannel.get(channel);
        if (!byId) {
            byId = new Map();
            app.byChannel.set(channel, byId);
        }

        let tombstone = byId.get(id);
        if (tombstone) {
            // Deleted again: it is now the most recently deleted.
            app.oldestFirst.delete(tombstone);
            tombstone.deletedAt = now;
        } else {
            tombstone = { channel, id, deletedAt: now };
            byId.set(id, tombstone);
        }
        app.oldestFirst.add(tombstone);

        // Oldest first: drop the expired ones, and the oldest live ones while there are too many.
        for (const oldest of app.oldestFirst) {
            const expired = now - oldest.deletedAt >= this.tombstoneMillis;
            if (!expired && app.oldestFirst.size <= MAX_TOMBSTONES_PER_APP) break;
            this.forgetTombstone(group, app, oldest);
        }
    }

    private forgetTombstone(group: string, app: AppTombstones, tombstone: Tombstone): void {
        app.oldestFirst.delete(tombstone);

        const byId = app.byChannel.get(tombstone.channel);
        if (byId?.get(tombstone.id) === tombstone) {
            byId.delete(tombstone.id);
            if (byId.size === 0) app.byChannel.delete(tombstone.channel);
        }
        if (app.oldestFirst.size === 0) this.tombstones.delete(group);
    }
}
