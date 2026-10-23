import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fileURLToPath } from 'url';
import { DataStore } from '../../src/server/modules/models/data-store.js';
import { RingBuffer } from '../../src/server/modules/core/ring-buffer.js';
import { UNKNOWN_BUILD } from '../../src/server/modules/core/build-info.js';
import type { CertificateInfo } from '../../src/server/modules/tls/tls-files.js';
import { readServerVersion } from '../../src/server/modules/core/server-version.js';
import type { ClientActivity } from '../../src/server/modules/limits/client-activity.js';
import { PROTOCOL_VERSION } from '../../src/server/modules/protocol/protocol.js';
import type { SocketIoClient } from '../../src/server/modules/socket-io/socket-io-server.js';
import type { TcpNetworkClient } from '../../src/server/modules/tcp/tcp-server-proxy.js';
import type {
    ServerSources,
} from '../../src/server/modules/admin/admin-topics.js';
import {
    DEFAULT_MODELS_LIMIT,
    LATENCY_HISTORY_MILLIS,
    MAX_CHANNELS,
    MAX_CLIENT_ROWS,
    MAX_DELETED,
    MAX_FILTER_LENGTH,
    MAX_LATENCY_HISTORY_SAMPLES,
    MAX_MODELS_LIMIT,
    MAX_MODEL_JSON_LENGTH,
    MAX_NAME_LENGTH,
    RATE_HISTORY_SECONDS,
    clientsSnapshot,
    latencySnapshot,
    modelSnapshot,
    modelsSnapshot,
    parseModelQuery,
    parseModelsQuery,
    rateHistory,
    recentLatency,
    serverSnapshot,
} from '../../src/server/modules/admin/admin-topics.js';
import { MODEL_SIZE_REFRESH_MILLIS, ModelMeasures } from '../../src/server/modules/admin/model-measures.js';

const query = (fields: Record<string, unknown> = {}) => parseModelsQuery(fields);

// Everything the store holds, as a snapshot can see it: models, their update times and the
// tombstones, expired ones included. The admin UI's snapshots must leave all of it as it was.
const storeState = function (store: DataStore): string {
    const channels = Array.from(store.channels(), ({ app, channel, models }) => [
        app,
        channel,
        Array.from(models, ([id, entry]) => [id, JSON.stringify(entry.model), entry.updatedAt]),
    ]);
    const tombstones = store.tombstoneApps().map(app => [app, store.tombstoneCount(app)]);
    return JSON.stringify({ channels, tombstones });
};

describe('admin UI topics', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('the model list query', () => {
        it('takes each field only with the expected type, and clamps the page', () => {
            expect(parseModelsQuery(undefined)).toEqual({ app: '', channel: '', filter: '', offset: 0, limit: DEFAULT_MODELS_LIMIT });
            expect(parseModelsQuery({ app: 1, channel: null, filter: ['x'], offset: 'a', limit: {} }))
                .toEqual({ app: '', channel: '', filter: '', offset: 0, limit: DEFAULT_MODELS_LIMIT });
            expect(parseModelsQuery({ offset: -5, limit: 1e9 })).toMatchObject({ offset: 0, limit: MAX_MODELS_LIMIT });
            expect(parseModelsQuery({ offset: 2.7, limit: 0 })).toMatchObject({ offset: 2, limit: 1 });
            expect(parseModelsQuery({ filter: 'f'.repeat(MAX_FILTER_LENGTH + 10) }).filter).toHaveLength(MAX_FILTER_LENGTH);
            expect(parseModelQuery({ app: 'a', channel: 'c', id: 7 })).toEqual({ app: 'a', channel: 'c', id: '' });
        });

        it('cuts a name longer than any row can name, which then matches nothing', () => {
            const store = new DataStore();
            const long = 'a'.repeat(MAX_NAME_LENGTH + 1);
            store.updateModel(long + 'more', long, { id: long });

            const huge = 'A'.repeat(1_000_000);
            const snapshot = modelsSnapshot(store, parseModelsQuery({ app: huge, channel: huge }));
            expect(snapshot.query).toMatchObject({ app: 'A'.repeat(MAX_NAME_LENGTH + 1), channel: 'A'.repeat(MAX_NAME_LENGTH + 1) });
            expect(JSON.stringify(snapshot).length).toBeLessThan(4 * 1024);

            // the cut name of a longer one is not that name
            expect(modelsSnapshot(store, parseModelsQuery({ app: long + 'more' })).total).toBe(0);
            expect(parseModelQuery({ app: huge, channel: huge, id: huge })).toEqual({ app: huge.slice(0, MAX_NAME_LENGTH + 1), channel: huge.slice(0, MAX_NAME_LENGTH + 1), id: huge.slice(0, MAX_NAME_LENGTH + 1) });
            expect(modelSnapshot(store, parseModelQuery({ app: long + 'more', channel: long, id: long }))).toMatchObject({ found: false });
        });
    });

    describe('the model list', () => {
        let store: DataStore;

        beforeEach(() => {
            store = new DataStore();
            store.updateModel('app1', 'cubes', { id: 'cube-1', x: 1, y: 2 });
            vi.advanceTimersByTime(1000);
            store.updateModel('app1', 'cubes', { id: 'cube-2', x: 1 });
            store.updateModel('app1', 'Spheres', { id: 'sphere-1' });
            store.updateModel('app2', 'cubes', { id: 'cube-1', color: 'red' });
        });

        it('lists the models in store order with their fields, size and update time', () => {
            const snapshot = modelsSnapshot(store, query());

            expect(snapshot.total).toBe(4);
            expect(snapshot.models).toEqual([
                { app: 'app1', channel: 'cubes', id: 'cube-1', fields: 2, bytes: '{"id":"cube-1","x":1,"y":2}'.length, updatedAt: 1_700_000_000_000 },
                { app: 'app1', channel: 'cubes', id: 'cube-2', fields: 1, bytes: '{"id":"cube-2","x":1}'.length, updatedAt: 1_700_000_001_000 },
                { app: 'app1', channel: 'Spheres', id: 'sphere-1', fields: 0, bytes: '{"id":"sphere-1"}'.length, updatedAt: 1_700_000_001_000 },
                { app: 'app2', channel: 'cubes', id: 'cube-1', fields: 1, bytes: '{"id":"cube-1","color":"red"}'.length, updatedAt: 1_700_000_001_000 },
            ]);
            expect(snapshot.channels).toEqual([
                { app: 'app1', channel: 'cubes', models: 2, deleted: 0 },
                { app: 'app1', channel: 'Spheres', models: 1, deleted: 0 },
                { app: 'app2', channel: 'cubes', models: 1, deleted: 0 },
            ]);
            expect(snapshot.at).toBe(Date.now());
        });

        it('narrows to an app and a channel', () => {
            expect(modelsSnapshot(store, query({ app: 'app1' })).models.map(m => m.id)).toEqual(['cube-1', 'cube-2', 'sphere-1']);
            expect(modelsSnapshot(store, query({ app: 'app1', channel: 'cubes' })).models.map(m => m.id)).toEqual(['cube-1', 'cube-2']);
            expect(modelsSnapshot(store, query({ channel: 'cubes' })).models.map(m => `${m.app}/${m.id}`))
                .toEqual(['app1/cube-1', 'app1/cube-2', 'app2/cube-1']);
            // The overview always covers everything, for choosing an app and channel.
            expect(modelsSnapshot(store, query({ app: 'app2' })).channels).toHaveLength(3);
        });

        it('filters by part of the id or the channel, in any case', () => {
            expect(modelsSnapshot(store, query({ filter: 'CUBE-2' })).models.map(m => m.id)).toEqual(['cube-2']);
            expect(modelsSnapshot(store, query({ filter: 'spheres' })).models.map(m => m.id)).toEqual(['sphere-1']);
            const none = modelsSnapshot(store, query({ filter: 'nothing' }));
            expect(none.models).toEqual([]);
            expect(none.total).toBe(0);
        });

        it('pages through the matches', () => {
            const page = modelsSnapshot(store, query({ offset: 1, limit: 2 }));
            expect(page.models.map(m => `${m.app}/${m.id}`)).toEqual(['app1/cube-2', 'app1/sphere-1']);
            expect(page.total).toBe(4);
            expect(page.query).toMatchObject({ offset: 1, limit: 2 });
        });

        it('lists recently deleted ids, newest first, with when they were deleted', () => {
            store.tombstoneMillis = 60_000;
            store.removeModel('app1', 'cubes', 'cube-2');
            vi.advanceTimersByTime(5000);
            store.removeModel('app2', 'cubes', 'cube-1');
            store.removeModel('app3', 'gone', 'g');

            const snapshot = modelsSnapshot(store, query());
            expect(snapshot.deleted).toEqual([
                { app: 'app2', channel: 'cubes', id: 'cube-1', deletedAt: Date.now() },
                { app: 'app3', channel: 'gone', id: 'g', deletedAt: Date.now() },
                { app: 'app1', channel: 'cubes', id: 'cube-2', deletedAt: Date.now() - 5000 },
            ].sort((a, b) => b.deletedAt - a.deletedAt || 0));
            expect(snapshot.deletedTotal).toBe(3);
            expect(snapshot.tombstoneSeconds).toBe(60);
            expect(snapshot.channels).toEqual([
                { app: 'app1', channel: 'cubes', models: 1, deleted: 1 },
                { app: 'app1', channel: 'Spheres', models: 1, deleted: 0 },
                // Empty now, but with a tombstone.
                { app: 'app2', channel: 'cubes', models: 0, deleted: 1 },
                { app: 'app3', channel: 'gone', models: 0, deleted: 1 },
            ]);
            expect(modelsSnapshot(store, query({ app: 'app1' })).deleted.map(d => d.id)).toEqual(['cube-2']);
            expect(modelsSnapshot(store, query({ filter: 'G' })).deleted.map(d => d.id)).toEqual(['g']);
        });

        it('leaves expired tombstones out, without forgetting them', () => {
            store.tombstoneMillis = 1000;
            store.removeModel('app1', 'cubes', 'cube-2');
            vi.advanceTimersByTime(1000);

            const snapshot = modelsSnapshot(store, query());
            expect(snapshot.deleted).toEqual([]);
            expect(snapshot.deletedTotal).toBe(0);
            expect(store.tombstoneCount('app1')).toBe(1);
        });

        it('changes nothing in the store', () => {
            store.tombstoneMillis = 1000;
            store.removeModel('app1', 'cubes', 'cube-2');
            vi.advanceTimersByTime(1000);
            store.removeModel('app2', 'cubes', 'cube-1');
            const before = storeState(store);

            modelsSnapshot(store, query({ filter: 'c' }));
            modelsSnapshot(store, query({ app: 'app1', channel: 'cubes', offset: 1 }));
            modelSnapshot(store, { app: 'app1', channel: 'cubes', id: 'cube-1' });
            modelSnapshot(store, { app: 'app1', channel: 'cubes', id: 'cube-2' });

            expect(storeState(store)).toBe(before);
        });
    });

    describe('a large store', () => {
        it('holds at most a page of models and MAX_DELETED deleted ids, and counts the rest', () => {
            const store = new DataStore();
            for (let i = 0; i < 1000; i++) store.updateModel('app', `channel-${i % 10}`, { id: `m${i}` });
            for (let i = 0; i < MAX_DELETED + 50; i++) {
                store.removeModel(`app-${i % 3}`, 'deleted', `d${i}`);
                vi.advanceTimersByTime(1);
            }

            const snapshot = modelsSnapshot(store, query({ limit: 10_000 }));
            expect(snapshot.models).toHaveLength(MAX_MODELS_LIMIT);
            expect(snapshot.total).toBe(1000);
            expect(snapshot.deleted).toHaveLength(MAX_DELETED);
            expect(snapshot.deletedTotal).toBe(MAX_DELETED + 50);
            // The newest ones, across the apps.
            expect(snapshot.deleted.map(d => d.id)).toContain(`d${MAX_DELETED + 49}`);
            expect(snapshot.deleted.map(d => d.id)).not.toContain('d0');
        });

        it('lists at most MAX_CHANNELS channels', () => {
            const store = new DataStore();
            for (let i = 0; i < MAX_CHANNELS + 20; i++) store.updateModel('app', `channel-${i}`, { id: 'x' });

            const snapshot = modelsSnapshot(store, query());
            expect(snapshot.channels).toHaveLength(MAX_CHANNELS);
            expect(snapshot.channelsTotal).toBe(MAX_CHANNELS + 20);
        });

        it('cuts long names and says so', () => {
            const store = new DataStore();
            const long = 'n'.repeat(MAX_NAME_LENGTH + 100);
            store.updateModel('app', long, { id: long });

            const snapshot = modelsSnapshot(store, query());
            expect(snapshot.models[0]).toMatchObject({ channel: 'n'.repeat(MAX_NAME_LENGTH), id: 'n'.repeat(MAX_NAME_LENGTH), truncated: true });
            expect(snapshot.channels[0]).toMatchObject({ channel: 'n'.repeat(MAX_NAME_LENGTH), truncated: true });
        });

        it('measures sizes from a budget per second that every snapshot shares, leaving the rest out', () => {
            const store = new DataStore();
            // 700 bytes each
            const big = 'x'.repeat(680);
            for (let i = 0; i < 4; i++) store.updateModel('app', 'big', { id: `b${i}`, big });
            const measures = new ModelMeasures(1000);

            // 1000 bytes a second: the first model, and the second while any of it is left, which
            // leaves the budget 400 bytes in debt.
            expect(modelsSnapshot(store, query(), measures).models.map(m => m.bytes === null)).toEqual([false, false, true, true]);
            // Nothing left for another snapshot in the same second.
            expect(modelsSnapshot(store, query(), measures).models.map(m => m.bytes === null)).toEqual([false, false, true, true]);
            vi.advanceTimersByTime(1000);
            expect(modelsSnapshot(store, query(), measures).models.map(m => m.bytes === null)).toEqual([false, false, false, true]);
        });

        it('shows a changed model\'s last size until MODEL_SIZE_REFRESH_MILLIS after it was measured', () => {
            const store = new DataStore();
            store.updateModel('app', 'c', { id: 'm', text: 'short' });
            const measures = new ModelMeasures();
            const size = () => modelsSnapshot(store, query(), measures).models[0]!.bytes;
            expect(size()).toBe('{"id":"m","text":"short"}'.length);

            store.updateModel('app', 'c', { id: 'm', text: 'longer now' });
            vi.advanceTimersByTime(MODEL_SIZE_REFRESH_MILLIS - 1);
            expect(size()).toBe('{"id":"m","text":"short"}'.length);
            vi.advanceTimersByTime(1);
            expect(size()).toBe('{"id":"m","text":"longer now"}'.length);
        });
    });

    describe('one model', () => {
        it('is sent as indented JSON, with its size and update time', () => {
            const store = new DataStore();
            store.updateModel('app', 'cubes', { id: 'c', pos: { x: 1 } });

            const snapshot = modelSnapshot(store, { app: 'app', channel: 'cubes', id: 'c' });
            expect(snapshot).toEqual({
                at: Date.now(),
                app: 'app',
                channel: 'cubes',
                id: 'c',
                found: true,
                fields: 1,
                bytes: '{"id":"c","pos":{"x":1}}'.length,
                updatedAt: Date.now(),
                json: JSON.stringify({ id: 'c', pos: { x: 1 } }, null, 2),
                truncated: false,
            });
        });

        it('is cut at MAX_MODEL_JSON_LENGTH', () => {
            const store = new DataStore();
            store.updateModel('app', 'big', { id: 'b', text: 'x'.repeat(MAX_MODEL_JSON_LENGTH) });

            const snapshot = modelSnapshot(store, { app: 'app', channel: 'big', id: 'b' });
            expect(snapshot.json).toHaveLength(MAX_MODEL_JSON_LENGTH);
            expect(snapshot.truncated).toBe(true);
            expect(snapshot.bytes).toBeGreaterThan(MAX_MODEL_JSON_LENGTH);
        });

        it('not in the store is not found, with when it was deleted if it was', () => {
            const store = new DataStore();
            store.removeModel('app', 'cubes', 'gone');
            vi.advanceTimersByTime(2000);

            expect(modelSnapshot(store, { app: 'app', channel: 'cubes', id: 'gone' }))
                .toEqual({ at: Date.now(), app: 'app', channel: 'cubes', id: 'gone', found: false, deletedAt: Date.now() - 2000 });
            expect(modelSnapshot(store, { app: 'app', channel: 'cubes', id: 'never' }))
                .toEqual({ at: Date.now(), app: 'app', channel: 'cubes', id: 'never', found: false });
        });
    });

    describe('the client list', () => {
        const tcpClient = (id: string, app: string): TcpNetworkClient => ({
            id, app, name: `headset-${id}`, version: PROTOCOL_VERSION, metadata: {},
            address: '10.0.0.5', tls: true, tlsAtProxy: false, connectedAt: 1_699_999_990_000,
        });
        const webClient = (id: string, app: string, secure = false, tlsAtProxy = false): SocketIoClient => ({
            id, app, name: '192.168.1.20', version: PROTOCOL_VERSION, metadata: {}, tlsAtProxy,
            socket: { handshake: { secure, issued: 1_699_999_995_000 } } as never,
        });
        const activity: ClientActivity = { in: 72.04, out: 143.96, limit: 'rate', held: 3 };

        it('lists both transports with their details and traffic, but not the admin UI', () => {
            const snapshot = clientsSnapshot({
                tcpClients: [ tcpClient('t1', 'app') ],
                tcpActivity: new Map([[ 't1', activity ]]),
                webClients: [ webClient('w1', 'app', true), webClient('admin', 'colibri') ],
                webActivity: () => ({ in: null, out: 0, limit: null, held: 0 }),
            });

            expect(snapshot).toEqual({
                at: Date.now(),
                total: 2,
                adminPages: 1,
                clients: [
                    {
                        id: 't1', app: 'app', name: 'headset-t1', transport: 'tcp', version: PROTOCOL_VERSION, tls: true, tlsAtProxy: false,
                        address: '10.0.0.5', connectedAt: 1_699_999_990_000, latency: null, in: 72, out: 144, limit: 'rate', held: 3,
                    },
                    {
                        id: 'w1', app: 'app', name: '192.168.1.20', transport: 'web', version: PROTOCOL_VERSION, tls: true, tlsAtProxy: false,
                        address: '192.168.1.20', connectedAt: 1_699_999_995_000, latency: null, in: null, out: 0, limit: null, held: 0,
                    },
                ],
            });
        });

        it('says which clients reached a trusted proxy over TLS, apart from TLS to this server', () => {
            const snapshot = clientsSnapshot({
                // the second through a proxy that TCP_TLS_AT_PROXY says ends TLS
                tcpClients: [ { ...tcpClient('t1', 'app'), tls: false }, { ...tcpClient('t2', 'app'), tls: false, tlsAtProxy: true } ],
                tcpActivity: new Map(),
                webClients: [ webClient('plain', 'app'), webClient('proxied', 'app', false, true), webClient('direct', 'app', true) ],
                webActivity: () => activity,
            });

            expect(snapshot.clients.map(row => [ row.id, row.tls, row.tlsAtProxy ])).toEqual([
                [ 't1', false, false ],
                [ 't2', false, true ],
                [ 'plain', false, false ],
                [ 'proxied', false, true ],
                [ 'direct', true, false ],
            ]);
        });

        it('has no activity for a TCP client the worker did not report', () => {
            const snapshot = clientsSnapshot({
                tcpClients: [ tcpClient('t1', 'app') ],
                tcpActivity: new Map(),
                webClients: [],
                webActivity: () => activity,
            });
            expect(snapshot.clients[0]).toMatchObject({ in: null, out: null, limit: null, held: 0 });
        });

        it('gives each row its rate history only when asked, for TCP clients from the worker\'s report', () => {
            const now = Date.now();
            const snapshot = clientsSnapshot({
                tcpClients: [ tcpClient('t1', 'app'), tcpClient('t2', 'app') ],
                tcpActivity: new Map([[ 't1', { ...activity, history: [ [ now - 2000, 1.04, 2 ], [ now - 1000, 3, 4 ] ] } ]]),
                webClients: [ webClient('w1', 'app') ],
                webActivity: () => ({ ...activity, history: [ [ now - 1500, 5, 6 ] ] }),
            }, true);

            // t2 the worker did not report on this time
            expect(snapshot.clients.map(row => [ row.id, row.history ])).toEqual([
                [ 't1', [ [ 1, 2 ], [ 3, 4 ] ] ],
                [ 't2', [] ],
                [ 'w1', [ [ 5, 6 ] ] ],
            ]);
        });

        it('holds at most MAX_CLIENT_ROWS clients', () => {
            const tcpClients = Array.from({ length: MAX_CLIENT_ROWS + 5 }, (_, i) => tcpClient(`t${i}`, 'app'));
            const snapshot = clientsSnapshot({ tcpClients, tcpActivity: new Map(), webClients: [], webActivity: () => activity });
            expect(snapshot.clients).toHaveLength(MAX_CLIENT_ROWS);
            expect(snapshot.total).toBe(MAX_CLIENT_ROWS + 5);
        });

        it('gives the rates a page would have been sent in each second before now, from the first with one', () => {
            const now = Date.now();
            // sampled 1.5 s apart, as by a busy event loop, the newest 300 ms ago
            const samples: [number, number, number][] = Array.from({ length: 5 }, (_, i) => [ now - 300 - (4 - i) * 1500, i, 10 * i ]);
            expect(rateHistory(samples, now)).toEqual([ [ 0, 0 ], [ 0, 0 ], [ 1, 10 ], [ 2, 20 ], [ 2, 20 ], [ 3, 30 ] ]);
            expect(rateHistory([], now)).toEqual([]);

            const long: [number, number, number][] = Array.from({ length: 200 }, (_, i) => [ now - (199 - i) * 1000, i, i ]);
            const history = rateHistory(long, now);
            expect(history).toHaveLength(RATE_HISTORY_SECONDS);
            expect(history.at(-1)).toEqual([ 198, 198 ]);
        });

        it('takes the median latency of the last second', () => {
            const client = tcpClient('t1', 'app');
            const samples = new RingBuffer<[number, number]>(1000);
            const now = Date.now();
            samples.push([ now - 5000, 900 ]);
            for (const [ago, ms] of [ [ 900, 30 ], [ 500, 10 ], [ 300, 20 ], [ 100, 40 ] ]) samples.push([ now - ago!, ms! ]);
            client.metadata['latency'] = samples;

            expect(recentLatency(client, now)).toBe(25);
            expect(recentLatency(client, now + 10_000)).toBeNull();
            expect(recentLatency(tcpClient('t2', 'app'), now)).toBeNull();
        });
    });

    describe('the latency history', () => {
        const client = (id: string, app = 'app'): SocketIoClient => ({
            id, app, name: '192.168.1.20', version: PROTOCOL_VERSION, metadata: {}, tlsAtProxy: false,
            socket: { handshake: { secure: false, issued: 0 } } as never,
        });
        // A sample every 100 ms over the last `seconds`, up to and including now, as MeasureLatency keeps them.
        const pinged = function <T extends { metadata: Record<string, unknown> }>(target: T, seconds: number, ms = (i: number) => 10 + i / 3): T {
            const samples = new RingBuffer<[number, number]>(1250);
            const now = Date.now();
            for (let i = 0; i <= seconds * 10; i++) samples.push([ now - seconds * 1000 + i * 100, ms(i) ]);
            target.metadata['latency'] = samples;
            return target;
        };

        it('sends each client\'s samples of the window before now, to 0.01 ms, but not the admin UI\'s', () => {
            const tcp = pinged(client('t1'), 200);
            const now = Date.now();
            const snapshot = latencySnapshot({ tcpClients: [ tcp ], webClients: [ client('w1'), pinged(client('admin', 'colibri'), 5) ] });

            expect(snapshot).toMatchObject({ at: now, total: 2, medians: false });
            expect(snapshot.clients.map(c => c.id)).toEqual([ 't1', 'w1' ]);
            const samples = snapshot.clients[0]!.samples;
            // from the start of the window, up to the one taken now, which colibri::latency brings
            expect(samples).toHaveLength(LATENCY_HISTORY_MILLIS / 100);
            expect(samples.slice(0, 2)).toEqual([ [ now - LATENCY_HISTORY_MILLIS, 270 ], [ now - LATENCY_HISTORY_MILLIS + 100, 270.33 ] ]);
            expect(samples.at(-1)![0]).toBe(now - 100);
            expect(snapshot.clients[1]!.samples).toEqual([]);
        });

        it('sends per-second medians past MAX_LATENCY_HISTORY_SAMPLES, at the mean time of each second', () => {
            const count = Math.ceil(MAX_LATENCY_HISTORY_SAMPLES / (LATENCY_HISTORY_MILLIS / 100)) + 1;
            const tcpClients = Array.from({ length: count }, (_, i) => pinged(client(`t${i}`), 125, j => j % 10));
            const now = Date.now();
            const snapshot = latencySnapshot({ tcpClients, webClients: [] });

            expect(snapshot.medians).toBe(true);
            const medians = snapshot.clients[0]!.samples;
            expect(medians).toHaveLength(LATENCY_HISTORY_MILLIS / 1000);
            // a second's samples are 0 to 9 ms, 100 ms apart from its start
            expect(medians.at(-1)).toEqual([ now - 1000 + 450, 4.5 ]);
            expect(snapshot.clients.reduce((sum, c) => sum + c.samples.length, 0)).toBeLessThan(MAX_LATENCY_HISTORY_SAMPLES);
        });

        it('holds at most MAX_CLIENT_ROWS clients, whose medians stay under MAX_LATENCY_HISTORY_SAMPLES', () => {
            const tcp = pinged(client('t'), 125);
            const tcpClients = Array.from({ length: MAX_CLIENT_ROWS + 5 }, (_, i) => ({ ...tcp, id: `t${i}` }));
            const snapshot = latencySnapshot({ tcpClients, webClients: [] });

            expect(snapshot.total).toBe(MAX_CLIENT_ROWS + 5);
            expect(snapshot.clients).toHaveLength(MAX_CLIENT_ROWS);
            expect(snapshot.medians).toBe(true);
            const sent = snapshot.clients.reduce((sum, c) => sum + c.samples.length, 0);
            expect(sent).toBeLessThanOrEqual(MAX_LATENCY_HISTORY_SAMPLES);
            expect(sent).toBe(MAX_CLIENT_ROWS * LATENCY_HISTORY_MILLIS / 1000);
        });
    });

    describe('the server info', () => {
        const info: CertificateInfo = {
            fingerprint256: 'AB:CD',
            names: 'DNS:colibri.example.org',
            issuer: 'CN=Example CA',
            validFrom: new Date(1_690_000_000_000),
            validTo: new Date(1_710_000_000_000),
            selfSigned: false,
        };

        const sources = (overrides: Partial<ServerSources> = {}): ServerSources => ({
            version: '2.0.0',
            build: { commit: '3e2855e0c1d2b3a4f5e6d7c8b9a0f1e2d3c4b5a6', dirty: true, builtAt: 1_699_990_000_000 },
            startedAt: Date.now() - 90_500,
            settings: { TCP_PORT: 9212, TRUSTED_PROXIES: [ 'loopback' ], TCP_PROXY_PROTOCOL: true },
            tls: undefined,
            proxyTls: undefined,
            tcpTlsAtProxy: false,
            voice: { listening: true, recording: false, samplingRate: 48000, clients: 2 },
            store: new DataStore(),
            restStore: { apps: 2, keys: 5, bytes: 300 },
            tcpClients: [],
            webClients: [],
            ...overrides,
        });

        it('says which commit it was built from, or that the build did not say', () => {
            expect(serverSnapshot(sources({ build: UNKNOWN_BUILD })).build).toEqual({ commit: null, dirty: false, builtAt: null });
        });

        it('says which version runs, since when, and with which settings', () => {
            const snapshot = serverSnapshot(sources());
            expect(snapshot).toMatchObject({
                at: Date.now(),
                version: '2.0.0',
                protocolVersion: PROTOCOL_VERSION,
                node: process.version,
                build: { commit: '3e2855e0c1d2b3a4f5e6d7c8b9a0f1e2d3c4b5a6', dirty: true, builtAt: 1_699_990_000_000 },
                startedAt: Date.now() - 90_500,
                uptime: 91,
                settings: { TCP_PORT: 9212, TRUSTED_PROXIES: [ 'loopback' ], TCP_PROXY_PROTOCOL: true },
                tls: null,
                tlsAtProxy: { web: false, tcp: false },
                voice: { listening: true, recording: false, samplingRate: 48000, clients: 2 },
            });
        });

        it('says whether a web client or admin page connected now reached a trusted proxy over TLS', () => {
            const web = (id: string, app: string, tlsAtProxy: boolean) => ({ id, app, tlsAtProxy } as SocketIoClient);

            expect(serverSnapshot(sources({ webClients: [ web('w1', 'app1', false), web('a1', 'colibri', false) ] })).tlsAtProxy)
                .toEqual({ web: false, tcp: false });
            expect(serverSnapshot(sources({ webClients: [ web('w1', 'app1', true), web('a1', 'colibri', false) ] })).tlsAtProxy)
                .toEqual({ web: true, tcp: false });
            // the admin page asking, with no other web client
            expect(serverSnapshot(sources({ webClients: [ web('a1', 'colibri', true) ] })).tlsAtProxy).toEqual({ web: true, tcp: false });
            expect(serverSnapshot(sources()).tlsAtProxy).toEqual({ web: false, tcp: false });
        });

        it('passes on the proxy\'s certificates, with the addresses that presented them, and the ones it could not check', () => {
            expect(serverSnapshot(sources()).proxyTls).toBeNull();
            expect(serverSnapshot(sources({ proxyTls: [] })).proxyTls).toEqual([]);

            const proxyTls = serverSnapshot(sources({
                proxyTls: [
                    { addresses: [ 'colibri.example.org:443', 'colibri.example.org:9212' ], checkedAt: 1_700_000_000_000,
                        certificate: { ...info, trusted: true } },
                    { addresses: [ 'colibri.example.org:9012' ], checkedAt: 1_700_000_000_000, error: 'connect ECONNREFUSED' },
                ],
            })).proxyTls;

            expect(proxyTls).toEqual([
                {
                    addresses: [ 'colibri.example.org:443', 'colibri.example.org:9212' ], checkedAt: 1_700_000_000_000, error: null,
                    certificate: {
                        names: info.names, issuer: info.issuer, selfSigned: false, fingerprint256: info.fingerprint256,
                        validFrom: info.validFrom.getTime(), validTo: info.validTo.getTime(), trusted: true, trustError: null,
                    },
                },
                { addresses: [ 'colibri.example.org:9012' ], checkedAt: 1_700_000_000_000, certificate: null, error: 'connect ECONNREFUSED' },
            ]);
        });

        // Declared by the operator, so it holds with no Unity client connected, and apart from web.
        it('says whether TCP_TLS_AT_PROXY applies, whoever is connected', () => {
            expect(serverSnapshot(sources({ tcpTlsAtProxy: true })).tlsAtProxy).toEqual({ web: false, tcp: true });
            const web = { id: 'w1', app: 'app1', tlsAtProxy: true } as SocketIoClient;
            expect(serverSnapshot(sources({ tcpTlsAtProxy: true, webClients: [ web ] })).tlsAtProxy).toEqual({ web: true, tcp: true });
        });

        it('describes the certificate, and nothing of its key or files', () => {
            const snapshot = serverSnapshot(sources({ tls: info }));
            expect(snapshot.tls).toEqual({
                names: 'DNS:colibri.example.org',
                issuer: 'CN=Example CA',
                selfSigned: false,
                validFrom: 1_690_000_000_000,
                validTo: 1_710_000_000_000,
                fingerprint256: 'AB:CD',
            });
            expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE KEY|BEGIN CERTIFICATE|\.pem/);
        });

        it('counts the clients, apps, models and store values', () => {
            const store = new DataStore();
            store.updateModel('app1', 'a', { id: '1' });
            store.updateModel('app1', 'b', { id: '2' });
            store.updateModel('app2', 'a', { id: '3' });
            store.removeModel('app2', 'a', '3');
            const web = (id: string, app: string) => ({ id, app } as SocketIoClient);
            const tcp = (id: string, app: string) => ({ id, app } as TcpNetworkClient);

            const snapshot = serverSnapshot(sources({
                store,
                tcpClients: [ tcp('t1', 'app1'), tcp('t2', 'app3') ],
                webClients: [ web('w1', 'app1'), web('a1', 'colibri'), web('a2', 'colibri') ],
            }));
            expect(snapshot.counts).toEqual({
                tcpClients: 2,
                webClients: 1,
                adminPages: 2,
                apps: 2,
                models: 2,
                modelApps: 1,
                modelChannels: 2,
                deletedModels: 1,
                storeApps: 2,
                storeKeys: 5,
                storeBytes: 300,
            });
        });
    });
});

describe('readServerVersion', () => {
    it('reads the version from package.json, and says unknown without one', () => {
        expect(readServerVersion(fileURLToPath(new URL('../../package.json', import.meta.url)))).toMatch(/^\d+\.\d+\.\d+/);
        expect(readServerVersion('/nonexistent/package.json')).toBe('unknown');
    });
});
