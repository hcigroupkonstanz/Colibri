import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { StoreDatabase, writeStoreJson } from '../../src/server/modules/web/store-database.js';

describe('StoreDatabase', () => {
    const open: StoreDatabase[] = [];
    const dirs: string[] = [];

    const memory = (entries: Array<[ string, string, string ]> = [], now = 1000): StoreDatabase => {
        const db = StoreDatabase.open(':memory:');
        open.push(db);
        db.initialize(entries, now);
        return db;
    };

    const tempFile = async (): Promise<string> => {
        const dir = await mkdtemp(path.join(tmpdir(), 'colibri-store-db-'));
        dirs.push(dir);
        return path.join(dir, 'store.db');
    };

    afterEach(async () => {
        for (const db of open.splice(0)) db.close();
        for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
    });

    it('stores, replaces and deletes values, and says which were new', () => {
        const db = memory();

        expect(db.put('app', 'key', '{"x":1}')).toBe('created');
        expect(db.put('app', 'key', '{"x":2}')).toBe('updated');
        expect(db.get('app', 'key')).toBe('{"x":2}');
        expect(db.get('app', 'other')).toBeUndefined();

        expect(db.delete('app', 'other')).toBe(false);
        expect(db.delete('app', 'key')).toBe(true);
        expect(db.get('app', 'key')).toBeUndefined();
        expect(db.hasApp('app')).toBe(false);
    });

    it('keeps the counts and bytes per app up to date with every write', () => {
        const db = memory([ [ 'a', 'one', '1' ] ]);
        expect(db.counts()).toEqual({ apps: 1, keys: 1, bytes: 1 });

        db.put('a', 'two', '"zwei"');
        db.put('b', 'one', '"ü"');
        expect(db.counts()).toEqual({ apps: 2, keys: 3, bytes: 1 + 6 + 4 });

        db.put('a', 'two', '2');
        expect(db.counts()).toEqual({ apps: 2, keys: 3, bytes: 1 + 1 + 4 });

        expect(db.deleteApp('a')).toBe(2);
        expect(db.counts()).toEqual({ apps: 1, keys: 1, bytes: 4 });
        expect(db.apps()).toEqual([ 'b' ]);
    });

    // SQLite's BINARY order, byte by byte: upper case before lower case, '_' between them.
    it('lists apps and names in key order', () => {
        const db = memory();
        for (const name of [ 'b', 'B', '_x', 'a', 'ä' ]) {
            db.put(name, name, '0');
            db.put('app', name, '0');
        }

        expect(db.apps()).toEqual([ 'B', '_x', 'a', 'app', 'b', 'ä' ]);
        expect(db.names('app')).toEqual([ 'B', '_x', 'a', 'b', 'ä' ]);
    });

    it('expires what was last written before the cutoff, and nothing else', () => {
        const db = memory([ [ 'a', 'old', '1' ] ], 1000);
        db.put('a', 'new', '2', 5000);
        db.put('b', 'old', '3', 2000);

        expect(db.expire(3000)).toBe(2);
        expect([ ...db.entries() ]).toEqual([ [ 'a', 'new', '2' ] ]);
        expect(db.counts()).toEqual({ apps: 1, keys: 1, bytes: 1 });

        // A write moves a value's time on.
        db.put('a', 'new', '2', 9000);
        expect(db.expire(6000)).toBe(0);
    });

    // A value is one lookup in the (app, name) index, an app's names one range of that index alone,
    // and the expiry sweep reads only the rows past its cutoff. None of them scans the table, or sorts.
    it.each([
        [ 'names', 'SELECT name FROM store_values WHERE app = ? ORDER BY name', 'USING COVERING INDEX store_values_key (app=?)' ],
        [ 'get', 'SELECT value FROM store_values WHERE app = ? AND name = ?', 'USING INDEX store_values_key (app=? AND name=?)' ],
        [ 'bytes', 'SELECT bytes FROM store_values WHERE app = ? AND name = ?', 'USING INDEX store_values_key (app=? AND name=?)' ],
        [ 'delete', 'DELETE FROM store_values WHERE app = ? AND name = ? RETURNING bytes', 'USING INDEX store_values_key (app=? AND name=?)' ],
        [ 'deleteApp', 'DELETE FROM store_values WHERE app = ? RETURNING bytes', 'USING COVERING INDEX store_values_key (app=?)' ],
        [ 'expire', 'DELETE FROM store_values WHERE updated_at < ? RETURNING app, bytes', 'USING COVERING INDEX store_values_updated_at (updated_at<?)' ],
    ])('looks %s up by an index', (_, sql, index) => {
        const plan = memory().queryPlan(sql);

        expect(plan).toEqual([ `SEARCH store_values ${index}` ]);
    });

    it('imports the initial entries only once, and only into a database that has not been initialized', async () => {
        const file = await tempFile();
        const first = StoreDatabase.open(file);
        expect(first.initialized).toBe(false);
        first.initialize([ [ 'a', 'k', '1' ] ]);
        first.close();

        const second = StoreDatabase.open(file);
        open.push(second);
        expect(second.initialized).toBe(true);
        second.initialize([ [ 'a', 'k', '2' ], [ 'b', 'k', '3' ] ]);

        expect([ ...second.entries() ]).toEqual([ [ 'a', 'k', '1' ] ]);
    });

    // initialize() commits the schema, the import and the version together: a failed import leaves
    // the database as it was, so that the next start imports store.json again.
    it('leaves the database uninitialized when the import fails', async () => {
        const file = await tempFile();
        const db = StoreDatabase.open(file);
        open.push(db);
        const failing = function* (): Generator<[ string, string, string ]> {
            yield [ 'a', 'k', '1' ];
            throw new Error('read error');
        };

        expect(() => db.initialize(failing())).toThrow('read error');
        expect(db.initialized).toBe(false);

        db.initialize([ [ 'a', 'k', '1' ] ]);
        expect(db.counts()).toEqual({ apps: 1, keys: 1, bytes: 1 });
    });

    it('reads a database read-only while it is open for writing, without its last close', async () => {
        const file = await tempFile();
        const writer = StoreDatabase.open(file);
        open.push(writer);
        writer.initialize();
        writer.put('a', 'k', '"v"');

        const reader = StoreDatabase.openReadOnly(file);
        open.push(reader);

        expect([ ...reader.entries() ]).toEqual([ [ 'a', 'k', '"v"' ] ]);
    });

    // The output of store-export.js: store.json's shape, which a new data folder imports again.
    describe('writeStoreJson', () => {
        const exported = async (db: StoreDatabase): Promise<string> => {
            const out = new PassThrough();
            const chunks: Buffer[] = [];
            out.on('data', (chunk: Buffer) => chunks.push(chunk));
            await writeStoreJson(db, out);
            out.end();
            return Buffer.concat(chunks).toString('utf8');
        };

        it('writes {} for an empty store', async () => {
            await expect(exported(memory())).resolves.toBe('{}\n');
        });

        it('writes every app and value as store.json had them, names that need escaping included', async () => {
            const store = { appA: { one: 1, two: { x: [ 1, 'ü' ] } }, 'quote"app': { '__proto__': null, 'back\\slash': 'v' } };
            const db = memory(Object.entries(store).flatMap(([ app, values ]) =>
                Object.entries(values).map(([ name, value ]): [ string, string, string ] => [ app, name, JSON.stringify(value) ])));

            const json = await exported(db);

            expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(store)));
            const imported = memory(Object.entries(JSON.parse(json) as Record<string, Record<string, unknown>>).flatMap(([ app, values ]) =>
                Object.entries(values).map(([ name, value ]): [ string, string, string ] => [ app, name, JSON.stringify(value) ])));
            expect([ ...imported.entries() ]).toEqual([ ...db.entries() ]);
        });

        it('writes a store larger than one chunk in pieces that join up', async () => {
            const db = memory();
            for (let i = 0; i < 300; i++) db.put(`app${i % 7}`, `key${i}`, JSON.stringify('x'.repeat(1000)));

            const parsed = JSON.parse(await exported(db)) as Record<string, Record<string, string>>;

            expect(Object.values(parsed).reduce((n, values) => n + Object.keys(values).length, 0)).toBe(300);
        });
    });

    it('refuses to read a file that holds no data store', async () => {
        const file = await tempFile();
        StoreDatabase.open(file).close();

        expect(() => StoreDatabase.openReadOnly(file)).toThrow('holds no data store');
    });
});
