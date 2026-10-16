import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { Router, Request, RequestHandler, Response } from 'express';
import { Subscription } from 'rxjs';
import { LogLevel, LogMessage, Service } from '../../src/server/modules/core/index.js';
import { RestAPI, RestStoreOptions } from '../../src/server/modules/web/rest-api.js';
import { StoreDatabase } from '../../src/server/modules/web/store-database.js';
import { REST_MEDIA_TYPE } from '../../src/server/modules/networking/protocol.js';
import type { WebServer } from '../../src/server/modules/web/web-server.js';

// A store.json in the format every earlier version wrote, including a value name
// ('constructor') that the old object-backed store could persist as an own key.
const FIXTURE_STORE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'store.json');
// That store.json cut off after 140 bytes, as a write interrupted part way leaves it.
const TRUNCATED_STORE = path.join(path.dirname(FIXTURE_STORE), 'store-truncated.json');

// Names that are also members of Object.prototype (or, for '__proto__', its accessor).
const PROTOTYPE_NAMES = [ '__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf', '__defineGetter__' ];

// Captures the router RestAPI registers, so the routes can be driven without binding a port.
class FakeWebServer {
    public router: Router | undefined;

    public addApi(url: string, handler: RequestHandler | Router): void {
        expect(url).toBe('/store');
        this.router = handler as Router;
    }

    public asWebServer(): WebServer {
        return this as unknown as WebServer;
    }
}

interface Result {
    status: number;
    body: unknown;
}

const call = function (router: Router, method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Result> {
    return new Promise<Result>((resolve, reject) => {
        const req = { method, url, body, headers } as unknown as Request;

        let status = 200;
        const res = {
            status(code: number) {
                status = code;
                return this;
            },
            json(payload: unknown) {
                resolve({ status, body: payload });
                return this;
            },
        } as unknown as Response;

        router(req, res, (err?: unknown) => {
            if (err) reject(err);
            else resolve({ status: 404, body: undefined });
        });
    });
};

// SQLite's order for TEXT, byte by byte in UTF-8, in which the store lists apps and names.
const keyOrder = (names: string[]): string[] => [ ...names ].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));

describe('RestAPI', () => {
    let dataPath: string;
    let storePath: string;
    let databasePath: string;
    let webserver: FakeWebServer;
    let api: RestAPI;
    let logs: LogMessage[];
    let subscription: Subscription;
    const instances: RestAPI[] = [];

    const create = (options: RestStoreOptions = {}, server = new FakeWebServer()): RestAPI => {
        const instance = new RestAPI(dataPath, server.asWebServer(), options);
        instances.push(instance);
        return instance;
    };

    // As both clients send it: the value as JSON, in the store's media type.
    const put = (url: string, body: unknown, contentType = REST_MEDIA_TYPE) =>
        call(webserver.router!, 'PUT', url, body, { 'content-type': contentType });
    const get = (url: string) => call(webserver.router!, 'GET', url);
    const del = (url: string) => call(webserver.router!, 'DELETE', url);

    const logged = (level: LogLevel) => logs.filter(l => l.origin === 'RestAPI' && l.level === level).map(l => l.message);
    const dataFiles = async () => (await readdir(dataPath)).filter(name => !name.startsWith('store.db')).sort();

    // What store.db holds, read as store-export.js reads it.
    const stored = (): Record<string, Record<string, unknown>> => {
        const db = StoreDatabase.openReadOnly(databasePath);
        try {
            const result: Record<string, Record<string, unknown>> = {};
            for (const [ app, name, json ] of db.entries()) {
                (result[app] ??= {})[name] = JSON.parse(json);
            }
            return result;
        } finally {
            db.close();
        }
    };

    // Stops `api` and starts a new instance on the same data folder, as a restart does.
    const restart = async (options: RestStoreOptions = {}): Promise<void> => {
        await api.close();
        webserver = new FakeWebServer();
        api = create(options, webserver);
        await api.init();
    };

    beforeEach(async () => {
        dataPath = await mkdtemp(path.join(tmpdir(), 'colibri-rest-api-'));
        storePath = path.join(dataPath, 'store.json');
        databasePath = path.join(dataPath, 'store.db');
        webserver = new FakeWebServer();
        api = create({}, webserver);
        logs = [];
        subscription = Service.output$.subscribe(msg => logs.push(msg));
    });

    afterEach(async () => {
        subscription.unsubscribe();
        vi.useRealTimers();
        for (const instance of instances.splice(0)) await instance.close();
        await rm(dataPath, { recursive: true, force: true });
    });

    describe('routes', () => {
        beforeEach(async () => {
            await api.init();
        });

        it('creates an app and value with 201, then returns them', async () => {
            await expect(put('/appA/key', { x: 1 })).resolves.toMatchObject({ status: 201 });
            await expect(put('/appA/key', { x: 2 })).resolves.toMatchObject({ status: 200 });

            await expect(get('/')).resolves.toEqual({ status: 200, body: ['appA'] });
            await expect(get('/appA')).resolves.toEqual({ status: 200, body: ['key'] });
            await expect(get('/appA/key')).resolves.toEqual({ status: 200, body: { x: 2 } });
        });

        it('404s for an unknown app or value', async () => {
            await expect(get('/nope')).resolves.toMatchObject({ status: 404 });
            await expect(get('/nope/key')).resolves.toMatchObject({ status: 404 });

            await put('/appA/key', 1);
            await expect(get('/appA/other')).resolves.toMatchObject({ status: 404 });
        });

        it('deletes a value and then the app', async () => {
            await put('/appA/one', 1);
            await put('/appA/two', 2);

            await expect(del('/appA/one')).resolves.toMatchObject({ status: 200 });
            await expect(get('/appA')).resolves.toEqual({ status: 200, body: ['two'] });

            await expect(del('/appA')).resolves.toMatchObject({ status: 200 });
            await expect(get('/appA')).resolves.toMatchObject({ status: 404 });
            await expect(del('/appA')).resolves.toMatchObject({ status: 404 });
        });

        it('stores any JSON value and returns it unchanged', async () => {
            const values = [ 0, -1.5, 'text', '', true, false, null, [], {}, [ 1, 'a', null ], { nested: { list: [ { x: 'ü' } ] } } ];
            for (const [ i, value ] of values.entries()) {
                await expect(put(`/appA/v${i}`, value)).resolves.toMatchObject({ status: 201, body: { data: value } });
            }
            for (const [ i, value ] of values.entries()) {
                await expect(get(`/appA/v${i}`)).resolves.toEqual({ status: 200, body: value });
            }
        });

        // Only the store's media type, parameters aside: application/json and form data get
        // 415, and so does a body without a Content-Type.
        it.each([
            [ 'application/json', 'application/json' ],
            [ 'form data', 'application/x-www-form-urlencoded' ],
            [ 'no Content-Type', '' ],
        ])('refuses a value sent as %s with 415, and stores nothing', async (_, contentType) => {
            await expect(put('/appA/key', { x: 1 }, contentType)).resolves.toEqual({
                status: 415,
                body: { error: `Value with name key not saved: send the value as JSON, with Content-Type: ${REST_MEDIA_TYPE}` },
            });
            await expect(get('/appA')).resolves.toMatchObject({ status: 404 });
        });

        it('takes the media type with parameters and in any case', async () => {
            await expect(put('/appA/key', 1, `${REST_MEDIA_TYPE}; charset=utf-8`)).resolves.toMatchObject({ status: 201 });
            await expect(put('/appA/key', 2, REST_MEDIA_TYPE.toUpperCase())).resolves.toMatchObject({ status: 200 });
        });

        // The Maps listed them in the order they were created. The primary key gives key order
        // for free, where creation order would need a sort or another index.
        it('lists apps and names in key order', async () => {
            for (const name of [ 'zeta', 'Alpha', 'beta' ]) {
                await put(`/${name}/${name}`, 1);
                await put(`/appA/${name}`, 1);
            }

            await expect(get('/')).resolves.toEqual({ status: 200, body: [ 'Alpha', 'appA', 'beta', 'zeta' ] });
            await expect(get('/appA')).resolves.toEqual({ status: 200, body: [ 'Alpha', 'beta', 'zeta' ] });
        });

        // For the admin UI's server info.
        it('counts its apps, values and bytes', async () => {
            expect(api.counts()).toEqual({ apps: 0, keys: 0, bytes: 0 });
            await put('/appA/one', 1);
            await put('/appA/two', 'two');
            await put('/appB/one', 1);
            expect(api.counts()).toEqual({ apps: 2, keys: 3, bytes: 1 + 5 + 1 });
        });
    });

    // Every name used to be looked up on a plain object, so a name Object.prototype also has
    // resolved to that member: DELETE /constructor/keys deleted Object.keys process-wide, and
    // PUT /__proto__/x wrote onto Object.prototype.
    describe('names that are also Object.prototype members', () => {
        const originalKeys = Object.keys;
        const originalPrototypeNames = Object.getOwnPropertyNames(Object.prototype);

        beforeEach(async () => {
            await api.init();
        });

        afterEach(() => {
            // Undo what a regression would have done, so it fails only these tests.
            Object.keys = originalKeys;
            for (const name of Object.getOwnPropertyNames(Object.prototype)) {
                if (!originalPrototypeNames.includes(name)) delete (Object.prototype as Record<string, unknown>)[name];
            }
        });

        const expectPrototypesUntouched = () => {
            expect(Object.keys).toBe(originalKeys);
            expect(Object.getOwnPropertyNames(Object.prototype)).toEqual(originalPrototypeNames);
            expect(Object.getPrototypeOf({})).toBe(Object.prototype);
        };

        it('404s for them while nothing is stored, instead of reaching into Object', async () => {
            await expect(get('/constructor')).resolves.toMatchObject({ status: 404 });
            await expect(get('/constructor/keys')).resolves.toMatchObject({ status: 404 });
            await expect(del('/constructor/keys')).resolves.toMatchObject({ status: 404 });
            await expect(del('/constructor')).resolves.toMatchObject({ status: 404 });
            await expect(get('/__proto__')).resolves.toMatchObject({ status: 404 });

            await put('/appA/key', 1);
            for (const name of PROTOTYPE_NAMES) {
                await expect(get(`/appA/${name}`)).resolves.toMatchObject({ status: 404 });
                await expect(del(`/appA/${name}`)).resolves.toMatchObject({ status: 404 });
            }

            expect(typeof Object.keys).toBe('function');
            expectPrototypesUntouched();
        });

        it('round-trips each of them through PUT, GET and DELETE as an ordinary app and value name', async () => {
            for (const name of PROTOTYPE_NAMES) {
                await expect(put(`/${name}/${name}`, { name })).resolves.toMatchObject({ status: 201 });
                await expect(put(`/${name}/${name}`, { name, again: true })).resolves.toMatchObject({ status: 200 });
            }
            for (const name of PROTOTYPE_NAMES) {
                await expect(put(`/appA/${name}`, name)).resolves.toMatchObject({ status: 201 });
            }

            await expect(get('/')).resolves.toEqual({ status: 200, body: keyOrder([ ...PROTOTYPE_NAMES, 'appA' ]) });
            await expect(get('/appA')).resolves.toEqual({ status: 200, body: keyOrder(PROTOTYPE_NAMES) });
            for (const name of PROTOTYPE_NAMES) {
                await expect(get(`/${name}`)).resolves.toEqual({ status: 200, body: [ name ] });
                await expect(get(`/${name}/${name}`)).resolves.toEqual({ status: 200, body: { name, again: true } });
                await expect(get(`/appA/${name}`)).resolves.toEqual({ status: 200, body: name });
            }
            expectPrototypesUntouched();

            for (const name of PROTOTYPE_NAMES) {
                await expect(del(`/${name}/${name}`)).resolves.toMatchObject({ status: 200 });
                await expect(get(`/${name}/${name}`)).resolves.toMatchObject({ status: 404 });
                await expect(del(`/${name}`)).resolves.toMatchObject({ status: 404 });
            }
            await expect(get('/')).resolves.toEqual({ status: 200, body: [ 'appA' ] });
            expectPrototypesUntouched();
        });

        it('does not pollute Object.prototype through __proto__', async () => {
            await expect(put('/__proto__/polluted', { yes: true })).resolves.toMatchObject({ status: 201 });

            expect(({} as Record<string, unknown>).polluted).toBeUndefined();
            expectPrototypesUntouched();
            await expect(get('/__proto__/polluted')).resolves.toEqual({ status: 200, body: { yes: true } });
        });

        it('keeps them across a restart', async () => {
            await put('/__proto__/constructor', 1);
            await put('/constructor/__proto__', { toString: 2 });

            await restart();

            await expect(get('/')).resolves.toEqual({ status: 200, body: [ '__proto__', 'constructor' ] });
            await expect(get('/__proto__/constructor')).resolves.toEqual({ status: 200, body: 1 });
            await expect(get('/constructor/__proto__')).resolves.toEqual({ status: 200, body: { toString: 2 } });
            expectPrototypesUntouched();
        });
    });

    describe('persistence', () => {
        beforeEach(async () => {
            await api.init();
        });

        // store.json was written up to 250 ms after a change, and only at shutdown before that.
        it('has a write in store.db by the time it is answered', async () => {
            await put('/appA/one', 1);
            await put('/appA/two', { x: [ 1, 2 ] });
            await del('/appA/one');

            expect(stored()).toEqual({ appA: { two: { x: [ 1, 2 ] } } });
        });

        it('keeps its values across a restart', async () => {
            await put('/appA/key', { nested: [ 1, 2 ] });
            await put('/appB/key', 'b');
            await del('/appB');

            await restart();

            await expect(get('/')).resolves.toEqual({ status: 200, body: [ 'appA' ] });
            await expect(get('/appA/key')).resolves.toEqual({ status: 200, body: { nested: [ 1, 2 ] } });
            expect(api.counts()).toEqual({ apps: 1, keys: 1, bytes: JSON.stringify({ nested: [ 1, 2 ] }).length });
        });

        it('creates no other file than store.db and its log', async () => {
            await put('/appA/key', 1);
            await restart();

            expect(await dataFiles()).toEqual([]);
            expect((await readdir(dataPath)).sort()).toEqual(expect.arrayContaining([ 'store.db' ]));
        });

        // A store.db that cannot be opened, here a directory in its place, which fails for root too.
        it('keeps its values in memory when store.db cannot be opened, and says so', async () => {
            await api.close();
            await rm(databasePath, { force: true });
            await rm(`${databasePath}-wal`, { force: true });
            await rm(`${databasePath}-shm`, { force: true });
            await mkdir(databasePath);
            await writeFile(storePath, JSON.stringify({ appA: { key: 'from store.json' } }), 'utf8');
            webserver = new FakeWebServer();
            api = create({}, webserver);

            await api.init();

            expect(logged(LogLevel.Error)).toEqual([ expect.stringMatching(
                new RegExp(`^Could not open ${databasePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} for writing: .+\\. The data store keeps `
                    + 'its values in memory, starting with the 1 value\\(s\\) in store\\.json, and saves nothing until the server can write it\\.$')
            ) ]);
            await expect(get('/appA/key')).resolves.toEqual({ status: 200, body: 'from store.json' });
            await expect(put('/appA/other', 2)).resolves.toMatchObject({ status: 201 });
            await expect(get('/appA')).resolves.toEqual({ status: 200, body: [ 'key', 'other' ] });
            // Left where it is: the store is not saved anywhere.
            expect(await dataFiles()).toEqual([ 'store.json' ]);
        });

        // SQLite opens a file it may read but not write read-only, without a word, and only the
        // first write failed: with the expiry sweep at startup, the server did not start at all.
        // Root may write any file, so this needs another user.
        it.skipIf(process.getuid?.() === 0)('serves the values of a store.db it cannot write from memory, and says so', async () => {
            await put('/appA/key', 'kept');
            await api.close();
            await chmod(databasePath, 0o444);
            webserver = new FakeWebServer();
            api = create({ expiryDays: 30 }, webserver);

            await api.init();

            expect(logged(LogLevel.Error)).toEqual([ expect.stringContaining(
                'The data store keeps its values in memory, starting with the 1 value(s) in store.db, and saves nothing'
            ) ]);
            await expect(get('/appA/key')).resolves.toEqual({ status: 200, body: 'kept' });
            await expect(put('/appA/other', 2)).resolves.toMatchObject({ status: 201 });
        });

        // Automatic checkpoints would sync to disk in the middle of a PUT, on the main thread.
        it('leaves checkpoints to its worker thread, which copies the writes into store.db', async () => {
            const before = (await stat(databasePath)).size;
            for (let i = 0; i < 20; i++) await put(`/appA/v${i}`, 'x'.repeat(100_000));

            await vi.waitFor(async () => {
                expect((await stat(databasePath)).size).toBeGreaterThan(before + 1_000_000);
            }, { timeout: 5000, interval: 100 });
            expect(logged(LogLevel.Error)).toEqual([]);
        });
    });

    // Colibri 1.x and the 2.0 development versions kept the store in store.json.
    describe('importing store.json', () => {
        const NOW = Date.UTC(2026, 9, 19, 9, 30);
        const stamp = '2026-10-19T09-30-00.000Z';

        beforeEach(() => {
            api = create({ now: () => NOW }, webserver);
        });

        it('imports it into a new store.db before any request is served, and renames it', async () => {
            await copyFile(FIXTURE_STORE, storePath);
            const fixture = await readFile(FIXTURE_STORE, 'utf8');

            await api.init();

            await expect(get('/')).resolves.toEqual({ status: 200, body: [ 'ExampleUnityApp', 'web-demo' ] });
            await expect(get('/ExampleUnityApp')).resolves.toEqual({ status: 200, body: [ 'constructor', 'exampleObject', 'highscores' ] });
            await expect(get('/ExampleUnityApp/exampleObject')).resolves.toEqual({ status: 200, body: { Id: 1234, Name: 'Charly Sharp' } });
            await expect(get('/ExampleUnityApp/constructor')).resolves.toEqual({
                status: 200,
                body: { note: 'stored as an own value name by the old object-backed store' },
            });
            await expect(get('/web-demo/sampleKey')).resolves.toMatchObject({ status: 200, body: { tags: [ 'a', 'b' ], nothing: null } });

            expect(stored()).toEqual(JSON.parse(fixture));
            expect(await dataFiles()).toEqual([ `store.json.imported-${stamp}` ]);
            await expect(readFile(path.join(dataPath, `store.json.imported-${stamp}`), 'utf8')).resolves.toBe(fixture);
            expect(logged(LogLevel.Info)).toContain(
                `Imported 4 value(s) of 2 app(s) from store.json into store.db, and renamed it to store.json.imported-${stamp}`
            );
            expect(logged(LogLevel.Error)).toEqual([]);
        });

        it('imports app and value names that only a hand-edited store.json can contain', async () => {
            await writeFile(storePath, '{"__proto__":{"__proto__":1,"toString":2}}', 'utf8');
            await api.init();

            await expect(get('/')).resolves.toEqual({ status: 200, body: [ '__proto__' ] });
            await expect(get('/__proto__')).resolves.toEqual({ status: 200, body: [ '__proto__', 'toString' ] });
            await expect(get('/__proto__/__proto__')).resolves.toEqual({ status: 200, body: 1 });
            await expect(get('/__proto__/toString')).resolves.toEqual({ status: 200, body: 2 });
        });

        it('starts empty without one, and creates no file but store.db', async () => {
            await api.init();

            await expect(get('/')).resolves.toEqual({ status: 200, body: [] });
            expect(await dataFiles()).toEqual([]);
        });

        // A store.json that could not be loaded, or only in part, is kept as it was: it is not
        // read again, and nothing overwrites it.
        it.each([
            [ 'a truncated store.json', async () => readFile(TRUNCATED_STORE, 'utf8'), {} ],
            [ 'one that is not JSON', async () => '{not json', {} ],
            [ 'one that is not a JSON object', async () => '[1,2,3]', {} ],
            [ 'one with an app that is not an object', async () => JSON.stringify({ good: { k: 1 }, bad: 42 }), { good: { k: 1 } } ],
        ])('imports what it can of %s and moves the file aside, unchanged', async (_, contents, loaded) => {
            const original = await contents();
            await writeFile(storePath, original, 'utf8');

            await api.init();

            expect(stored()).toEqual(loaded);
            expect(await dataFiles()).toEqual([ `store.json.corrupt-${stamp}` ]);
            await expect(readFile(path.join(dataPath, `store.json.corrupt-${stamp}`), 'utf8')).resolves.toBe(original);
            expect(logged(LogLevel.Error).at(-1)).toContain(`Moved ${storePath} to ${path.join(dataPath, `store.json.corrupt-${stamp}`)}`);
            expect(logged(LogLevel.Error).at(-1)).toContain('Its contents are kept there, unchanged.');
        });

        // A directory where the file should be: reading it fails (EISDIR) for any user, root too.
        it('moves aside a store.json it could not read at all', async () => {
            await mkdir(storePath);
            await writeFile(path.join(storePath, 'inside'), 'kept', 'utf8');

            await api.init();

            expect(logged(LogLevel.Error)[0]).toContain(`Could not load ${storePath}: EISDIR`);
            await expect(readFile(path.join(dataPath, `store.json.corrupt-${stamp}`, 'inside'), 'utf8')).resolves.toBe('kept');
            await expect(get('/')).resolves.toEqual({ status: 200, body: [] });
        });

        it('never moves it over a file that is already there', async () => {
            const taken = path.join(dataPath, `store.json.corrupt-${stamp}`);
            await writeFile(taken, 'an earlier copy', 'utf8');
            await writeFile(`${taken}-2`, 'another earlier copy', 'utf8');
            await writeFile(storePath, '{not json', 'utf8');

            await api.init();

            await expect(readFile(taken, 'utf8')).resolves.toBe('an earlier copy');
            await expect(readFile(`${taken}-2`, 'utf8')).resolves.toBe('another earlier copy');
            await expect(readFile(`${taken}-3`, 'utf8')).resolves.toBe('{not json');
        });

        // It would overwrite newer values with older ones. In a data folder without store.db, the
        // same file is imported: that is how a store is restored from store-export.js's output.
        it('does not import one next to a store.db that holds the store, and says how to', async () => {
            await api.init();
            await put('/appA/key', 'newer');
            await writeFile(storePath, JSON.stringify({ appA: { key: 'older' } }), 'utf8');

            await restart({ now: () => NOW });

            await expect(get('/appA/key')).resolves.toEqual({ status: 200, body: 'newer' });
            await expect(readFile(storePath, 'utf8')).resolves.toBe(JSON.stringify({ appA: { key: 'older' } }));
            expect(logged(LogLevel.Warn)).toEqual([ expect.stringContaining(`Not importing ${storePath}: store.db already holds the data store.`) ]);
        });

        // A store.db that a crash left before the import committed.
        it('imports it into a store.db that is there but empty', async () => {
            await writeFile(databasePath, '');
            await writeFile(storePath, JSON.stringify({ appA: { key: 1 } }), 'utf8');

            await api.init();

            await expect(get('/appA/key')).resolves.toEqual({ status: 200, body: 1 });
            expect(await dataFiles()).toEqual([ `store.json.imported-${stamp}` ]);
        });
    });
});
