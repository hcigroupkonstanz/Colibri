import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { Router, Request, RequestHandler, Response } from 'express';
import { Subscription } from 'rxjs';
import { LogLevel, LogMessage, Service } from '../../src/server/modules/core/index.js';
import { RestAPI } from '../../src/server/modules/web/rest-api.js';
import type { WebServer } from '../../src/server/modules/web/web-server.js';

const SAVE_DEBOUNCE_MILLIS = 250;

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

const call = function (router: Router, method: string, url: string, body?: unknown): Promise<Result> {
    return new Promise<Result>((resolve, reject) => {
        const req = { method, url, body, headers: {} } as unknown as Request;

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

describe('RestAPI', () => {
    let dataPath: string;
    let storePath: string;
    let webserver: FakeWebServer;
    let api: RestAPI;

    const put = (url: string, body: unknown) => call(webserver.router!, 'PUT', url, body);
    const get = (url: string) => call(webserver.router!, 'GET', url);
    const del = (url: string) => call(webserver.router!, 'DELETE', url);

    const readStore = async (): Promise<unknown> => JSON.parse(await readFile(storePath, 'utf8'));

    beforeEach(async () => {
        dataPath = await mkdtemp(path.join(tmpdir(), 'colibri-rest-api-'));
        storePath = path.join(dataPath, 'store.json');
        webserver = new FakeWebServer();
        api = new RestAPI(dataPath, webserver.asWebServer());
    });

    afterEach(async () => {
        vi.useRealTimers();
        await rm(dataPath, { recursive: true, force: true });
    });

    // Item 27: the store used to be read lazily, so a request arriving before the read
    // finished saw the empty default.
    describe('init', () => {
        it('loads a persisted store before any request is served', async () => {
            await writeFile(storePath, JSON.stringify({ appA: { key: 'value' } }), 'utf8');
            await api.init();

            await expect(get('/appA/key')).resolves.toEqual({ status: 200, body: 'value' });
        });

        it('starts empty when there is no store file', async () => {
            await api.init();
            await expect(get('/')).resolves.toEqual({ status: 200, body: [] });
        });

        it('ignores a store file that is not a JSON object', async () => {
            await writeFile(storePath, '[1,2,3]', 'utf8');
            await api.init();

            await expect(get('/')).resolves.toEqual({ status: 200, body: [] });
        });

        it('ignores individual apps whose value is not an object', async () => {
            await writeFile(storePath, JSON.stringify({ good: { k: 1 }, bad: 42 }), 'utf8');
            await api.init();

            await expect(get('/')).resolves.toEqual({ status: 200, body: ['good'] });
        });

        it('survives a corrupt store file', async () => {
            await writeFile(storePath, '{not json', 'utf8');
            await api.init();

            await expect(get('/')).resolves.toEqual({ status: 200, body: [] });
        });

        it('loads an existing store.json and writes it back unchanged', async () => {
            await copyFile(FIXTURE_STORE, storePath);
            const fixture = await readFile(FIXTURE_STORE, 'utf8');
            await api.init();

            await expect(get('/')).resolves.toEqual({ status: 200, body: [ 'ExampleUnityApp', 'web-demo' ] });
            await expect(get('/ExampleUnityApp')).resolves.toEqual({ status: 200, body: [ 'exampleObject', 'highscores', 'constructor' ] });
            await expect(get('/ExampleUnityApp/exampleObject')).resolves.toEqual({ status: 200, body: { Id: 1234, Name: 'Charly Sharp' } });
            await expect(get('/ExampleUnityApp/constructor')).resolves.toEqual({
                status: 200,
                body: { note: 'stored as an own value name by the old object-backed store' },
            });
            await expect(get('/web-demo/sampleKey')).resolves.toMatchObject({ status: 200, body: { tags: [ 'a', 'b' ], nothing: null } });

            // A change that cancels out, so that flush() has something to write.
            await put('/scratch/key', 1);
            await del('/scratch');
            await api.flush();
            await expect(readFile(storePath, 'utf8')).resolves.toBe(JSON.stringify(JSON.parse(fixture)));
        });

        it('loads app and value names that only a hand-edited store.json can contain', async () => {
            await writeFile(storePath, '{"__proto__":{"__proto__":1,"toString":2}}', 'utf8');
            await api.init();

            await expect(get('/')).resolves.toEqual({ status: 200, body: [ '__proto__' ] });
            await expect(get('/__proto__')).resolves.toEqual({ status: 200, body: [ '__proto__', 'toString' ] });
            await expect(get('/__proto__/__proto__')).resolves.toEqual({ status: 200, body: 1 });
            await expect(get('/__proto__/toString')).resolves.toEqual({ status: 200, body: 2 });
        });
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

        // For the admin UI's server info.
        it('counts its apps and values', async () => {
            expect(api.counts()).toEqual({ apps: 0, keys: 0 });
            await put('/appA/one', 1);
            await put('/appA/two', 2);
            await put('/appB/one', 1);
            expect(api.counts()).toEqual({ apps: 2, keys: 3 });
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

            await expect(get('/')).resolves.toEqual({ status: 200, body: [ ...PROTOTYPE_NAMES, 'appA' ] });
            await expect(get('/appA')).resolves.toEqual({ status: 200, body: PROTOTYPE_NAMES });
            for (const name of PROTOTYPE_NAMES) {
                await expect(get(`/${name}`)).resolves.toEqual({ status: 200, body: [ name ] });
                await expect(get(`/${name}/${name}`)).resolves.toEqual({ status: 200, body: { name, again: true } });
                await expect(get(`/appA/${name}`)).resolves.toEqual({ status: 200, body: name });
            }
            expectPrototypesUntouched();

            for (const name of PROTOTYPE_NAMES) {
                await expect(del(`/${name}/${name}`)).resolves.toMatchObject({ status: 200 });
                await expect(get(`/${name}/${name}`)).resolves.toMatchObject({ status: 404 });
                await expect(del(`/${name}`)).resolves.toMatchObject({ status: 200 });
                await expect(get(`/${name}`)).resolves.toMatchObject({ status: 404 });
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

        it('persists them as ordinary keys and reads them back', async () => {
            await put('/__proto__/constructor', 1);
            await put('/constructor/__proto__', { toString: 2 });
            await api.flush();

            const raw = await readFile(storePath, 'utf8');
            const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>;
            expect(Object.keys(parsed)).toEqual([ '__proto__', 'constructor' ]);
            expect(Object.keys(parsed['__proto__']!)).toEqual([ 'constructor' ]);
            expect(Object.keys(parsed['constructor']!)).toEqual([ '__proto__' ]);

            const second = new FakeWebServer();
            const reloaded = new RestAPI(dataPath, second.asWebServer());
            await reloaded.init();

            await expect(call(second.router!, 'GET', '/__proto__/constructor')).resolves.toEqual({ status: 200, body: 1 });
            await expect(call(second.router!, 'GET', '/constructor/__proto__')).resolves.toEqual({ status: 200, body: { toString: 2 } });
            expectPrototypesUntouched();
        });
    });

    describe('persistence', () => {
        beforeEach(async () => {
            await api.init();
        });

        // Item 27: a burst of PUTs coalesces into one write instead of one per request.
        it('debounces a burst of writes into a single store file', async () => {
            const internals = api as unknown as { writeStoreFile(): Promise<void> };
            const write = vi.spyOn(internals, 'writeStoreFile');

            await put('/appA/one', 1);
            await put('/appA/two', 2);
            await put('/appA/three', 3);

            expect(write).not.toHaveBeenCalled();
            await expect(readFile(storePath, 'utf8')).rejects.toThrow();

            await new Promise(resolve => setTimeout(resolve, SAVE_DEBOUNCE_MILLIS + 100));

            expect(write).toHaveBeenCalledTimes(1);
            await expect(readStore()).resolves.toEqual({ appA: { one: 1, two: 2, three: 3 } });
        });

        // Two writes must not overlap: they share one store.json.tmp, and interleaved
        // writes followed by two renames can publish a partial file.
        it('never leaves a temp file behind, even across back-to-back debounce windows', async () => {
            await put('/appA/one', 1);
            await new Promise(resolve => setTimeout(resolve, SAVE_DEBOUNCE_MILLIS + 50));
            await put('/appA/two', 2);
            await new Promise(resolve => setTimeout(resolve, SAVE_DEBOUNCE_MILLIS + 50));

            await api.flush();

            await expect(readStore()).resolves.toEqual({ appA: { one: 1, two: 2 } });
            await expect(readFile(`${storePath}.tmp`, 'utf8')).rejects.toThrow();
        });

        // Item 27: shutdown has to cancel the pending debounce and write immediately, or the
        // last update before the process exits is lost with the timer.
        it('flush() writes a pending update without waiting for the debounce', async () => {
            await put('/appA/key', 'value');
            await api.flush();

            await expect(readStore()).resolves.toEqual({ appA: { key: 'value' } });
        });

        it('round-trips through a fresh instance', async () => {
            await put('/appA/key', { nested: [1, 2] });
            await api.flush();

            const second = new FakeWebServer();
            const reloaded = new RestAPI(dataPath, second.asWebServer());
            await reloaded.init();

            await expect(call(second.router!, 'GET', '/appA/key')).resolves.toEqual({
                status: 200,
                body: { nested: [1, 2] },
            });
        });
    });

    // flush() runs at every shutdown, and used to write store.json whether or not anything had
    // changed: a needless write at best, and on a DATA_ROOT the server cannot write, an EACCES
    // at every shutdown even when there was nothing to save.
    describe('flush() at shutdown', () => {
        let errors: LogMessage[];
        let subscription: Subscription;

        beforeEach(async () => {
            await api.init();
            errors = [];
            subscription = Service.output$.subscribe(msg => {
                if (msg.origin === 'RestAPI' && msg.level === LogLevel.Error) errors.push(msg);
            });
        });

        afterEach(() => {
            subscription.unsubscribe();
        });

        // A directory where the temp file goes makes every write fail, as root too.
        const blockWrites = () => mkdir(`${storePath}.tmp`);
        const unblockWrites = () => rm(`${storePath}.tmp`, { recursive: true });

        it('writes nothing when nothing has changed', async () => {
            await api.flush();

            await expect(readFile(storePath, 'utf8')).rejects.toThrow(/ENOENT/);
        });

        it('leaves an existing store.json alone when nothing has changed', async () => {
            const pretty = JSON.stringify({ appA: { key: 'value' } }, null, 4);
            await writeFile(storePath, pretty, 'utf8');
            const reloaded = new RestAPI(dataPath, new FakeWebServer().asWebServer());
            await reloaded.init();

            await reloaded.flush();

            await expect(readFile(storePath, 'utf8')).resolves.toBe(pretty);
        });

        it('reports no error for a directory it cannot write when nothing has changed', async () => {
            await blockWrites();

            await api.flush();

            expect(errors).toEqual([]);
        });

        it('does not write again what the debounced save has already written', async () => {
            await put('/appA/key', 'value');
            await new Promise(resolve => setTimeout(resolve, SAVE_DEBOUNCE_MILLIS + 100));
            await expect(readStore()).resolves.toEqual({ appA: { key: 'value' } });

            const write = vi.spyOn(api as unknown as { writeStoreFile(): Promise<void> }, 'writeStoreFile');
            await api.flush();

            expect(write).not.toHaveBeenCalled();
        });

        // A save that failed leaves the change unsaved: the flush at shutdown is its last
        // chance, e.g. after the directory has been made writable in the meantime.
        it('tries again a save that failed', async () => {
            await blockWrites();
            await put('/appA/key', 'value');
            await new Promise(resolve => setTimeout(resolve, SAVE_DEBOUNCE_MILLIS + 100));
            expect(errors).toHaveLength(1);

            await unblockWrites();
            await api.flush();

            await expect(readStore()).resolves.toEqual({ appA: { key: 'value' } });
        });

        it('writes a change made while a save is in flight', async () => {
            await put('/appA/one', 1);
            const write = api as unknown as { writeStoreFile(): Promise<void> };
            const original = write.writeStoreFile.bind(api);
            // The debounced save starts, and a second PUT lands before it has finished.
            vi.spyOn(write, 'writeStoreFile').mockImplementationOnce(async () => {
                const saving = original();
                await put('/appA/two', 2);
                await saving;
            });
            await new Promise(resolve => setTimeout(resolve, SAVE_DEBOUNCE_MILLIS + 100));

            await api.flush();

            await expect(readStore()).resolves.toEqual({ appA: { one: 1, two: 2 } });
        });
    });

    // A store.json that could not be loaded, or only in part, used to be overwritten by the
    // first save after startup with only what had been loaded: one PUT, and everything else in
    // it was gone for good.
    describe('a store.json it could not load', () => {
        let errors: LogMessage[];
        let subscription: Subscription;

        beforeEach(() => {
            errors = [];
            subscription = Service.output$.subscribe(msg => {
                if (msg.origin === 'RestAPI' && msg.level === LogLevel.Error) errors.push(msg);
            });
        });

        afterEach(() => {
            subscription.unsubscribe();
        });

        const copiesAside = async () => (await readdir(dataPath)).filter(name => name.startsWith('store.json.corrupt-')).sort();
        const movedReports = () => errors.filter(e => e.message.startsWith('Moved '));

        it.each([
            [ 'a truncated store.json', async () => readFile(TRUNCATED_STORE, 'utf8'), {} ],
            [ 'one that is not JSON', async () => '{not json', {} ],
            [ 'one that is not a JSON object', async () => '[1,2,3]', {} ],
            [ 'one with an app that is not an object', async () => JSON.stringify({ good: { k: 1 }, bad: 42 }), { good: { k: 1 } } ],
        ])('moves %s aside, unchanged, before the first save', async (_, contents, loaded) => {
            const original = await contents();
            await writeFile(storePath, original, 'utf8');
            await api.init();
            expect(errors.map(e => e.message).join('\n')).toContain(`${storePath} is moved aside`);

            await put('/appA/key', 1);
            await api.flush();

            const aside = await copiesAside();
            expect(aside).toHaveLength(1);
            expect(aside[0]).toMatch(/^store\.json\.corrupt-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/);
            await expect(readFile(path.join(dataPath, aside[0]!), 'utf8')).resolves.toBe(original);
            await expect(readStore()).resolves.toEqual({ ...loaded, appA: { key: 1 } });

            // On the log bus, which both the admin UI's log and stderr print.
            expect(movedReports()).toHaveLength(1);
            expect(movedReports()[0]!.message).toContain(`Moved ${storePath} to ${path.join(dataPath, aside[0]!)}`);
            expect(movedReports()[0]!.message).toContain('could not be loaded at startup');
        });

        it('moves it aside before a DELETE is saved, too', async () => {
            await writeFile(storePath, JSON.stringify({ good: { k: 1 }, bad: 42 }), 'utf8');
            await api.init();

            await expect(del('/good')).resolves.toMatchObject({ status: 200 });
            await api.flush();

            expect(await copiesAside()).toHaveLength(1);
            await expect(readStore()).resolves.toEqual({});
        });

        it('leaves it where it is while nothing is saved', async () => {
            await copyFile(TRUNCATED_STORE, storePath);
            await api.init();

            await api.flush();

            expect(await copiesAside()).toEqual([]);
            await expect(readFile(storePath, 'utf8')).resolves.toBe(await readFile(TRUNCATED_STORE, 'utf8'));
        });

        it('moves it aside only once', async () => {
            await copyFile(TRUNCATED_STORE, storePath);
            await api.init();

            await put('/appA/one', 1);
            await api.flush();
            await put('/appA/two', 2);
            await api.flush();

            expect(await copiesAside()).toHaveLength(1);
            expect(movedReports()).toHaveLength(1);
            await expect(readStore()).resolves.toEqual({ appA: { one: 1, two: 2 } });
        });

        it('never moves it over a copy that is already there', async () => {
            vi.useFakeTimers({ toFake: [ 'Date' ] });
            vi.setSystemTime(new Date('2026-10-19T09:30:00.000Z'));
            const taken = path.join(dataPath, 'store.json.corrupt-2026-10-19T09-30-00.000Z');
            await writeFile(taken, 'an earlier copy', 'utf8');
            await writeFile(`${taken}-2`, 'another earlier copy', 'utf8');
            await writeFile(storePath, '{not json', 'utf8');
            await api.init();

            await put('/appA/key', 1);
            await api.flush();

            await expect(readFile(taken, 'utf8')).resolves.toBe('an earlier copy');
            await expect(readFile(`${taken}-2`, 'utf8')).resolves.toBe('another earlier copy');
            await expect(readFile(`${taken}-3`, 'utf8')).resolves.toBe('{not json');
            await expect(readStore()).resolves.toEqual({ appA: { key: 1 } });
        });

        // A directory where the file should be: reading it fails (EISDIR) for any user, root too.
        it('moves aside a store.json it could not read at all', async () => {
            await mkdir(storePath);
            await writeFile(path.join(storePath, 'inside'), 'kept', 'utf8');
            await api.init();
            expect(errors[0]!.message).toContain(`Could not load ${storePath}: EISDIR`);

            await put('/appA/key', 1);
            await api.flush();

            const aside = await copiesAside();
            expect(aside).toHaveLength(1);
            await expect(readFile(path.join(dataPath, aside[0]!, 'inside'), 'utf8')).resolves.toBe('kept');
            await expect(readStore()).resolves.toEqual({ appA: { key: 1 } });
        });

        it('saves nothing while it cannot be moved aside, and tries again with the next save', async () => {
            await writeFile(storePath, '{not json', 'utf8');
            await api.init();
            const internals = api as unknown as { moveUnloadedStoreAside(reason: string): Promise<void> };
            vi.spyOn(internals, 'moveUnloadedStoreAside').mockRejectedValueOnce(new Error('EBUSY: resource busy or locked'));

            await put('/appA/key', 1);
            await api.flush();

            await expect(readFile(storePath, 'utf8')).resolves.toBe('{not json');
            expect(errors.at(-1)!.message).toContain('EBUSY');

            // Still unsaved, so the flush at shutdown tries again - and this time it can.
            await api.flush();

            expect(await copiesAside()).toHaveLength(1);
            await expect(readStore()).resolves.toEqual({ appA: { key: 1 } });
        });
    });
});
