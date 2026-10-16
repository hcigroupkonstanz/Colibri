import { Service } from '../core/index.js';
import { hasEmptyJsonBody, hasRestMediaType, WebServer } from './web-server.js';
import { REST_MEDIA_TYPE } from '../networking/protocol.js';
import { StoreCheckpointer } from './store-checkpoint.js';
import { STORE_DATABASE_FILENAME, StoreDatabase, StoreEntry } from './store-database.js';
import { Router } from 'express';
import { lstat, mkdir, readFile, rename } from 'fs/promises';
import * as path from 'path';

// What Colibri 1.x and the 2.0 development versions kept the store in. Imported once, into a new
// store.db, then renamed.
const STORE_JSON_FILENAME = 'store.json';

// How often the write-ahead log is copied into store.db (see StoreCheckpointer), and how often a
// checkpoint that keeps failing is logged.
const CHECKPOINT_INTERVAL_MILLIS = 1000;
const CHECKPOINT_WARNING_INTERVAL_MILLIS = 60_000;

const errorMessage = function (err: unknown): string {
    return err instanceof Error ? err.message : String(err);
};

export interface RestStoreOptions {
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
    private readonly now: () => number;
    private checkpointer: StoreCheckpointer | undefined;
    private checkpointWarnedAt = -Infinity;

    public constructor(dataPath: string, webserver: WebServer, options: RestStoreOptions = {}) {
        super();

        this.databasePath = path.join(dataPath, STORE_DATABASE_FILENAME);
        this.storeJsonPath = path.join(dataPath, STORE_JSON_FILENAME);
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

    // Automatic checkpoints off, and a worker thread doing them instead (see StoreCheckpointer). If
    // the worker ends, they are turned back on, so that the write-ahead log cannot grow for good.
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
        db.setAutoCheckpoint(0);
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

    // At shutdown. Every write is committed when its request is answered, so there is nothing to
    // save; closing checkpoints the write-ahead log into store.db.
    public async close(): Promise<void> {
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
