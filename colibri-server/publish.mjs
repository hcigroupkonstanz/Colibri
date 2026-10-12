import { exec, execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const p = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const run = (cmd) => {
    return new Promise((resolve, reject) => {
        exec(cmd, (err, stdout, stderr) => {
            console.log(stdout);

            if (err) {
                console.error(stderr);
                reject(err);
            } else {
                resolve(stdout);
            }
        });
    });
};

// The commit the image is built from, for the server to report: the build context has no .git. As
// `npm run build` asks git, with uncommitted changes in colibri-server making it dirty.
const git = (...args) => execFileSync('git', args, {
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    encoding: 'utf8',
    stdio: [ 'ignore', 'pipe', 'ignore' ],
}).trim();

const buildArgs = () => {
    try {
        const commit = git('rev-parse', 'HEAD');
        const dirty = git('status', '--porcelain', '--', '.') !== '';
        console.log(`Building commit ${commit}${dirty ? ', with uncommitted changes' : ''}`);
        return `--build-arg COLIBRI_COMMIT=${commit} --build-arg COLIBRI_COMMIT_DIRTY=${dirty}`;
    } catch {
        console.warn('No git checkout: the image reports its commit as unknown');
        return '';
    }
};

(async () => {
    await run(`docker build ${buildArgs()} . -t hcikn/colibri:${p.version}`);
    await run(`docker push hcikn/colibri:${p.version}`);
    await run(`docker tag hcikn/colibri:${p.version} hcikn/colibri:latest`);
    await run('docker push hcikn/colibri:latest');
})();
