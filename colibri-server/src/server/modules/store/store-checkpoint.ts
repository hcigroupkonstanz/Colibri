import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'url';
import { isMainThread, parentPort, Worker, workerData } from 'worker_threads';

// Only builtins are imported here: this file is also the worker's entry point, which Node runs by
// itself, in the tests straight from TypeScript.

const ROLE = 'colibri-store-checkpoint';
const STOP_TIMEOUT_MILLIS = 2000;

export type CheckpointFailure = (error: Error, workerGone: boolean) => void;

interface CheckpointWorkerData {
    role: typeof ROLE;
    file: string;
    intervalMillis: number;
}

/**
 * Copies the data store's write-ahead log into store.db from a worker thread, every
 * `intervalMillis`.
 *
 * SQLite's automatic checkpoint runs in the connection whose commit makes the log pass 1000 pages,
 * and with synchronous=NORMAL it syncs the log and the database to disk there. For the server that
 * was the main thread, in the middle of a PUT: 16 to 63 ms about every 500 small PUTs, during which
 * no realtime message was relayed. The server's connection now has automatic checkpoints off, and
 * this worker's own connection does them. A PASSIVE checkpoint never waits for the writer.
 */
export class StoreCheckpointer {
    private readonly worker: Worker;
    private stopping = false;
    private exited = false;

    private constructor(file: string, intervalMillis: number, onFailure: CheckpointFailure) {
        const data: CheckpointWorkerData = { role: ROLE, file, intervalMillis };
        this.worker = new Worker(fileURLToPath(import.meta.url), { workerData: data });
        // It never keeps the process alive by itself.
        this.worker.unref();
        this.worker.on('message', (message: { error?: string }) => {
            if (message.error !== undefined) onFailure(new Error(message.error), false);
        });
        this.worker.on('error', err => onFailure(err, false));
        this.worker.on('exit', code => {
            this.exited = true;
            if (!this.stopping) onFailure(new Error(`the checkpoint worker exited with code ${code}`), true);
        });
    }

    /**
     * Starts checkpointing `file`. `onFailure` is told of every failed checkpoint, and, with
     * `workerGone`, of the worker ending before stop(), after which nothing checkpoints any more.
     */
    public static start(file: string, intervalMillis: number, onFailure: CheckpointFailure): StoreCheckpointer {
        return new StoreCheckpointer(file, intervalMillis, onFailure);
    }

    /**
     * Resolves once the worker has done a last checkpoint and closed its connection, or after
     * STOP_TIMEOUT_MILLIS, when it is terminated.
     */
    public async stop(): Promise<void> {
        if (this.stopping) return;
        this.stopping = true;
        if (this.exited) return;
        const exited = new Promise<void>(resolve => this.worker.once('exit', () => resolve()));
        this.worker.postMessage('stop');
        let timer: NodeJS.Timeout | undefined;
        const timedOut = new Promise<'timeout'>(resolve => {
            timer = setTimeout(() => resolve('timeout'), STOP_TIMEOUT_MILLIS);
        });
        if (await Promise.race([ exited, timedOut ]) === 'timeout') await this.worker.terminate();
        clearTimeout(timer);
    }
}

const runWorker = function (data: CheckpointWorkerData): void {
    const db = new DatabaseSync(data.file, { timeout: 1000 });
    const checkpoint = (): void => {
        try {
            db.exec('PRAGMA wal_checkpoint(PASSIVE)');
        } catch (err) {
            parentPort!.postMessage({ error: err instanceof Error ? err.message : String(err) });
        }
    };
    const timer = setInterval(checkpoint, data.intervalMillis);
    parentPort!.on('message', message => {
        if (message !== 'stop') return;
        clearInterval(timer);
        checkpoint();
        db.close();
        parentPort!.close();
    });
};

if (!isMainThread && (workerData as Partial<CheckpointWorkerData> | null)?.role === ROLE) {
    runWorker(workerData as CheckpointWorkerData);
}
