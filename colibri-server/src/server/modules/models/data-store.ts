import { Service } from '../core/service.js';

export interface SyncModel {
    id: string;
    [key: string]: unknown;
}

// How long a deleted model's id is remembered.
export const DEFAULT_TOMBSTONE_MILLIS = 600_000;

// Bounds the tombstones one app keeps, against a client deleting ids in a loop. The oldest goes first.
export const MAX_TOMBSTONES_PER_APP = 10_000;

// A stored model plus what the admin UI's model inspector shows about it.
export interface ModelEntry {
    readonly model: SyncModel;
    // Date.now() of its latest update.
    updatedAt: number;
    // Counts updates, so ModelMeasures can tell whether its cached size or formatting is stale
    // without a JSON.stringify per model::update.
    version: number;
}

// What is left of a deleted model. Does not record who deleted it: the connection id changes on
// every reconnect. A client that wants the id back sends a fresh model::request { id }.
export interface Tombstone {
    readonly channel: string;
    readonly id: string;
    // performance.now() of the latest delete.
    deletedAt: number;
}

// One app's tombstones: by channel and id for lookups, and by deletion time (oldest first) for
// expiry and eviction.
interface AppTombstones {
    byChannel: Map<string, Map<string, Tombstone>>;
    oldestFirst: Set<Tombstone>;
}

export class DataStore extends Service {
    public serviceName = 'DataStore';
    public groupName = 'core';

    // 0 disables tombstones.
    public tombstoneMillis = DEFAULT_TOMBSTONE_MILLIS;

    // app -> channel -> model id
    private readonly store = new Map<string, Map<string, Map<string, ModelEntry>>>();

    private readonly tombstones = new Map<string, AppTombstones>();

    public constructor() {
        super();
    }

    /** @deprecated No caller; updateModel creates a model on first write. */
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

    // Remembers the delete for tombstoneMillis: updateModel() creates any model it is handed, so a late
    // update (sent before the delete reached its sender, held by a rate limit, queued offline) would revive it.
    public removeModel(group: string, channel: string, id: string): void {
        this.store.get(group)?.get(channel)?.delete(id);
        if (this.tombstoneMillis > 0) {
            this.addTombstone(group, channel, id);
        }
    }

    // The model's tombstone unless it has expired; an expired one is dropped.
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

    // Lifts the tombstone, for an id a client has in its scene again.
    public forgetDeletion(group: string, channel: string, id: string): void {
        const app = this.tombstones.get(group);
        const tombstone = app?.byChannel.get(channel)?.get(id);
        if (app && tombstone) this.forgetTombstone(group, app, tombstone);
    }

    /** @deprecated Only tests call it; clearApp runs on disconnect. */
    public clear(group: string, channel: string): void {
        this.store.get(group)?.delete(channel);
    }

    // Called when the app's last client disconnects. Its tombstones go too: no client is left to revive a model.
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

    // Read-only from here, mostly for the admin UI: unlike deletion(), none of these drops an expired tombstone.

    public getEntry(group: string, channel: string, id: string): Readonly<ModelEntry> | undefined {
        return this.store.get(group)?.get(channel)?.get(id);
    }

    // Insertion order. A channel whose models were all deleted is still listed.
    public *channels(): Generator<{ app: string; channel: string; models: ReadonlyMap<string, Readonly<ModelEntry>> }> {
        for (const [app, byChannel] of this.store) {
            for (const [channel, models] of byChannel) {
                yield { app, channel, models };
            }
        }
    }

    // The model's tombstone unless it has expired.
    public liveDeletion(group: string, channel: string, id: string): Readonly<Tombstone> | undefined {
        const tombstone = this.tombstones.get(group)?.byChannel.get(channel)?.get(id);
        if (!tombstone || performance.now() - tombstone.deletedAt >= this.tombstoneMillis) return undefined;
        return tombstone;
    }

    // Includes apps without any model left.
    public tombstoneApps(): string[] {
        return Array.from(this.tombstones.keys());
    }

    // The app's unexpired tombstones, oldest first.
    public *liveTombstones(group: string): Generator<Readonly<Tombstone>> {
        const app = this.tombstones.get(group);
        if (!app) return;

        const now = performance.now();
        for (const tombstone of app.oldestFirst) {
            if (now - tombstone.deletedAt < this.tombstoneMillis) yield tombstone;
        }
    }

    // Includes expired tombstones not yet dropped. For the tests.
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
            // Deleted again: move it to the end of the order.
            app.oldestFirst.delete(tombstone);
            tombstone.deletedAt = now;
        } else {
            tombstone = { channel, id, deletedAt: now };
            byId.set(id, tombstone);
        }
        app.oldestFirst.add(tombstone);

        // Drop expired tombstones, then the oldest ones while over the limit.
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
