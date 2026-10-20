// The commit the server was built from. `npm run build` writes it to dist/server/build-info.json
// (write-build-info.ts), and main.ts reads it at startup.
import { readFileSync } from 'fs';

export interface BuildInfoFile {
    // Null if no commit was found. dirty covers colibri-server only; builtAt is ISO 8601.
    commit: string | null;
    dirty: boolean;
    builtAt: string;
}

export interface BuildInfo {
    commit: string | null;
    dirty: boolean;
    // Date.now() at build time; null when unknown.
    builtAt: number | null;
}

export const UNKNOWN_BUILD: BuildInfo = { commit: null, dirty: false, builtAt: null };

// Hash digits shown in the log. Unique in this repository for a long time, and git takes them wherever
// it takes a hash. The admin UI keeps its own copy (server.component.ts).
export const SHORT_COMMIT_LENGTH = 10;

// 7 to 64 hex digits: a short hash as git prints it, up to a SHA-256 one.
const COMMIT_HASH = /^[0-9a-f]{7,64}$/;

const commitOf = function (value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const hash = value.trim().toLowerCase();
    return COMMIT_HASH.test(hash) ? hash : null;
};

const isTrue = function (value: string | undefined): boolean {
    return [ 'true', '1', 'yes' ].includes(value?.trim().toLowerCase() ?? '');
};

// Runs git in colibri-server and returns its output. Throws when git is missing, there is no checkout,
// or git fails.
export type Git = (...args: string[]) => string;

/**
 * Records the commit, and whether colibri-server has uncommitted changes, for `npm run build`.
 * If COLIBRI_COMMIT is set, it is the only source, and COLIBRI_COMMIT_DIRTY gives the dirty flag: a
 * Docker build has no .git, so it gets both as build arguments. A value that is not a hash gives no
 * commit. Otherwise git is asked about colibri-server only, untracked files included, and a failed
 * `git status` counts as clean. `source` names where the commit came from.
 */
export const collectBuildInfo = function (env: NodeJS.ProcessEnv, git: Git, now = new Date()): { info: BuildInfoFile; source: string } {
    const builtAt = now.toISOString();

    const fromEnv = env['COLIBRI_COMMIT']?.trim();
    if (fromEnv) {
        const commit = commitOf(fromEnv);
        return commit
            ? { info: { commit, dirty: isTrue(env['COLIBRI_COMMIT_DIRTY']), builtAt }, source: 'COLIBRI_COMMIT' }
            : { info: { commit: null, dirty: false, builtAt }, source: `COLIBRI_COMMIT, which is not a commit hash: '${fromEnv.slice(0, 80)}'` };
    }

    let commit: string | null = null;
    try {
        commit = commitOf(git('rev-parse', 'HEAD'));
    } catch {
        // no git, or no checkout: the build goes on without
    }
    if (!commit) return { info: { commit: null, dirty: false, builtAt }, source: 'nowhere: no COLIBRI_COMMIT, and no git checkout to ask' };

    let dirty = false;
    try {
        dirty = git('status', '--porcelain', '--', '.').trim() !== '';
    } catch {
        // the commit is known all the same
    }
    return { info: { commit, dirty, builtAt }, source: 'git' };
};

// A tsc-only build writes no file, so without one everything is unknown. `npm run watch` deletes the
// old file, which would name an earlier build's commit. A bad commit or builtAt is unknown, and dirty
// counts only with a commit.
export const readBuildInfo = function (path: string): BuildInfo {
    let fields: Record<string, unknown>;
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
        if (parsed === null || typeof parsed !== 'object') return UNKNOWN_BUILD;
        fields = parsed as Record<string, unknown>;
    } catch {
        return UNKNOWN_BUILD;
    }

    const commit = commitOf(fields['commit']);
    const builtAt = typeof fields['builtAt'] === 'string' ? Date.parse(fields['builtAt']) : NaN;
    return { commit, dirty: commit !== null && fields['dirty'] === true, builtAt: Number.isFinite(builtAt) ? builtAt : null };
};

export const describeBuild = function (build: BuildInfo): string {
    if (build.commit === null) return 'commit unknown (built without git information)';
    return `commit ${build.commit.slice(0, SHORT_COMMIT_LENGTH)}${build.dirty ? ' (with uncommitted changes)' : ''}`;
};
