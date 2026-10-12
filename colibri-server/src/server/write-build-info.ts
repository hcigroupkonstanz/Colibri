// Run by `npm run build` after tsc: records the commit the server is built from in
// dist/server/build-info.json, next to main.js, which reads it at startup. Without COLIBRI_COMMIT and
// without git, the commit is unknown and the build goes on.
import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { collectBuildInfo } from './modules/core/build-info.js';

const serverDirectory = fileURLToPath(new URL('../..', import.meta.url));
const file = fileURLToPath(new URL('./build-info.json', import.meta.url));

const git = function (...args: string[]): string {
    return execFileSync('git', args, { cwd: serverDirectory, encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'ignore' ], timeout: 10_000 });
};

const { info, source } = collectBuildInfo(process.env, git);
writeFileSync(file, JSON.stringify(info, null, 2) + '\n');
console.log(`Build info: commit ${info.commit ?? 'unknown'}${info.dirty ? ', with uncommitted changes' : ''}, from ${source}`);
