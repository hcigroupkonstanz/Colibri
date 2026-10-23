// Prints the data store as JSON on stdout, in the shape store.json had: { "<app>": { "<name>": <value> } }.
//
//   node dist/server/store-export.js [store.db] > store.json
//
// Without an argument it reads store.db in DATA_ROOT. It opens the database read-only, so it can
// run while the server does. Its output, put into a data folder without store.db as store.json, is
// imported at the server's next start: that is how a store is restored from a backup.
import * as path from 'path';
import { Config } from './configuration.js';
import { errorMessage } from './modules/core/error-message.js';
import { STORE_DATABASE_FILENAME, StoreDatabase, writeStoreJson } from './modules/store/store-database.js';

const exportStore = async function (file: string, out: NodeJS.WritableStream): Promise<void> {
    const store = StoreDatabase.openReadOnly(file);
    try {
        await writeStoreJson(store, out);
    } finally {
        store.close();
    }
};

const file = process.argv[2] ?? path.join(Config.DATA_ROOT, STORE_DATABASE_FILENAME);
exportStore(file, process.stdout).catch((err: unknown) => {
    console.error(`Could not export the data store from ${file}: ${errorMessage(err)}`);
    process.exitCode = 1;
});
