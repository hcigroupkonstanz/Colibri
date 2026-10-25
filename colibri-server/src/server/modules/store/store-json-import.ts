import { errorMessage } from '../core/error-message.js';
import type { StoreEntry } from './store-database.js';
import { STORE_DATABASE_FILENAME } from './store-database.js';
import { lstat, readFile, rename } from 'fs/promises';
import * as path from 'path';

// What Colibri 1.x kept the store in. Imported once, into a new store.db, then renamed.
export const STORE_JSON_FILENAME = 'store.json';

// What store.json held, as far as it could be loaded.
export interface LoadedStoreJson {
    // Whether there was a store.json at all.
    present: boolean;
    entries: StoreEntry[];
    apps: number;
    // Why it was not loaded, or only in part (unreadable, not JSON, not an object of objects).
    unloadedReason?: string;
}

// What StoreJsonImport needs from the RestAPI that owns it. The log methods keep the RestAPI as the
// lines' origin.
interface StoreJsonImportCallbacks {
    now(): number;
    logInfo(msg: string): void;
    logWarning(msg: string): void;
    logError(msg: string, printStacktrace: boolean): void;
}

// The RestAPI's import of the data folder's store.json into a new store.db.
export class StoreJsonImport {
    private readonly storeJsonPath: string;

    public constructor(dataPath: string, private readonly callbacks: StoreJsonImportCallbacks) {
        this.storeJsonPath = path.join(dataPath, STORE_JSON_FILENAME);
    }

    // store.json is an object of objects: a file that parses to anything else is ignored, and so is
    // an app whose values are not an object. JSON.parse defines every key as an own property,
    // '__proto__' included, so Object.entries sees all of them.
    public async loadStoreJson(): Promise<LoadedStoreJson> {
        let raw: string;
        try {
            raw = await readFile(this.storeJsonPath, 'utf8');
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { present: false, entries: [], apps: 0 };
            const unloadedReason = errorMessage(err);
            this.callbacks.logError(`Could not load ${this.storeJsonPath}: ${unloadedReason}. The store starts without it.`, false);
            return { present: true, entries: [], apps: 0, unloadedReason };
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch (err) {
            const unloadedReason = errorMessage(err);
            this.callbacks.logError(`Could not load ${this.storeJsonPath}: ${unloadedReason}. The store starts without it.`, false);
            return { present: true, entries: [], apps: 0, unloadedReason };
        }

        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            const unloadedReason = 'expected a JSON object at the top level';
            this.callbacks.logError(`Ignoring ${STORE_JSON_FILENAME}: ${unloadedReason}`, false);
            return { present: true, entries: [], apps: 0, unloadedReason };
        }

        const entries: StoreEntry[] = [];
        let apps = 0;
        let unloadedReason: string | undefined;
        for (const [ app, values ] of Object.entries(parsed as Record<string, unknown>)) {
            if (values === null || typeof values !== 'object' || Array.isArray(values)) {
                unloadedReason ??= `expected an object of values for app '${app}'`;
                this.callbacks.logError(`Ignoring app '${app}' in ${STORE_JSON_FILENAME}: expected an object of values`, false);
                continue;
            }
            apps++;
            for (const [ name, value ] of Object.entries(values)) {
                entries.push([ app, name, JSON.stringify(value) ]);
            }
        }
        return { present: true, entries, apps, unloadedReason };
    }

    // Renames the imported store.json to store.json.imported-<date and time>, or to
    // store.json.corrupt-<date and time> if it could not be loaded, or only in part, so that nothing
    // reads it again and the data folder shows what happened. Never over an existing file: a taken
    // name gets a counter. Logs rather than throws: store.db is fine either way.
    public async retireStoreJson(loaded: LoadedStoreJson): Promise<void> {
        const corrupt = loaded.unloadedReason !== undefined;
        // No colons, which a Windows file name cannot have.
        const base = `${this.storeJsonPath}.${corrupt ? 'corrupt' : 'imported'}-${new Date(this.callbacks.now()).toISOString().replace(/:/g, '-')}`;
        try {
            let target = base;
            for (let n = 2; await StoreJsonImport.exists(target); n++) {
                target = `${base}-${n}`;
            }
            await rename(this.storeJsonPath, target);

            if (corrupt) {
                this.callbacks.logError(`Moved ${this.storeJsonPath} to ${target}: it could not be loaded, or only in part `
                    + `(${loaded.unloadedReason}). ${loaded.entries.length} value(s) of ${loaded.apps} app(s) were imported `
                    + `into ${STORE_DATABASE_FILENAME}. Its contents are kept there, unchanged.`, false);
            } else {
                this.callbacks.logInfo(`Imported ${loaded.entries.length} value(s) of ${loaded.apps} app(s) from ${STORE_JSON_FILENAME} `
                    + `into ${STORE_DATABASE_FILENAME}, and renamed it to ${path.basename(target)}`);
            }
        } catch (err) {
            // Removed since it was read: there is nothing left to rename.
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
            this.callbacks.logError(`Imported ${STORE_JSON_FILENAME} into ${STORE_DATABASE_FILENAME}, but could not rename `
                + `${this.storeJsonPath} to ${base}: ${errorMessage(err)}. It is not read again.`, false);
        }
    }

    // A store.json next to a store.db that already holds the store is not imported, as it would
    // overwrite newer values with older ones. Most likely it is a copy put there to restore the
    // store, which only works in a data folder without store.db.
    public async reportStoreJsonLeftBehind(): Promise<void> {
        if (!await StoreJsonImport.exists(this.storeJsonPath)) return;
        this.callbacks.logWarning(`Not importing ${this.storeJsonPath}: ${STORE_DATABASE_FILENAME} already holds the data store. `
            + `To restore the store from it, stop the server and remove ${STORE_DATABASE_FILENAME} `
            + `(and ${STORE_DATABASE_FILENAME}-wal and -shm next to it) first.`);
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
