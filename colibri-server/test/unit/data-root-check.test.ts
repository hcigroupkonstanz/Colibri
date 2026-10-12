import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { DataRootCheck } from '../../src/server/modules/core/data-root-check.js';
import { PRINTED_TO_CONSOLE } from '../../src/server/modules/core/console-log.js';
import { LogLevel, LogMessage } from '../../src/server/modules/core/log-message.js';
import { Service } from '../../src/server/modules/core/service.js';

// Permission bits do not stop root, so the unwritable-directory case cannot be set up as root.
const isRoot = process.getuid?.() === 0;
const isWindows = process.platform === 'win32';

let tmp: string;

beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'colibri-data-root-'));
});

afterEach(async () => {
    await chmod(tmp, 0o700).catch(() => undefined);
    for (const entry of await readdir(tmp).catch(() => [])) {
        await chmod(path.join(tmp, entry), 0o700).catch(() => undefined);
    }
    await rm(tmp, { recursive: true, force: true });
});

const run = async function (dir: string): Promise<{ ok: boolean; printed: string[]; logged: LogMessage[] }> {
    const printed: string[] = [];
    const logged: LogMessage[] = [];
    const subscription = Service.output$.subscribe(msg => {
        if (msg.origin === 'DataRoot') logged.push(msg);
    });
    try {
        const ok = await new DataRootCheck(dir, text => printed.push(text)).check();
        return { ok, printed, logged };
    } finally {
        subscription.unsubscribe();
    }
};

describe('DataRootCheck', () => {
    it('stays quiet about a writable directory, and leaves nothing behind in it', async () => {
        const result = await run(tmp);

        expect(result).toEqual({ ok: true, printed: [], logged: [] });
        expect(await readdir(tmp)).toEqual([]);
    });

    it('creates a missing directory, as the store would on its first save', async () => {
        const result = await run(path.join(tmp, 'data', 'nested'));

        expect(result.ok).toBe(true);
        expect(await readdir(path.join(tmp, 'data'))).toEqual([ 'nested' ]);
    });

    // What a PUT would otherwise find out only when its debounced save failed - after it had
    // already answered 201.
    it.skipIf(isRoot || isWindows)('says loudly that a directory it cannot write is not writable, and how to fix it', async () => {
        const dir = path.join(tmp, 'root-owned');
        await mkdir(dir, { mode: 0o555 });

        const { ok, printed, logged } = await run(dir);
        const uid = process.getuid!();
        const gid = process.getgid!();

        expect(ok).toBe(false);
        expect(printed).toHaveLength(1);
        const banner = printed[0]!;
        expect(banner).toContain(`DATA_ROOT is not writable: ${dir}`);
        expect(banner).toContain('EACCES');
        expect(banner).toContain(`runs as uid ${uid}`);
        expect(banner).toContain(`chown -R ${uid}:${gid} ${dir}`);
        // Offered only to the uid a new named volume belongs to; see the tests below.
        if (uid === 1000) {
            expect(banner).toContain('-v colibri-data:');
        } else {
            expect(banner).toContain('A named volume would not help');
        }

        // Once more for the admin UI, marked so the console sink does not print it twice.
        expect(logged).toHaveLength(1);
        expect(logged[0]!.level).toBe(LogLevel.Error);
        expect(logged[0]!.message).toContain(`DATA_ROOT is not writable: ${dir}`);
        expect(logged[0]!.metadata[PRINTED_TO_CONSOLE]).toBe(true);
    });

    it('reports a path it cannot use as a directory at all', async () => {
        const file = path.join(tmp, 'store.json');
        await writeFile(file, '{}');

        const { ok, printed } = await run(file);

        expect(ok).toBe(false);
        expect(printed[0]).toContain(`DATA_ROOT is not writable: ${file}`);
        expect(printed[0]).toContain('EEXIST');
        expect(printed[0]).toContain('is a file, not a directory');
        expect(printed[0]).not.toContain('chown');
    });

    it('reports a path below a file', async () => {
        const file = path.join(tmp, 'store.json');
        await writeFile(file, '{}');

        const { ok, printed } = await run(path.join(file, 'data'));

        expect(ok).toBe(false);
        expect(printed[0]).toContain('ENOTDIR');
        expect(printed[0]).toContain('is a file, not a directory');
        expect(printed[0]).not.toContain('chown');
    });

    it('names no uid where there is none to name', () => {
        const text = DataRootCheck.describe('C:\\colibri\\data', new Error('EPERM: operation not permitted'), undefined, undefined);

        expect(text).toContain('DATA_ROOT is not writable: C:\\colibri\\data');
        expect(text).not.toContain('chown');
        expect(text).not.toContain('uid');
    });

    // It used to advise `chown -R` whatever went wrong - no help at all for a read-only mount,
    // a file where the directory should be, or a full disk.
    describe('advises a fix for what actually went wrong', () => {
        const DIR = '/srv/colibri/data';

        // A uid of 1000 as in the image, unless given another, or null for none (Windows).
        const describeCode = (code: string | undefined, uid: number | null = 1000) => {
            const error: NodeJS.ErrnoException = new Error(`${code ?? 'Unknown'}: something, open '${DIR}/.colibri-write-check-1'`);
            if (code !== undefined) error.code = code;
            return DataRootCheck.describe(DIR, error, uid ?? undefined, uid ?? undefined);
        };

        it.each([ 'EACCES', 'EPERM' ])('%s: give the directory to the server\'s uid, or use a named volume', code => {
            const text = describeCode(code);

            expect(text).toContain('runs as uid 1000 (gid 1000)');
            expect(text).toContain(`chown -R 1000:1000 ${DIR}`);
            expect(text).toContain('or mount a\nnamed volume there instead of a host directory (-v colibri-data:<that path>)');
        });

        // A new named volume belongs to uid 1000, as /srv/colibri/data does in the image. It used
        // to be offered to any uid, and with docker run --user 1001 it fails just the same.
        it.each([ 'EACCES', 'EPERM' ])('%s as a uid other than 1000: give it the directory, and no named volume', code => {
            const text = describeCode(code, 1001);

            expect(text).toContain('runs as uid 1001 (gid 1001)');
            expect(text).toContain(`chown -R 1001:1001 ${DIR}`);
            expect(text).not.toContain('-v colibri-data');
            expect(text).not.toContain('mount a\nnamed volume');
            expect(text).toContain('A named volume would not help: a new one belongs to uid 1000');
            expect(text).toContain('not to uid 1001.');
        });

        it.each([ 'EACCES', 'EPERM' ])('%s without a uid: make it writable for whoever runs the server', code => {
            const text = describeCode(code, null);

            expect(text).toContain('make that directory writable for the user running the server');
            expect(text).not.toContain('chown');
        });

        it('EROFS: the mount is read-only', () => {
            const text = describeCode('EROFS');

            expect(text).toContain('read-only file system');
            expect(text).toContain(':ro');
            expect(text).not.toContain('chown');
        });

        it.each([ 'ENOTDIR', 'EEXIST' ])('%s: a file is in the way', code => {
            const text = describeCode(code);

            expect(text).toContain('is a file, not a directory');
            expect(text).not.toContain('chown');
        });

        it.each([ 'ENOSPC', 'EDQUOT' ])('%s: the disk is full', code => {
            const text = describeCode(code);

            expect(text).toContain('is full');
            expect(text).toContain('Free some space');
            expect(text).not.toContain('chown');
        });

        it.each([ 'EIO', undefined ])('%s: says what to make sure of, without guessing', code => {
            const text = describeCode(code);

            expect(text).toContain('make sure that path is a directory, and that the user running the server');
            expect(text).not.toContain('chown');
        });

        it('says in every case that nothing will be saved, and that the server keeps running', () => {
            for (const code of [ 'EACCES', 'EROFS', 'ENOTDIR', 'ENOSPC', 'EIO' ]) {
                const text = describeCode(code);
                expect(text).toContain(`DATA_ROOT is not writable: ${DIR}`);
                expect(text).toContain('store.json and voice recordings stay in memory');
                expect(text).toContain('It keeps running anyway.');
            }
        });
    });
});
