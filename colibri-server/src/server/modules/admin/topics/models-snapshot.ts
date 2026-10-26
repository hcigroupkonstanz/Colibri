import type { DataStore, Tombstone } from '../../models/data-store.js';
import { ModelMeasures } from '../model-measures.js';
import { fieldCount } from './field-count.js';
import { clip, truncatedFlag } from './name-length.js';
import { fieldsOf, integerField, queryName, stringField } from './query-fields.js';
import { wallClock } from './wall-clock.js';

export const DEFAULT_MODELS_LIMIT = 50;
export const MAX_MODELS_LIMIT = 200;
// At most this many channels in the overview and deleted ids in the list.
export const MAX_CHANNELS = 500;
export const MAX_DELETED = 100;
export const MAX_FILTER_LENGTH = 200;

export interface ModelsQuery {
    // Exact app and channel; '' for every one.
    app: string;
    channel: string;
    // Part of a model's id or channel, in any case; '' for every model.
    filter: string;
    offset: number;
    limit: number;
}

export const parseModelsQuery = function (body: unknown): ModelsQuery {
    const fields = fieldsOf(body);
    return {
        app: queryName(fields, 'app'),
        channel: queryName(fields, 'channel'),
        filter: stringField(fields, 'filter').slice(0, MAX_FILTER_LENGTH),
        offset: integerField(fields, 'offset', 0, 0, Number.MAX_SAFE_INTEGER),
        limit: integerField(fields, 'limit', DEFAULT_MODELS_LIMIT, 1, MAX_MODELS_LIMIT),
    };
};

export interface ChannelSummary {
    app: string;
    channel: string;
    models: number;
    // Ids deleted within MODEL_TOMBSTONE_SECONDS.
    deleted: number;
    // The app or channel name was cut to MAX_NAME_LENGTH.
    truncated?: true;
}

export interface ModelRow {
    app: string;
    channel: string;
    id: string;
    // Top-level fields besides the id.
    fields: number;
    // Compact JSON size as last measured (see ModelMeasures.bytes); null if not measured yet.
    bytes: number | null;
    // Date.now() of its latest update.
    updatedAt: number;
    // The app, channel or id was cut to MAX_NAME_LENGTH, so the model topic cannot find it.
    truncated?: true;
}

export interface DeletedRow {
    app: string;
    channel: string;
    id: string;
    // Date.now() of the delete.
    deletedAt: number;
    truncated?: true;
}

export interface ModelsSnapshot {
    at: number;
    query: ModelsQuery;
    // Every app and channel holding models or tombstones: those with models in store order, then
    // those with only tombstones. The first MAX_CHANNELS of channelsTotal.
    channels: ChannelSummary[];
    channelsTotal: number;
    // The models matching the query from `offset` on, at most `limit`, in store order (by app and
    // channel as above, then in creation order). `total` is how many match.
    models: ModelRow[];
    total: number;
    // The ids matching the query deleted within tombstoneSeconds, the newest first, at most
    // MAX_DELETED of deletedTotal.
    deleted: DeletedRow[];
    deletedTotal: number;
    tombstoneSeconds: number;
}

// What both passes of modelsSnapshot share.
interface SnapshotScope {
    store: DataStore;
    query: ModelsQuery;
    matchesName: (name: string) => boolean;
    inScope: (app: string, channel: string) => boolean;
    // The overview's entry for an app and channel, created on first use: the order of creation is the
    // order of `channels` in the snapshot.
    summaryOf: (app: string, channel: string) => ChannelSummary;
}

const modelPass = function (scope: SnapshotScope, measures: ModelMeasures, performanceNow: number): { models: ModelRow[]; total: number } {
    const { store, query, matchesName, inScope, summaryOf } = scope;
    const models: ModelRow[] = [];
    let total = 0;
    for (const { app, channel, models: entries } of store.channels()) {
        if (entries.size > 0) summaryOf(app, channel).models = entries.size;
        if (!inScope(app, channel)) continue;

        const channelMatches = matchesName(channel);
        for (const [id, entry] of entries) {
            if (!channelMatches && !matchesName(id)) continue;
            total += 1;
            if (total <= query.offset || models.length >= query.limit) continue;

            models.push({
                app: clip(app),
                channel: clip(channel),
                id: clip(id),
                fields: fieldCount(entry),
                bytes: measures.bytes(entry, performanceNow),
                updatedAt: entry.updatedAt,
                ...truncatedFlag(app, channel, id),
            });
        }
    }
    return { models, total };
};

const tombstonePass = function (scope: SnapshotScope, now: number, performanceNow: number): { deleted: DeletedRow[]; deletedTotal: number } {
    const { store, matchesName, inScope, summaryOf } = scope;
    // liveTombstones comes oldest first per app: each app's newest MAX_DELETED are the candidates.
    const candidates: [string, Readonly<Tombstone>][] = [];
    let deletedTotal = 0;
    for (const app of store.tombstoneApps()) {
        let newest: [string, Readonly<Tombstone>][] = [];
        for (const tombstone of store.liveTombstones(app)) {
            summaryOf(app, tombstone.channel).deleted += 1;
            if (!inScope(app, tombstone.channel)) continue;
            if (!matchesName(tombstone.channel) && !matchesName(tombstone.id)) continue;

            deletedTotal += 1;
            newest.push([app, tombstone]);
            if (newest.length > 2 * MAX_DELETED) newest = newest.slice(-MAX_DELETED);
        }
        // Newest first, which the stable sort below keeps for ids deleted in the same millisecond.
        candidates.push(...newest.slice(-MAX_DELETED).reverse());
    }
    const deleted: DeletedRow[] = candidates
        .sort((a, b) => b[1].deletedAt - a[1].deletedAt)
        .slice(0, MAX_DELETED)
        .map(([app, tombstone]) => ({
            app: clip(app),
            channel: clip(tombstone.channel),
            id: clip(tombstone.id),
            deletedAt: wallClock(tombstone.deletedAt, now, performanceNow),
            ...truncatedFlag(app, tombstone.channel, tombstone.id),
        }));
    return { deleted, deletedTotal };
};

export const modelsSnapshot = function (store: DataStore, query: ModelsQuery, measures = new ModelMeasures()): ModelsSnapshot {
    const now = Date.now();
    const performanceNow = performance.now();
    const filter = query.filter.toLowerCase();

    // The overview: model counts, then tombstone counts, per app and channel.
    const summaries = new Map<string, ChannelSummary>();
    const scope: SnapshotScope = {
        store,
        query,
        matchesName: name => filter === '' || name.toLowerCase().includes(filter),
        inScope: (app, channel) => (query.app === '' || app === query.app) && (query.channel === '' || channel === query.channel),
        summaryOf: (app, channel) => {
            const key = `${app}\u0000${channel}`;
            let summary = summaries.get(key);
            if (!summary) {
                summary = { app: clip(app), channel: clip(channel), models: 0, deleted: 0, ...truncatedFlag(app, channel) };
                summaries.set(key, summary);
            }
            return summary;
        },
    };

    const { models, total } = modelPass(scope, measures, performanceNow);
    const { deleted, deletedTotal } = tombstonePass(scope, now, performanceNow);

    const channels = Array.from(summaries.values()).filter(summary => summary.models > 0 || summary.deleted > 0);
    return {
        at: now,
        query,
        channels: channels.slice(0, MAX_CHANNELS),
        channelsTotal: channels.length,
        models,
        total,
        deleted,
        deletedTotal,
        tombstoneSeconds: store.tombstoneMillis / 1000,
    };
};
