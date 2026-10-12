#!/usr/bin/env node
/**
 * Runs colibri-unity's whole test suite: the EditMode unit tests, and the PlayMode end-to-end
 * tests against a real colibri-server.
 *
 *   node colibri-unity/run-tests.mjs                 both suites
 *   node colibri-unity/run-tests.mjs --editmode      unit tests only, no server needed
 *   node colibri-unity/run-tests.mjs --playmode      end-to-end only
 *   ... --stripping                                  also build a Release IL2CPP player with
 *                                                    Managed Stripping High and check that every
 *                                                    [Sync] member survives the linker (off by
 *                                                    default; skipped with a notice when the
 *                                                    IL2CPP module is not installed)
 *   ... --tls                                        also run the end-to-end tests a second time
 *                                                    over TLS: every connection they make, to the
 *                                                    TLS test server below or to the test's own
 *                                                    servers, with the plain-TCP-only fixtures
 *                                                    skipped (COLIBRI_E2E_TLS=1 does the same in
 *                                                    the Test Runner window)
 *
 * Environment (the same contract colibri-web's e2e suite uses):
 *   COLIBRI_E2E_SERVER     host of a server to use instead of starting one. Setting this means
 *                          the script never starts or stops anything.
 *   COLIBRI_E2E_PORT       web/Socket.IO port, default 9211
 *   COLIBRI_E2E_TCP_PORT   binary v3 port, default 9212
 *   COLIBRI_E2E_NO_BUILD   skip `docker compose --build`
 *   UNITY_PATH             Unity executable to use, if it is not where Unity Hub puts it
 *
 * The TLS tests (TlsTests, StoreOverTlsTests) and --tls need a second server with TLS turned on,
 * which is started from tls-test-server/compose.yml in the same way, with a certificate for tests
 * only:
 *   COLIBRI_E2E_TLS_PORT       its web port (https), default 9111
 *   COLIBRI_E2E_TLS_TCP_PORT   its binary port (TLS), default 9112
 *   COLIBRI_E2E_TLS_CERT       its certificate, default tls-test-server/cert.pem
 * Without it those tests are skipped, and this script says so; --tls then fails.
 *
 * A server already listening on the TCP port is used as it stands, whether or not the
 * environment says so - taking someone's running server down at the end of a test run would be a
 * poor way to repay them for it.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = __dirname;
const SERVER_DIR = path.resolve(__dirname, '../colibri-server');
const RESULTS_DIR = path.join(PROJECT_DIR, 'TestResults');

const HOST = process.env.COLIBRI_E2E_SERVER ?? '127.0.0.1';
const TCP_PORT = Number(process.env.COLIBRI_E2E_TCP_PORT ?? 9212);

const TLS_SERVER_DIR = path.join(PROJECT_DIR, 'tls-test-server');
const TLS_WEB_PORT = Number(process.env.COLIBRI_E2E_TLS_PORT ?? 9111);
const TLS_TCP_PORT = Number(process.env.COLIBRI_E2E_TLS_TCP_PORT ?? 9112);
const TLS_CERT = process.env.COLIBRI_E2E_TLS_CERT ?? path.join(TLS_SERVER_DIR, 'cert.pem');

const platforms = [];
if (process.argv.includes('--editmode')) platforms.push('EditMode');
if (process.argv.includes('--playmode')) platforms.push('PlayMode');
if (platforms.length === 0) platforms.push('EditMode', 'PlayMode');
const stripping = process.argv.includes('--stripping');
const overTls = process.argv.includes('--tls');


/*
 *  The server
 */

const isListening = (host, port, timeoutMs = 1000) =>
    new Promise(resolve => {
        const socket = net.connect(port, host);
        const done = result => {
            socket.destroy();
            resolve(result);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
    });

const waitForPort = async (host, port, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await isListening(host, port)) return;
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${host}:${port}`);
        await new Promise(resolve => setTimeout(resolve, 500));
    }
};

const startServer = async () => {
    if (await isListening(HOST, TCP_PORT)) {
        console.log(`Using the colibri-server already listening on ${HOST}:${TCP_PORT}.`);
        return async () => {};
    }

    if (process.env.COLIBRI_E2E_SERVER) {
        // An external server was named but is not up. Starting a local one would silently test
        // something other than what was asked for.
        throw new Error(
            `COLIBRI_E2E_SERVER is set to "${HOST}" but nothing is listening on port ${TCP_PORT}.`
        );
    }

    const args = ['compose', 'up', '-d'];
    if (!process.env.COLIBRI_E2E_NO_BUILD) args.push('--build');

    console.log(`Starting colibri-server (docker ${args.join(' ')})...`);
    try {
        await execFileAsync('docker', args, { cwd: SERVER_DIR });
    } catch (error) {
        throw new Error(
            `Could not start colibri-server with Docker: ${error.message}\n` +
                'Start a server another way and point the suite at it with COLIBRI_E2E_SERVER=127.0.0.1.'
        );
    }

    await waitForPort(HOST, TCP_PORT, 180_000);
    console.log(`colibri-server is up on ${HOST}:${TCP_PORT}.`);

    return async () => {
        console.log('Stopping colibri-server...');
        await execFileAsync('docker', ['compose', 'down'], { cwd: SERVER_DIR }).catch(() => {});
    };
};

/**
 * The second server, with TLS on, for the TLS tests. Not being able to start it skips those tests
 * rather than the whole run, but it is said, so that a run without them is not taken for a full one.
 */
const startTlsServer = async () => {
    // Handed to the Editor, which inherits this environment.
    process.env.COLIBRI_E2E_TLS_PORT = String(TLS_WEB_PORT);
    process.env.COLIBRI_E2E_TLS_TCP_PORT = String(TLS_TCP_PORT);
    process.env.COLIBRI_E2E_TLS_CERT = TLS_CERT;

    const nothingToStop = async () => {};
    if (await isListening(HOST, TLS_TCP_PORT)) {
        console.log(`Using the TLS server already listening on ${HOST}:${TLS_TCP_PORT}.`);
        return { up: true, stop: nothingToStop };
    }

    if (process.env.COLIBRI_E2E_SERVER) {
        console.log(`No TLS server on ${HOST}:${TLS_TCP_PORT}; the TLS tests will be skipped.`);
        return { up: false, stop: nothingToStop };
    }

    const args = ['compose', '-f', 'compose.yml', 'up', '-d'];
    if (!process.env.COLIBRI_E2E_NO_BUILD) args.push('--build');

    console.log(`Starting colibri-server with TLS (docker ${args.join(' ')} in tls-test-server)...`);
    try {
        await execFileAsync('docker', args, { cwd: TLS_SERVER_DIR });
        await waitForPort(HOST, TLS_TCP_PORT, 180_000);
    } catch (error) {
        console.log(`Could not start the TLS server, so the TLS tests will be skipped: ${error.message}`);
        return { up: false, stop: nothingToStop };
    }
    console.log(`colibri-server with TLS is up on ${HOST}:${TLS_TCP_PORT} (web ${TLS_WEB_PORT}).`);

    return {
        up: true,
        stop: async () => {
            console.log('Stopping the TLS server...');
            await execFileAsync('docker', ['compose', '-f', 'compose.yml', 'down'], { cwd: TLS_SERVER_DIR }).catch(() => {});
        },
    };
};


/*
 *  The Editor
 */

const hubDirectory = () =>
    ({
        win32: path.join('C:', 'Program Files', 'Unity', 'Hub', 'Editor'),
        darwin: '/Applications/Unity/Hub/Editor',
        linux: path.join(os.homedir(), 'Unity', 'Hub', 'Editor'),
    })[process.platform] ?? null;

const editorExecutable = version => {
    const hub = hubDirectory();
    if (!hub) return null;

    const relative = {
        win32: path.join('Editor', 'Unity.exe'),
        darwin: path.join('Unity.app', 'Contents', 'MacOS', 'Unity'),
        linux: path.join('Editor', 'Unity'),
    }[process.platform];

    const candidate = path.join(hub, version, relative);
    return existsSync(candidate) ? candidate : null;
};

/** Every editor Unity Hub has installed, so a version mismatch can say what you do have. */
const installedEditors = () => {
    const hub = hubDirectory();
    if (!hub || !existsSync(hub)) return [];

    try {
        return readdirSync(hub).filter(entry => editorExecutable(entry));
    } catch {
        return [];
    }
};

const projectEditorVersion = () => {
    const file = path.join(PROJECT_DIR, 'ProjectSettings', 'ProjectVersion.txt');
    const match = readFileSync(file, 'utf8').match(/m_EditorVersion:\s*(\S+)/);
    if (!match) throw new Error(`Cannot read the editor version from ${file}`);
    return match[1];
};

const findUnity = () => {
    if (process.env.UNITY_PATH) {
        if (!existsSync(process.env.UNITY_PATH)) {
            throw new Error(`UNITY_PATH points at ${process.env.UNITY_PATH}, which does not exist`);
        }
        return process.env.UNITY_PATH;
    }

    const version = projectEditorVersion();
    const exact = editorExecutable(version);
    if (exact) return exact;

    // Deliberately not falling back to whatever else is installed: opening the project with a
    // different editor upgrades it in place, which shows up as an unrelated diff in
    // ProjectVersion.txt, the package manifest and half of ProjectSettings. Better to say so than
    // to hand someone that diff and let them work out where it came from.
    const installed = installedEditors();
    const alternatives = installed.length
        ? `Installed here: ${installed.join(', ')}.\n` +
          `To use one of those instead: UNITY_PATH="${editorExecutable(installed[installed.length - 1])}"\n` +
          'It will upgrade the project in place, so commit the resulting ProjectVersion.txt and ' +
          'ProjectSettings changes deliberately rather than alongside something else.'
        : 'No editors were found where Unity Hub puts them; set UNITY_PATH to the one to use.';

    throw new Error(`Unity ${version} (from ProjectSettings/ProjectVersion.txt) is not installed.\n${alternatives}`);
};

/** `name` names the results and the log, for a second run of the same platform; `env` is added to this one's. */
const runUnity = (unity, platform, { name = platform, env = {} } = {}) =>
    new Promise(resolve => {
        const results = path.join(RESULTS_DIR, `${name}.xml`);
        const args = [
            '-batchmode',
            '-nographics',
            '-projectPath',
            PROJECT_DIR,
            '-runTests',
            '-testPlatform',
            platform,
            '-testResults',
            results,
            '-logFile',
            path.join(RESULTS_DIR, `${name}.log`),
        ];

        console.log(`\nRunning ${name} tests...`);
        const child = spawn(unity, args, { stdio: 'inherit', env: { ...process.env, ...env } });
        child.once('close', code => resolve({ platform, code, results }));
    });


/*
 *  The stripping check
 *
 *  [Sync] members are only reached through reflection, and an Editor never strips, so only a
 *  stripped player can show whether they survive the linker - with their [Sync], which is how
 *  SyncBehaviour finds them. Assets/StrippingCheck has the player's self-check and the build.
 */

/** The IL2CPP variations of this Editor's desktop player, or null where that module is missing. */
const il2cppVariations = unity => {
    const editor = path.dirname(unity);
    const candidates = {
        win32: [path.join(editor, 'Data', 'PlaybackEngines', 'windowsstandalonesupport', 'Variations')],
        linux: [path.join(editor, 'Data', 'PlaybackEngines', 'LinuxStandaloneSupport', 'Variations')],
        // Unity.app/Contents/MacOS/Unity: Hub puts modules beside Unity.app, older installs inside it.
        darwin: [
            path.join(editor, '..', '..', '..', 'PlaybackEngines', 'MacStandaloneSupport', 'Variations'),
            path.join(editor, '..', 'PlaybackEngines', 'MacStandaloneSupport', 'Variations'),
        ],
    }[process.platform] ?? [];
    return candidates.find(dir => existsSync(dir) && readdirSync(dir).some(entry => entry.includes('il2cpp'))) ?? null;
};

const strippingPlayerPath = () => {
    const dir = path.join(RESULTS_DIR, 'StrippingCheck');
    return {
        win32: path.join(dir, 'StrippingCheck.exe'),
        linux: path.join(dir, 'StrippingCheck.x86_64'),
        darwin: path.join(dir, 'StrippingCheck.app'),
    }[process.platform];
};

/** On macOS the player is a bundle; what runs is the one file in Contents/MacOS. */
const strippingPlayerExecutable = player => {
    if (process.platform !== 'darwin') return player;
    const macos = path.join(player, 'Contents', 'MacOS');
    return path.join(macos, readdirSync(macos)[0]);
};

const runProcess = (file, args, options = {}) =>
    new Promise(resolve => {
        const child = spawn(file, args, { stdio: 'inherit', ...options });
        child.once('close', code => resolve(code));
    });

/** TextMesh Pro's dynamic fallback font, part of the project's TMP Essential Resources. */
const TMP_FALLBACK_FONT = path.join(PROJECT_DIR, 'Assets', 'TextMesh Pro', 'Resources', 'Fonts & Materials',
    'LiberationSans SDF - Fallback.asset');

const runStrippingCheck = async unity => {
    const name = 'Stripping';
    if (!il2cppVariations(unity)) {
        console.log(
            `\n${name}: skipped - this Editor has no IL2CPP build support for ${process.platform} ` +
                '(Unity Hub > Installs > Add modules > the IL2CPP module for this platform).'
        );
        return { platform: name, ok: true, skipped: true };
    }

    const player = strippingPlayerPath();
    const buildLog = path.join(RESULTS_DIR, 'StrippingCheck-build.log');
    const playerLog = path.join(RESULTS_DIR, 'StrippingCheck-player.log');

    // A player build rewrites ProjectSettings (the Standalone backend and stripping level the
    // build sets and puts back, Unity Connect's settings) and adds glyphs to the atlas of
    // TextMesh Pro's dynamic fallback font, which would show up as unrelated diffs. Put every one
    // of those files back exactly as it was.
    const settingsDir = path.join(PROJECT_DIR, 'ProjectSettings');
    const settings = new Map(
        [
            ...readdirSync(settingsDir, { withFileTypes: true })
                .filter(entry => entry.isFile())
                .map(entry => path.join(settingsDir, entry.name)),
            TMP_FALLBACK_FONT,
        ]
            .filter(file => existsSync(file))
            .map(file => [file, readFileSync(file)])
    );

    console.log('\nBuilding the stripping-check player (Release, IL2CPP, Managed Stripping High)...');
    let buildCode;
    try {
        buildCode = await runProcess(
            unity,
            ['-batchmode', '-nographics', '-projectPath', PROJECT_DIR, '-executeMethod',
                'HCIKonstanz.Colibri.StrippingCheck.Editor.StrippingCheckBuild.Build', '-logFile', buildLog],
            { env: { ...process.env, COLIBRI_STRIPPING_PLAYER: player } }
        );
    } finally {
        for (const [file, contents] of settings) {
            if (!existsSync(file) || !readFileSync(file).equals(contents)) writeFileSync(file, contents);
        }
    }
    if (buildCode !== 0 || !existsSync(player)) {
        console.log(`\n${name}: the player did not build (exit ${buildCode}) - see ${buildLog}`);
        return { platform: name, ok: false };
    }

    console.log('Running it...');
    const code = await runProcess(
        strippingPlayerExecutable(player),
        ['-batchmode', '-nographics', '-colibriStrippingCheck', '-logFile', playerLog],
        // Its own output goes to the log; what matters is the exit code and the result lines.
        { timeout: 120_000, stdio: 'ignore' }
    );
    const lines = existsSync(playerLog)
        ? readFileSync(playerLog, 'utf8').split(/\r?\n/).filter(line => line.startsWith('[StrippingCheck]'))
        : [];
    console.log(`\n${name}: ${code === 0 ? 'passed' : `FAILED (exit ${code})`}`);
    for (const line of lines) console.log(`  ${line}`);
    if (lines.length === 0) console.log(`  The player logged no result - see ${playerLog}`);
    return { platform: name, ok: code === 0 };
};


/*
 *  Results
 */

const attribute = (xml, name) => {
    const match = xml.match(new RegExp(`\\b${name}="([^"]*)"`));
    return match ? match[1] : null;
};

const summarize = (platform, resultsFile) => {
    if (!existsSync(resultsFile)) {
        console.log(`\n${platform}: no results were written - see ${path.join(RESULTS_DIR, `${platform}.log`)}`);
        return { platform, ok: false, total: 0, passed: 0, failed: 0, skipped: 0 };
    }

    const xml = readFileSync(resultsFile, 'utf8');
    const header = xml.slice(0, xml.indexOf('>', xml.indexOf('<test-run')) + 1);

    const total = Number(attribute(header, 'total') ?? 0);
    const passed = Number(attribute(header, 'passed') ?? 0);
    const failed = Number(attribute(header, 'failed') ?? 0);
    const skipped = Number(attribute(header, 'skipped') ?? 0);

    console.log(`\n${platform}: ${passed} passed, ${failed} failed, ${skipped} skipped (${total} total)`);

    if (failed > 0) {
        for (const match of xml.matchAll(/<test-case\b[^>]*\bresult="Failed"[^>]*>([\s\S]*?)<\/test-case>/g)) {
            const name = attribute(match[0].slice(0, match[0].indexOf('>')), 'fullname');
            const message = match[1].match(/<message>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/message>/);
            console.log(`  FAILED  ${name}`);
            if (message) console.log(`          ${message[1].trim().split('\n')[0]}`);
        }
    }

    // Everything skipping means the suite could not run, which is not the same as passing.
    if (skipped > 0 && passed === 0 && total > 0) {
        console.log('  Every test was skipped - is colibri-server reachable?');
        return { platform, ok: false, total, passed, failed, skipped };
    }

    return { platform, ok: failed === 0 && total > 0, total, passed, failed, skipped };
};


/*
 *  Main
 */

const main = async () => {
    mkdirSync(RESULTS_DIR, { recursive: true });

    const unity = findUnity();
    console.log(`Unity: ${unity}`);

    const needsServer = platforms.includes('PlayMode') || overTls;
    const stopServer = needsServer ? await startServer() : async () => {};

    const summaries = [];
    let tlsServer = { up: false, stop: async () => {} };
    try {
        if (needsServer) tlsServer = await startTlsServer();

        for (const platform of platforms) {
            const run = await runUnity(unity, platform);
            summaries.push(summarize(platform, run.results));
        }

        if (overTls) {
            const name = 'PlayMode-TLS';
            if (tlsServer.up) {
                const run = await runUnity(unity, 'PlayMode', { name, env: { COLIBRI_E2E_TLS: '1' } });
                summaries.push(summarize(name, run.results));
            } else {
                console.log(`\n${name}: not run - there is no TLS server to run it against (see above).`);
                summaries.push({ platform: name, ok: false, total: 0, passed: 0, failed: 0, skipped: 0 });
            }
        }
    } finally {
        await tlsServer.stop();
        await stopServer();
    }

    // No server needed: the player checks itself and exits.
    if (stripping) summaries.push(await runStrippingCheck(unity));

    const ok = summaries.every(summary => summary.ok);
    console.log(ok ? '\nAll suites passed.' : '\nSuite failed.');
    process.exit(ok ? 0 : 1);
};

main().catch(error => {
    console.error(`\n${error.message}`);
    process.exit(1);
});
