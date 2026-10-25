import { once } from 'events';
import { DatabaseSync } from 'node:sqlite';

// The data store's file in DATA_ROOT.
export const STORE_DATABASE_FILENAME = 'store.db';

// A value to store: its app, its name and its JSON text.
export type StoreEntry = readonly [ app: string, name: string, json: string ];

// The size the write-ahead log is cut back to when SQLite starts it over (see open), and the
// number of pages after which a commit checkpoints it itself if the checkpoint worker falls
// behind (see RestAPI.startCheckpointer): about the same size at SQLite's default 4 KiB pages.
export const WAL_SIZE_LIMIT_BYTES = 16 * 1024 * 1024;
export const WAL_BACKSTOP_PAGES = 4000;

// The schema version in PRAGMA user_version. 0 is a database that initialize() has not completed:
// a new file, or one a crash left before the import from store.json committed.
const SCHEMA_VERSION = 1;

// A rowid table with its own index on (app, name), not a WITHOUT ROWID table keyed by them: a value
// can be up to 5 MiB, and SQLite keeps a WITHOUT ROWID row inside its key's B-tree, so listing an
// app's names would read the large values too. The index holds only app and name: a value is one
// index lookup, an app's names are one range of the index alone. value is the last column, so that
// reading bytes or updated_at never walks the overflow pages of a large value. updated_at is
// indexed for the expiry sweep alone, which then reads only the rows past its cutoff. Every further
// index would cost a B-tree write on each PUT and DELETE.
const SCHEMA = `
    CREATE TABLE IF NOT EXISTS store_values (
        app TEXT NOT NULL,
        name TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        value TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS store_values_key ON store_values (app, name);
    CREATE INDEX IF NOT EXISTS store_values_updated_at ON store_values (updated_at);
`;

/**
 * The REST store's values, in SQLite. A write is one row, and only the per-app counts are kept in
 * memory.
 *
 * Synchronous on purpose: a write is a few tens of microseconds, and the routes stay simple.
 */
export class StoreDatabase {
    private statements: ReturnType<StoreDatabase['prepare']> | undefined;
    // Values and bytes per app, for counts(), apps() and hasApp() without a table scan. Read once
    // in initialize(), then kept up to date by every write.
    private readonly perApp = new Map<string, { keys: number; bytes: number }>();
    private keys = 0;
    private bytes = 0;

    private constructor(private readonly db: DatabaseSync) {}

    /**
     * Opens the database in `file`, creating the file if it is missing, or an in-memory database
     * for ':memory:'. Throws if it cannot. Call initialize() before anything else.
     */
    public static open(file: string): StoreDatabase {
        const db = new DatabaseSync(file, { timeout: 5000 });
        try {
            // WAL, so readers such as store-export.js are not blocked. NORMAL syncs at checkpoints
            // only: a power cut can lose the last writes but never corrupts the database.
            if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
            db.exec('PRAGMA synchronous = NORMAL');
            // SQLite leaves the log file at its largest size until the database is closed. This cuts
            // it back to WAL_SIZE_LIMIT_BYTES whenever the log starts over.
            db.exec(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES}`);
        } catch (err) {
            db.close();
            throw err;
        }
        return new StoreDatabase(db);
    }

    /** Opens `file` read-only, for store-export.js. Throws if it is missing or not initialized. */
    public static openReadOnly(file: string): StoreDatabase {
        const store = new StoreDatabase(new DatabaseSync(file, { readOnly: true, timeout: 5000 }));
        if (!store.initialized) {
            store.close();
            throw new Error(`${file} holds no data store`);
        }
        store.statements = store.prepare();
        return store;
    }

    /**
     * Throws unless a write would succeed. SQLite opens a file it may read but not write read-only,
     * without saying so, and only the first write then fails: a store.db owned by root, or locked
     * by another program for longer than the busy timeout.
     */
    public assertWritable(): void {
        // BEGIN IMMEDIATE alone succeeds on a read-only file: only a page write fails. This writes
        // the header's user_version, unchanged, and rolls it back.
        this.db.exec('BEGIN IMMEDIATE');
        try {
            this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        } finally {
            if (this.db.isTransaction) this.db.exec('ROLLBACK');
        }
    }

    /**
     * Pages of write-ahead log after which a commit checkpoints it into the database, 0 for never
     * (see StoreCheckpointer). SQLite's default is 1000.
     */
    public setAutoCheckpoint(pages: number): void {
        this.db.exec(`PRAGMA wal_autocheckpoint = ${Math.max(0, Math.trunc(pages))}`);
    }

    /** Whether initialize() has completed on this database, in this run or an earlier one. */
    public get initialized(): boolean {
        const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
        return (row?.user_version ?? 0) >= SCHEMA_VERSION;
    }

    /**
     * Creates the schema and, in the same transaction, stores `entries` with `now` as their write
     * time: a crash before the commit leaves the database uninitialized, so that the next start
     * imports store.json again instead of starting without it. On an initialized database it adds
     * no values; it only creates what the schema is missing and reads the counts.
     */
    public initialize(entries: Iterable<StoreEntry> = [], now = Date.now()): void {
        if (!this.initialized) {
            this.db.exec('BEGIN IMMEDIATE');
            try {
                this.db.exec(SCHEMA);
                const insert = this.db.prepare(
                    'INSERT OR REPLACE INTO store_values (app, name, bytes, updated_at, value) VALUES (?, ?, ?, ?, ?)'
                );
                for (const [ app, name, json ] of entries) {
                    insert.run(app, name, Buffer.byteLength(json, 'utf8'), now, json);
                }
                this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
                this.db.exec('COMMIT');
            } catch (err) {
                // SQLite has rolled back already after some errors, such as a full disk; a ROLLBACK
                // then would throw, and its error would hide this one.
                if (this.db.isTransaction) this.db.exec('ROLLBACK');
                throw err;
            }
        }

        // IF NOT EXISTS: a no-op on a database this version created, and how an index added in a
        // later version reaches a database an earlier one created.
        this.db.exec(SCHEMA);
        this.statements = this.prepare();
        this.perApp.clear();
        this.keys = 0;
        this.bytes = 0;
        const rows = this.db.prepare('SELECT app, count(*) AS keys, total(bytes) AS bytes FROM store_values GROUP BY app').all();
        for (const row of rows as Array<{ app: string; keys: number; bytes: number }>) {
            this.perApp.set(row.app, { keys: row.keys, bytes: row.bytes });
            this.keys += row.keys;
            this.bytes += row.bytes;
        }
    }

    private prepare() {
        const db = this.db;
        return {
            names: db.prepare('SELECT name FROM store_values WHERE app = ? ORDER BY name'),
            get: db.prepare('SELECT value FROM store_values WHERE app = ? AND name = ?'),
            bytes: db.prepare('SELECT bytes FROM store_values WHERE app = ? AND name = ?'),
            put: db.prepare(
                'INSERT INTO store_values (app, name, bytes, updated_at, value) VALUES (?, ?, ?, ?, ?) '
                + 'ON CONFLICT (app, name) DO UPDATE SET bytes = excluded.bytes, updated_at = excluded.updated_at, value = excluded.value'
            ),
            delete: db.prepare('DELETE FROM store_values WHERE app = ? AND name = ? RETURNING bytes'),
            deleteApp: db.prepare('DELETE FROM store_values WHERE app = ? RETURNING bytes'),
            expire: db.prepare('DELETE FROM store_values WHERE updated_at < ? RETURNING app, bytes'),
            entries: db.prepare('SELECT app, name, value FROM store_values ORDER BY app, name'),
        };
    }

    private get statement(): NonNullable<StoreDatabase['statements']> {
        if (!this.statements) throw new Error('StoreDatabase used before initialize()');
        return this.statements;
    }

    /** The apps that hold at least one value, in key order. */
    public apps(): string[] {
        return Array.from(this.perApp.keys()).sort(compareKeys);
    }

    public hasApp(app: string): boolean {
        return this.perApp.has(app);
    }

    /** The names of the app's values, in key order. */
    public names(app: string): string[] {
        return (this.statement.names.all(app) as Array<{ name: string }>).map(row => row.name);
    }

    /** The value's JSON text, or undefined if there is none. */
    public get(app: string, name: string): string | undefined {
        return (this.statement.get.get(app, name) as { value: string } | undefined)?.value;
    }

    /** How many bytes the value takes, or undefined if there is none. */
    public sizeOf(app: string, name: string): number | undefined {
        return (this.statement.bytes.get(app, name) as { bytes: number } | undefined)?.bytes;
    }

    /** Stores the value's JSON text, written at `now`. */
    public put(app: string, name: string, json: string, now = Date.now()): 'created' | 'updated' {
        const bytes = Buffer.byteLength(json, 'utf8');
        const previous = this.sizeOf(app, name);
        this.statement.put.run(app, name, bytes, now, json);
        this.account(app, previous === undefined ? 1 : 0, bytes - (previous ?? 0));
        return previous === undefined ? 'created' : 'updated';
    }

    /** Deletes the value; false if there was none. */
    public delete(app: string, name: string): boolean {
        const removed = this.statement.delete.all(app, name) as Array<{ bytes: number }>;
        for (const row of removed) this.account(app, -1, -row.bytes);
        return removed.length > 0;
    }

    /** Deletes all of the app's values, returning how many there were. */
    public deleteApp(app: string): number {
        const removed = this.statement.deleteApp.all(app) as Array<{ bytes: number }>;
        for (const row of removed) this.account(app, -1, -row.bytes);
        return removed.length;
    }

    /** Deletes every value last written before `cutoff` (a Date.now() reading), returning how many. */
    public expire(cutoff: number): number {
        const removed = this.statement.expire.all(cutoff) as Array<{ app: string; bytes: number }>;
        for (const row of removed) this.account(row.app, -1, -row.bytes);
        return removed.length;
    }

    /** Every value, ordered by app and name, as its JSON text. */
    public *entries(): Generator<StoreEntry> {
        for (const row of this.statement.entries.iterate() as Iterable<{ app: string; name: string; value: string }>) {
            yield [ row.app, row.name, row.value ];
        }
    }

    public counts(): { apps: number; keys: number; bytes: number } {
        return { apps: this.perApp.size, keys: this.keys, bytes: this.bytes };
    }

    /** The query plan SQLite chose for one of the statements, for the tests. */
    public queryPlan(sql: string): string[] {
        return (this.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map(row => row.detail);
    }

    public close(): void {
        if (this.db.isOpen) this.db.close();
    }

    private account(app: string, keys: number, bytes: number): void {
        this.keys += keys;
        this.bytes += bytes;
        const counts = this.perApp.get(app) ?? { keys: 0, bytes: 0 };
        counts.keys += keys;
        counts.bytes += bytes;
        if (counts.keys > 0) this.perApp.set(app, counts);
        else this.perApp.delete(app);
    }
}

// Written in pieces of about this size, so that neither a large store nor a slow pipe has the whole
// export in memory.
const EXPORT_CHUNK_CHARS = 64 * 1024;

/**
 * Writes the store to `out` as JSON in the shape store.json had, { "<app>": { "<name>": <value> } },
 * for store-export.js. The values go out as stored, without being parsed.
 */
export const writeStoreJson = async function (store: StoreDatabase, out: NodeJS.WritableStream): Promise<void> {
    let chunk = '{';
    let app: string | undefined;
    for (const [ entryApp, name, json ] of store.entries()) {
        if (entryApp !== app) {
            chunk += `${app === undefined ? '' : '},'}${JSON.stringify(entryApp)}:{`;
            app = entryApp;
        } else {
            chunk += ',';
        }
        chunk += `${JSON.stringify(name)}:${json}`;
        if (chunk.length >= EXPORT_CHUNK_CHARS) {
            if (!out.write(chunk)) await once(out, 'drain');
            chunk = '';
        }
    }
    chunk += app === undefined ? '}\n' : '}}\n';
    if (!out.write(chunk)) await once(out, 'drain');
};

// SQLite's own order for TEXT (BINARY collation: byte by byte in UTF-8), so that apps() lists the
// apps in the order names() lists names. localeCompare and < both differ from it for some names.
const compareKeys = function (a: string, b: string): number {
    return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
};
