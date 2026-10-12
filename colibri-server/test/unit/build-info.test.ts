import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { UNKNOWN_BUILD, collectBuildInfo, describeBuild, readBuildInfo } from '../../src/server/modules/core/build-info.js';

const COMMIT = '3e2855e0c1d2b3a4f5e6d7c8b9a0f1e2d3c4b5a6';
const NOW = new Date(1_700_000_000_000);

// git in a checkout at COMMIT, with `status` printing what is not committed.
const checkout = (status = '') => vi.fn((...args: string[]) => args[0] === 'rev-parse' ? `${COMMIT}\n` : status);

describe('the build info', () => {
    it('takes the commit from COLIBRI_COMMIT over git, as a Docker build passes it', () => {
        const git = checkout(' M src/server/main.ts\n');
        const { info, source } = collectBuildInfo({ COLIBRI_COMMIT: ` ${COMMIT.toUpperCase()} `, COLIBRI_COMMIT_DIRTY: 'true' }, git, NOW);

        expect(info).toEqual({ commit: COMMIT, dirty: true, builtAt: '2023-11-14T22:13:20.000Z' });
        expect(source).toBe('COLIBRI_COMMIT');
        expect(git).not.toHaveBeenCalled();
        expect(collectBuildInfo({ COLIBRI_COMMIT: COMMIT }, git, NOW).info.dirty).toBe(false);
    });

    it('asks git without COLIBRI_COMMIT, dirty with any change in colibri-server', () => {
        const clean = checkout();
        expect(collectBuildInfo({ COLIBRI_COMMIT: '' }, clean, NOW)).toEqual({ info: { commit: COMMIT, dirty: false, builtAt: NOW.toISOString() }, source: 'git' });
        expect(clean).toHaveBeenCalledWith('status', '--porcelain', '--', '.');

        expect(collectBuildInfo({}, checkout('?? src/server/fix.ts\n'), NOW).info).toEqual({ commit: COMMIT, dirty: true, builtAt: NOW.toISOString() });
    });

    it('builds on without git or a checkout, with the commit unknown', () => {
        const missing = () => {
            throw Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' });
        };
        const { info, source } = collectBuildInfo({}, missing, NOW);
        expect(info).toEqual({ commit: null, dirty: false, builtAt: NOW.toISOString() });
        expect(source).toMatch(/^nowhere/);

        // git that prints no hash, such as in a repository without a commit
        expect(collectBuildInfo({}, () => 'HEAD\n', NOW).info.commit).toBeNull();
    });

    it('takes no commit from a COLIBRI_COMMIT that is not a hash, and says so', () => {
        const git = checkout();
        const { info, source } = collectBuildInfo({ COLIBRI_COMMIT: 'my-fix', COLIBRI_COMMIT_DIRTY: 'true' }, git, NOW);
        expect(info).toEqual({ commit: null, dirty: false, builtAt: NOW.toISOString() });
        expect(source).toContain('not a commit hash');
        expect(git).not.toHaveBeenCalled();
    });
});

describe('reading the build info', () => {
    let directory: string;
    const file = (content: string) => {
        const path = join(directory, 'build-info.json');
        writeFileSync(path, content);
        return path;
    };

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), 'colibri-build-info-'));
    });

    afterEach(() => {
        rmSync(directory, { recursive: true, force: true });
    });

    it('reads the commit, whether it was dirty, and the build time', () => {
        const build = readBuildInfo(file(JSON.stringify({ commit: COMMIT, dirty: false, builtAt: '2023-11-14T22:13:20.000Z' })));
        expect(build).toEqual({ commit: COMMIT, dirty: false, builtAt: 1_700_000_000_000 });
        expect(describeBuild(build)).toBe('commit 3e2855e0c1');

        const dirty = readBuildInfo(file(JSON.stringify({ commit: COMMIT, dirty: true, builtAt: '2023-11-14T22:13:20.000Z' })));
        expect(dirty.dirty).toBe(true);
        expect(describeBuild(dirty)).toBe('commit 3e2855e0c1 (with uncommitted changes)');
    });

    it('knows nothing without the file, as after a build by tsc alone', () => {
        expect(readBuildInfo(join(directory, 'missing.json'))).toEqual(UNKNOWN_BUILD);
        expect(describeBuild(UNKNOWN_BUILD)).toBe('commit unknown (built without git information)');
    });

    it('takes nothing it does not expect from the file', () => {
        expect(readBuildInfo(file('{ not json'))).toEqual(UNKNOWN_BUILD);
        expect(readBuildInfo(file('null'))).toEqual(UNKNOWN_BUILD);
        expect(readBuildInfo(file(JSON.stringify({ commit: '<script>', dirty: true, builtAt: 'yesterday' })))).toEqual(UNKNOWN_BUILD);
        // built without git: the time is still known
        expect(readBuildInfo(file(JSON.stringify({ commit: null, dirty: false, builtAt: '2023-11-14T22:13:20.000Z' }))))
            .toEqual({ commit: null, dirty: false, builtAt: 1_700_000_000_000 });
    });
});

describe('npm run watch', () => {
    // tsc -w does not write dist/server/build-info.json, so one left by an earlier `npm run build`
    // had the server report that build's commit and time as its own.
    it('removes the build info of an earlier build before it compiles', () => {
        const scripts = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).scripts as Record<string, string>;
        const [ removal, compile, ...rest ] = scripts['server:watch:ts']!.split(' && ');
        expect(compile).toMatch(/^tsc .* -w$/);
        expect(rest).toEqual([]);

        const directory = mkdtempSync(join(tmpdir(), 'colibri-watch-'));
        try {
            const stale = join(directory, 'dist', 'server', 'build-info.json');
            mkdirSync(join(directory, 'dist', 'server'), { recursive: true });
            writeFileSync(stale, JSON.stringify({ commit: COMMIT, dirty: false, builtAt: NOW.toISOString() }));

            // Through the shell, as npm runs it: sh here, cmd.exe on Windows.
            execSync(removal!, { cwd: directory, stdio: 'ignore' });
            expect(existsSync(stale)).toBe(false);
            // Without one, as on a fresh checkout, it goes on to compile.
            expect(() => execSync(removal!, { cwd: directory, stdio: 'ignore' })).not.toThrow();
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
