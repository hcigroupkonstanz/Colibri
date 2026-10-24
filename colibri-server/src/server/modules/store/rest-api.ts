import { errorMessage } from '../core/error-message.js';
import { Service } from '../core/service.js';
import type { WebServer } from '../http/web-server.js';
import { StoreCheckpointer } from './store-checkpoint.js';
import type { StoreEntry } from './store-database.js';
import { STORE_DATABASE_FILENAME, StoreDatabase, WAL_BACKSTOP_PAGES } from './store-database.js';
import type { LoadedStoreJson } from './store-json-import.js';
import { STORE_JSON_FILENAME, StoreJsonImport } from './store-json-import.js';
import { StoreQuota } from './store-quota.js';
import { storeRouter } from './store-router.js';
import { mkdir } from 'fs/promises';
import * as path from 'path';

const DAY_MILLIS = 24 * 60 * 60 * 1000;
const EXPIRY_INTERVAL_MILLIS = 60 * 60 * 1000;
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

export class RestAPI extends Service {
    public serviceName = 'RestAPI';
    public groupName = 'web';

    private db: StoreDatabase | undefined;
    private readonly databasePath: string;
    // Imports store.json into a new store.db. Logs through this service, so under its name.
    private readonly storeJsonImport: StoreJsonImport;
    private readonly expiryDays: number;
    // The limit on the bytes of JSON the store holds, and the warning when a PUT is refused for it.
    private readonly quota: StoreQuota;
    private readonly now: () => number;
    private expiryTimer: NodeJS.Timeout | undefined;
    private checkpointer: StoreCheckpointer | undefined;
    private checkpointWarnedAt = -Infinity;

    public constructor(dataPath: string, webserver: WebServer, options: RestStoreOptions = {}) {
        super();

        this.databasePath = path.join(dataPath, STORE_DATABASE_FILENAME);
        this.storeJsonImport = new StoreJsonImport(dataPath, {
            now: () => this.now(),
            logInfo: (msg) => this.logInfo(msg),
            logWarning: (msg) => this.logWarning(msg),
            logError: (msg, printStacktrace) => this.logError(msg, printStacktrace),
        });
        this.expiryDays = options.expiryDays ?? 0;
        this.quota = new StoreQuota(options.maxBytes ?? 0, {
            store: () => this.store,
            now: () => this.now(),
            logWarning: (msg) => this.logWarning(msg),
        });
        this.now = options.now ?? Date.now;

        webserver.addApi('/store', storeRouter(this.quota, {
            store: () => this.store,
            now: () => this.now(),
            logWarning: (msg) => this.logWarning(msg),
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
                loaded = await this.storeJsonImport.loadStoreJson();
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
        if (loaded?.present) await this.storeJsonImport.retireStoreJson(loaded);
        else await this.storeJsonImport.reportStoreJsonLeftBehind();
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
            loaded ??= await this.storeJsonImport.loadStoreJson();
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

    // At shutdown. Every write is committed when its request is answered, so there is nothing to
    // save; closing checkpoints the write-ahead log into store.db.
    public async close(): Promise<void> {
        if (this.expiryTimer) clearInterval(this.expiryTimer);
        this.expiryTimer = undefined;
        await this.checkpointer?.stop();
        this.checkpointer = undefined;
        this.db?.close();
    }
}
