import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
    repository?: { directory?: string };
    engines?: { node?: string };
};

// Every script `npm publish` runs on its own, by name. See
// https://docs.npmjs.com/cli/using-npm/scripts#npm-publish
const PUBLISH_LIFECYCLE = ['prepublishOnly', 'prepack', 'prepare', 'postpack', 'publish', 'postpublish'];

describe('package.json scripts', () => {
    // A script named `publish` is not an alias npm runs instead of publishing - it is a hook npm
    // runs *after* publishing. One that itself calls `npm publish` therefore publishes, then tries
    // to publish the same version again, which fails and turns a successful release into a
    // non-zero exit.
    it.each(PUBLISH_LIFECYCLE)('the %s hook does not call npm publish again', hook => {
        expect(pkg.scripts[hook] ?? '').not.toMatch(/\bnpm\s+publish\b/);
    });
});

describe('package.json repository', () => {
    // The package lives in a subdirectory of the repository. npmjs.com resolves the README's
    // relative links (to CHANGELOG.md, docs/, the samples) against the repository URL plus this
    // directory, so without it every one of them pointed at the repository root, where those
    // files are not.
    it('names the directory the package lives in', () => {
        const packageDir = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
        const repositoryRoot = path.dirname(packageDir);
        const directory = pkg.repository?.directory ?? '';

        expect(directory).toBe(path.basename(packageDir));
        expect(existsSync(path.join(repositoryRoot, directory, 'README.md'))).toBe(true);
    });
});

describe('package.json engines', () => {
    // A consumer installs this package with whatever Node their toolchain has, mostly to bundle it
    // for the browser, and yarn refuses the install outright when `engines` does not match. The
    // built library needs ES2022 (Node 16.11) and, for the REST helpers under Node, the global fetch
    // of Node 18. Asking for more only broke `yarn add` on machines that run it fine; what the
    // repository's own tooling needs belongs in devEngines, which consumers never check.
    it('asks consumers for no newer Node than the built library needs', () => {
        const floor = /^>=\s*(\d+)/.exec(pkg.engines?.node ?? '>=0');
        expect(floor).not.toBeNull();
        expect(Number(floor?.[1])).toBeLessThanOrEqual(18);
    });
});
