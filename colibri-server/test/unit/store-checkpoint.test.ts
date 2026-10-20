import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import type { Worker } from 'worker_threads';
import { StoreCheckpointer } from '../../src/server/modules/web/store-checkpoint.js';
import { StoreDatabase } from '../../src/server/modules/web/store-database.js';

describe('StoreCheckpointer', () => {
    const cleanup: Array<() => Promise<void> | void> = [];

    afterEach(async () => {
        for (const step of cleanup.splice(0).reverse()) await step();
    });

    // A store.db with automatic checkpoints off, as the server has it, and `bytes` of values that
    // so far are only in its write-ahead log.
    const storeWithUncheckpointedWrites = async (bytes: number): Promise<{ file: string; db: StoreDatabase }> => {
        const dir = await mkdtemp(path.join(tmpdir(), 'colibri-store-checkpoint-'));
        cleanup.push(() => rm(dir, { recursive: true, force: true }));
        const file = path.join(dir, 'store.db');
        const db = StoreDatabase.open(file);
        cleanup.push(() => db.close());
        db.initialize();
        db.setAutoCheckpoint(0);
        for (let written = 0; written < bytes; written += 100_000) db.put('app', `v${written}`, JSON.stringify('x'.repeat(100_000)));
        return { file, db };
    };

    it('copies the write-ahead log into the database from its worker thread', async () => {
        const { file } = await storeWithUncheckpointedWrites(2_000_000);
        const before = (await stat(file)).size;
        expect(before).toBeLessThan(100_000);

        const failures: Error[] = [];
        const checkpointer = StoreCheckpointer.start(file, 50, error => failures.push(error));
        cleanup.push(() => checkpointer.stop());

        await vi.waitFor(async () => {
            expect((await stat(file)).size).toBeGreaterThan(2_000_000);
        }, { timeout: 5000, interval: 50 });
        expect(failures).toEqual([]);
    });

    it('stops with a last checkpoint, and only once', async () => {
        const { file } = await storeWithUncheckpointedWrites(500_000);
        const checkpointer = StoreCheckpointer.start(file, 60_000, () => undefined);

        await checkpointer.stop();
        await checkpointer.stop();

        expect((await stat(file)).size).toBeGreaterThan(500_000);
    });

    it('says when its worker ends before it is stopped', async () => {
        const { file } = await storeWithUncheckpointedWrites(0);
        const failures: Array<[ string, boolean ]> = [];
        const checkpointer = StoreCheckpointer.start(file, 60_000, (error, workerGone) => failures.push([ error.message, workerGone ]));
        cleanup.push(() => checkpointer.stop());

        await (checkpointer as unknown as { worker: Worker }).worker.terminate();

        await vi.waitFor(() => expect(failures).toEqual([ [ expect.stringMatching(/^the checkpoint worker exited with code \d+$/), true ] ]));
    });
});
