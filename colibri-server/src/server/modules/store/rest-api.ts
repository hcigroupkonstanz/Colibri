import { errorMessage } from '../core/error-message.js';
import { Service } from '../core/service.js';
import type { WebServer } from '../http/web-server.js';
import { hasEmptyJsonBody, hasRestMediaType } from '../http/web-server.js';
import { REST_MEDIA_TYPE } from '../protocol/protocol.js';
import { StoreCheckpointer } from './store-checkpoint.js';
import type { StoreEntry } from './store-database.js';
import { STORE_DATABASE_FILENAME, StoreDatabase, WAL_BACKSTOP_PAGES } from './store-database.js';
import { Router } from 'express';
import { lstat, mkdir, readFile, rename } from 'fs/promises';
import * as path from 'path';

// What Colibri 1.x and the 2.0 development versions kept the store in. Imported once, into a new
// store.db, then renamed.
const STORE_JSON_FILENAME = 'store.json';

const DAY_MILLIS = 24 * 60 * 60 * 1000;
const EXPIRY_INTERVAL_MILLIS = 60 * 60 * 1000;
// A full store refuses every PUT that would grow it; the warning that says so is logged at most
// this often.
const FULL_WARNING_INTERVAL_MILLIS = 60_000;
// How often the write-ahead log is copied into store.db (see StoreCheckpointer), and how often a
// checkpoint that keeps failing is logged.
const CHECKPOINT_INTERVAL_MILLIS = 1000;
const CHECKPOINT_WARNING_INTERVAL_MILLIS = 60_000;

export interface RestStoreOptions {
    // Values not written for this many days are deleted. 0 keeps them for good.
    expiryDays?: number;
    // A PUT that would take the store above this many bytes of JSON is refused with 507. 0 never.
    maxBytes?: number;
    // Date.now(), for the tests.
    now?: () => number;
}

// What store.json held, as far as it could be loaded.
interface LoadedStoreJson {
    // Whether there was a store.json at all.
    present: boolean;
    entries: StoreEntry[];
    apps: number;
    // Why it was not loaded, or only in part (unreadable, not JSON, not an object of objects).
    unloadedReason?: string;
}

export class RestAPI extends Service {
    public serviceName = 'RestAPI';
    public groupName = 'web';

    private db: StoreDatabase | undefined;
    private readonly databasePath: string;
    private readonly storeJsonPath: string;
    private readonly expiryDays: number;
    private readonly maxBytes: number;
    private readonly now: () => number;
    private expiryTimer: NodeJS.Timeout | undefined;
    private checkpointer: StoreCheckpointer | undefined;
    private checkpointWarnedAt = -Infinity;
    private fullWarnedAt = -Infinity;

    public constructor(dataPath: string, webserver: WebServer, options: RestStoreOptions = {}) {
        super();

        this.databasePath = path.join(dataPath, STORE_DATABASE_FILENAME);
        this.storeJsonPath = path.join(dataPath, STORE_JSON_FILENAME);
        this.expiryDays = options.expiryDays ?? 0;
        this.maxBytes = options.maxBytes ?? 0;
        this.now = options.now ?? Date.now;

        webserver.addApi('/store', Router()
            .get('/', (req, res) => {
                // Return all available apps
                res.status(200).json(this.store.apps());
            })
            .get('/:app', (req, res) => {
                // If app not exist return an error
                if (!this.store.hasApp(req.params.app)) {
                    res.status(404).json({ error: 'App with name ' + req.params.app + ' not found' });
                } else {
                    // Return all available values of the app
                    res.status(200).json(this.store.names(req.params.app));
                }
            })
            .get('/:app/:value', (req, res) => {
                // If app not exist return an error
                if (!this.store.hasApp(req.params.app)) {
                    res.status(404).json({ error: 'App with name ' + req.params.app + ' not found' });
                } else {
                    const json = this.store.get(req.params.app, req.params.value);
                    // If value not exist return an error
                    if (json === undefined) {
                        res.status(404).json({ error: 'Value with name ' + req.params.value + ' not found' });
                    } else {
                        // Return data of value
                        res.status(200).json(JSON.parse(json));
                    }
                }
            })
            .put('/:app/:value', (req, res) => {
                // Only a body in the store's media type is parsed. application/json, form data
                // and a body without a Content-Type are refused, rather than stored as whatever
                // they parse to: form data made an object of `curl -d`'s JSON text.
                if (!hasRestMediaType(req)) {
                    const error = `Value with name ${req.params.value} not saved: send the value as JSON, with Content-Type: ${REST_MEDIA_TYPE}`;
                    this.logWarning(`PUT /api/store/${req.params.app}/${req.params.value} answered 415: ${error}`);
                    res.status(415).json({ error });
                    return;
                }
                // express.json() leaves req.body undefined for no body at all, and makes {} of
                // an empty JSON body. The undefined used to be stored: a name listed under its
                // app that GET and DELETE then answered 404 for. Both clients always send a JSON
                // body. An empty body is told from `{}` by its raw length, not by
                // Content-Length: a chunked request has none, and its empty body used to be
                // stored as {}.
                if (req.body === undefined || hasEmptyJsonBody(req)) {
                    const error = `Value with name ${req.params.value} not saved: send the value as a JSON body`;
                    this.logWarning(`PUT /api/store/${req.params.app}/${req.params.value} answered 400: ${error}`);
                    res.status(400).json({ error });
                    return;
                }

                const json = JSON.stringify(req.body);
                if (this.wouldExceedMaxBytes(req.params.app, req.params.value, json)) {
                    const error = `Value with name ${req.params.value} not saved: the data store is full `
                        + `(STORE_MAX_MB ${this.maxBytes / (1024 * 1024)})`;
                    this.warnFull(error);
                    res.status(507).json({ error });
                    return;
                }

                // 201 for a value, or an app, that was not there before
                const created = this.store.put(req.params.app, req.params.value, json, this.now()) === 'created';
                // Return successful result with the sended data
                res.status(created ? 201 : 200).json({ result: 'Value with name ' + req.params.value + ' saved successfully', data: req.body });
            })
            .delete('/:app', (req, res) => {
                // If app not exist return an error
                if (!this.store.hasApp(req.params.app)) {
                    res.status(404).json({ error: 'App with name ' + req.params.app + ' not found' });
                } else {
                    // Delete the app
                    this.store.deleteApp(req.params.app);
                    // Return successful result
                    res.status(200).json({ result: 'App with name ' + req.params.app + ' deleted successfully' });
                }
            })
            .delete('/:app/:value', (req, res) => {
                // If app not exist return an error
                if (!this.store.hasApp(req.params.app)) {
                    res.status(404).json({ error: 'App with name ' + req.params.app + ' not found' });
                } else if (!this.store.delete(req.params.app, req.params.value)) {
                    // If value not exist return an error
                    res.status(404).json({ error: 'Value with name ' + req.params.value + ' not found' });
                } else {
                    // Return successful result
                    res.status(200).json({ result: 'Value with name ' + req.params.value + ' deleted successfully' });
                }
            }));
    }

    private get store(): StoreDatabase {
        if (!this.db) throw new Error('The data store is used before init()');
        return this.db;
    }

    // How many apps the store holds values for, how many values, and how many bytes of JSON they
    // take, for the admin UI.
    public counts(): { apps: number; keys: number; bytes: number } {
        return this.db?.counts() ?? { apps: 0, keys: 0, bytes: 0 };
    }

    // Runs before the web server starts serving requests, so a request can never find the store
    // before store.db is open, or before store.json has been imported into it.
    public override async init(): Promise<void> {
        await this.open();

        if (this.expiryDays > 0) {
            this.expire();
            this.expiryTimer = setInterval(() => this.expire(), EXPIRY_INTERVAL_MILLIS);
            this.expiryTimer.unref();
        }
    }

    // Opens store.db, importing store.json into it if store.db is new. A store.db that cannot be
    // opened, created or written (a DATA_ROOT or a store.db the server cannot write, a full disk, a
    // damaged file) leaves the store in memory, with the values store.db holds if it can still be
    // read, or else store.json's, as the store used to run when it could not save: answering, but
    // forgetting every change at the next restart.
    private async open(): Promise<void> {
        let db: StoreDatabase | undefined;
        let loaded: LoadedStoreJson | undefined;
        try {
            await mkdir(path.dirname(this.databasePath), { recursive: true });
            db = StoreDatabase.open(this.databasePath);
            if (db.initialized) {
                db.initialize();
            } else {
                loaded = await this.loadStoreJson();
                db.initialize(loaded.entries, this.now());
            }
            db.assertWritable();
            this.db = db;
        } catch (err) {
            db?.close();
            await this.openInMemory(err, loaded);
            return;
        }

        this.startCheckpointer(this.db);
        if (loaded?.present) await this.retireStoreJson(loaded);
        else await this.reportStoreJsonLeftBehind();
    }

    private async openInMemory(err: unknown, loaded: LoadedStoreJson | undefined): Promise<void> {
        let entries: StoreEntry[];
        let source: string | undefined = STORE_DATABASE_FILENAME;
        try {
            const readOnly = StoreDatabase.openReadOnly(this.databasePath);
            try {
                entries = Array.from(readOnly.entries());
            } finally {
                readOnly.close();
            }
        } catch {
            loaded ??= await this.loadStoreJson();
            entries = loaded.entries;
            source = loaded.present ? STORE_JSON_FILENAME : undefined;
        }

        this.db = StoreDatabase.open(':memory:');
        this.db.initialize(entries, this.now());
        this.logError(`Could not open ${this.databasePath} for writing: ${errorMessage(err)}. The data store keeps its values `
            + `in memory${source ? `, starting with the ${entries.length} value(s) in ${source}` : ''}, and saves nothing `
            + 'until the server can write it.', false);
    }

    // A worker thread does the checkpoints (see StoreCheckpointer), and the server's own commits
    // only as a backstop, far later than SQLite's default. The worker's PASSIVE checkpoints never
    // start the log over: SQLite only does that when a write begins on a log that is copied in
    // full, and once PUTs come faster than a checkpoint takes, one always lands during it. With
    // automatic checkpoints off, a client calling Store.Put every frame grew store.db-wal by about
    // 150 MB a minute, until the volume was full. The backstop is a checkpoint by the writer
    // itself, which copies everything, so the next write starts the log over. If the worker ends,
    // the default comes back.
    private startCheckpointer(db: StoreDatabase): void {
        this.checkpointer = StoreCheckpointer.start(this.databasePath, CHECKPOINT_INTERVAL_MILLIS, (error, workerGone) => {
            if (workerGone) {
                if (db === this.db) db.setAutoCheckpoint(1000);
                this.logError(`Data store: ${error.message}. store.db is checkpointed by the server's own writes from now on.`, false);
                return;
            }
            const now = this.now();
            if (now - this.checkpointWarnedAt < CHECKPOINT_WARNING_INTERVAL_MILLIS) return;
            this.checkpointWarnedAt = now;
            this.logWarning(`Data store: a checkpoint of ${this.databasePath} failed: ${error.message}. `
                + 'This is logged at most once a minute.');
        });
        db.setAutoCheckpoint(WAL_BACKSTOP_PAGES);
    }

    // store.json is an object of objects. A store file that parses to null, an array, or a
    // scalar (hand-edited, truncated by an older version, restored from the wrong place) is
    // ignored, and so is an app whose values are not an object. JSON.parse defines every key as
    // an own property, '__proto__' included, so Object.entries sees all of them.
    private async loadStoreJson(): Promise<LoadedStoreJson> {
        let raw: string;
        try {
            raw = await readFile(this.storeJsonPath, 'utf8');
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { present: false, entries: [], apps: 0 };
            const unloadedReason = errorMessage(err);
            this.logError(`Could not load ${this.storeJsonPath}: ${unloadedReason}. The store starts without it.`, false);
            return { present: true, entries: [], apps: 0, unloadedReason };
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch (err) {
            const unloadedReason = errorMessage(err);
            this.logError(`Could not load ${this.storeJsonPath}: ${unloadedReason}. The store starts without it.`, false);
            return { present: true, entries: [], apps: 0, unloadedReason };
        }

        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            const unloadedReason = 'expected a JSON object at the top level';
            this.logError(`Ignoring ${STORE_JSON_FILENAME}: ${unloadedReason}`, false);
            return { present: true, entries: [], apps: 0, unloadedReason };
        }

        const entries: StoreEntry[] = [];
        let apps = 0;
        let unloadedReason: string | undefined;
        for (const [ app, values ] of Object.entries(parsed)) {
            if (values === null || typeof values !== 'object' || Array.isArray(values)) {
                unloadedReason ??= `expected an object of values for app '${app}'`;
                this.logError(`Ignoring app '${app}' in ${STORE_JSON_FILENAME}: expected an object of values`, false);
                continue;
            }
            apps++;
            for (const [ name, value ] of Object.entries(values)) {
                entries.push([ app, name, JSON.stringify(value) ]);
            }
        }
        return { present: true, entries, apps, unloadedReason };
    }

    // Renames the store.json that has just been imported, so that nothing reads it again and a
    // look at the data folder shows what happened: store.json.imported-<date and time>, or
    // store.json.corrupt-<date and time> if it could not be loaded, or only in part, with its
    // contents kept there unchanged. Never over an existing file: a name that is taken gets a
    // counter. Logs, rather than throws, when it cannot: store.db is fine either way.
    private async retireStoreJson(loaded: LoadedStoreJson): Promise<void> {
        const corrupt = loaded.unloadedReason !== undefined;
        // No colons, which a Windows file name cannot have.
        const base = `${this.storeJsonPath}.${corrupt ? 'corrupt' : 'imported'}-${new Date(this.now()).toISOString().replace(/:/g, '-')}`;
        try {
            let target = base;
            for (let n = 2; await RestAPI.exists(target); n++) {
                target = `${base}-${n}`;
            }
            await rename(this.storeJsonPath, target);

            if (corrupt) {
                this.logError(`Moved ${this.storeJsonPath} to ${target}: it could not be loaded, or only in part `
                    + `(${loaded.unloadedReason}). ${loaded.entries.length} value(s) of ${loaded.apps} app(s) were imported `
                    + `into ${STORE_DATABASE_FILENAME}. Its contents are kept there, unchanged.`, false);
            } else {
                this.logInfo(`Imported ${loaded.entries.length} value(s) of ${loaded.apps} app(s) from ${STORE_JSON_FILENAME} `
                    + `into ${STORE_DATABASE_FILENAME}, and renamed it to ${path.basename(target)}`);
            }
        } catch (err) {
            // Removed since it was read: there is nothing left to rename.
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
            this.logError(`Imported ${STORE_JSON_FILENAME} into ${STORE_DATABASE_FILENAME}, but could not rename `
                + `${this.storeJsonPath} to ${base}: ${errorMessage(err)}. It is not read again.`, false);
        }
    }

    // A store.json next to a store.db that already holds the store is not imported: it would
    // overwrite newer values with older ones. Most likely it is a copy put there to restore the
    // store, which works in a data folder without store.db.
    private async reportStoreJsonLeftBehind(): Promise<void> {
        if (!await RestAPI.exists(this.storeJsonPath)) return;
        this.logWarning(`Not importing ${this.storeJsonPath}: ${STORE_DATABASE_FILENAME} already holds the data store. `
            + `To restore the store from it, stop the server and remove ${STORE_DATABASE_FILENAME} `
            + `(and ${STORE_DATABASE_FILENAME}-wal and -shm next to it) first.`);
    }

    // Deletes the values not written for expiryDays. Never throws: at startup that would stop the
    // server, and in the timer it would be an uncaught exception, both for a store.db that another
    // program has locked for a moment, or a full disk.
    private expire(): void {
        if (!this.db) return;
        try {
            const removed = this.db.expire(this.now() - this.expiryDays * DAY_MILLIS);
            if (removed > 0) {
                this.logInfo(`Data store: removed ${removed} value(s) not written for ${this.expiryDays} days (STORE_EXPIRY_DAYS)`);
            }
        } catch (err) {
            this.logError(`Data store: could not remove the values not written for ${this.expiryDays} days: `
                + `${errorMessage(err)}. Tried again in an hour.`, false);
        }
    }

    // Whether storing `json` would take the store above maxBytes. A replaced value counts only by
    // how much it grows, so that a full store still takes a value that does not grow.
    private wouldExceedMaxBytes(app: string, name: string, json: string): boolean {
        if (this.maxBytes <= 0) return false;
        const previous = this.store.sizeOf(app, name) ?? 0;
        const growth = Buffer.byteLength(json, 'utf8') - previous;
        return growth > 0 && this.store.counts().bytes + growth > this.maxBytes;
    }

    private warnFull(error: string): void {
        const now = this.now();
        if (now - this.fullWarnedAt < FULL_WARNING_INTERVAL_MILLIS) return;
        this.fullWarnedAt = now;
        this.logWarning(`PUT answered 507: ${error}. Delete values or raise STORE_MAX_MB. `
            + 'This is logged at most once a minute.');
    }

    // At shutdown. Every write is committed when its request is answered, so there is nothing to
    // save; closing checkpoints the write-ahead log into store.db.
    public async close(): Promise<void> {
        if (this.expiryTimer) clearInterval(this.expiryTimer);
        this.expiryTimer = undefined;
        await this.checkpointer?.stop();
        this.checkpointer = undefined;
        this.db?.close();
    }

    private static async exists(file: string): Promise<boolean> {
        try {
            await lstat(file);
            return true;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
            throw err;
        }
    }
}
