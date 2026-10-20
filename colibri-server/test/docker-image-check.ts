/**
 * Runs the Docker image the ways it is actually deployed and checks that each one can save
 * data, survives a restart with that data intact, and stops cleanly.
 *
 * The runtime runs as the unprivileged `node` user (uid 1000), and a data directory that user
 * cannot write is the one failure nothing else here would notice: `PUT /api/store` still
 * answers 201, the server keeps everything in memory, and what said otherwise used to land
 * only in the admin UI's in-memory log. Docker creates a missing bind-mount source as
 * root, and colibri-server 1.x ran as root, so both a first deployment and an upgrade hit it.
 *
 *   npm run test:docker
 *
 * Builds the image from this directory first, unless COLIBRI_DOCKER_IMAGE names one to use as
 * it is. Every container, volume and image it creates is named after COLIBRI_DOCKER_PREFIX
 * (default `colibri-image-check`) and removed again at the end. The web and TCP ports are
 * published on 127.0.0.1, on COLIBRI_DOCKER_PORT and the port after it when that is set, and
 * on ports Docker picks otherwise. Bind-mount sources go under COLIBRI_DOCKER_TMPDIR, or the
 * system temp directory. The TLS deployment's certificates are made with the openssl command line
 * tool.
 */
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import { PROTOCOL_VERSION, REST_MEDIA_TYPE, encodeHandshakeFrame } from '../src/server/modules/networking/protocol.js';
import { TestCertificate, createTestCertificate } from './tls-test-certificate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '..');

const PREFIX = process.env.COLIBRI_DOCKER_PREFIX || 'colibri-image-check';
const BASE_PORT = process.env.COLIBRI_DOCKER_PORT ? Number(process.env.COLIBRI_DOCKER_PORT) : undefined;
const TMP_ROOT = process.env.COLIBRI_DOCKER_TMPDIR || os.tmpdir();
const DATA_DIR = '/srv/colibri/data';

// What the admin UI build needs and the server never imports. None of it may reach the runtime.
const UI_ONLY_PACKAGES = [ '@angular', '@primeng', 'primeng', 'primeicons', 'd3', 'zone.js', 'socket.io-client', '@fontsource' ];

interface Result { stdout: string; stderr: string; code: number }

const docker = function (args: string[]): Promise<Result> {
    return new Promise(resolve => {
        execFile('docker', args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
            const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
            resolve({ stdout, stderr, code });
        });
    });
};

const dockerOk = async function (args: string[]): Promise<string> {
    const result = await docker(args);
    if (result.code !== 0) {
        throw new Error(`docker ${args.join(' ')} failed (${result.code}): ${result.stderr.trim()}`);
    }
    return result.stdout;
};

const sleep = (millis: number) => new Promise(resolve => setTimeout(resolve, millis));

const failures: string[] = [];
const check = function (label: string, ok: boolean, detail = ''): void {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? `: ${detail}` : ''}`);
    if (!ok) failures.push(label);
};

const created = { containers: new Set<string>(), volumes: new Set<string>(), images: new Set<string>() };

// Runs a throwaway root container, for the setup a host would have: a root-owned directory,
// or the data a 1.x install left behind. Uses node from the image under test, so the check
// needs no second image.
const asRoot = async function (image: string, mount: string, script: string): Promise<void> {
    await dockerOk([ 'run', '--rm', '--user', '0:0', '-v', `${mount}:/x`, '--entrypoint', 'node', image, '-e', script ]);
};

const logsOf = async function (container: string): Promise<string> {
    const result = await docker([ 'logs', container ]);
    return result.stdout + result.stderr;
};

const waitHealthy = async function (container: string, timeoutMillis = 90_000): Promise<string> {
    const deadline = Date.now() + timeoutMillis;
    let status = '';
    while (Date.now() < deadline) {
        status = (await dockerOk([ 'inspect', '-f', '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}', container ])).trim();
        if (status === 'running healthy' || status.startsWith('exited') || status.endsWith('unhealthy')) break;
        await sleep(1000);
    }
    return status;
};

const hostPort = async function (container: string, containerPort: number): Promise<number> {
    const out = await dockerOk([ 'port', container, `${containerPort}/tcp` ]);
    const port = Number(out.trim().split('\n')[0]?.split(':').pop());
    if (!Number.isInteger(port)) throw new Error(`No host port for ${container}:${containerPort}: ${out}`);
    return port;
};

const publish = function (offset: number, containerPort: number): string[] {
    return [ '-p', BASE_PORT ? `127.0.0.1:${BASE_PORT + offset}:${containerPort}` : `127.0.0.1::${containerPort}` ];
};

// Answers once the TCP worker sends anything back to a client that handshook - a published
// port alone proves nothing, since docker-proxy accepts the connection either way. Over TLS, the
// certificate is checked against the default CA certificates, which main() extends.
const tcpAnswers = function (port: number, useTls = false): Promise<boolean> {
    return new Promise(resolve => {
        const handshake = () => socket.write(encodeHandshakeFrame(PROTOCOL_VERSION, 'image-check', 'image-check'));
        const socket = useTls ? tls.connect({ port, host: '127.0.0.1' }, handshake) : net.connect(port, '127.0.0.1', handshake);
        const done = (ok: boolean) => {
            socket.destroy();
            resolve(ok);
        };
        const timer = setTimeout(() => done(false), 5000);
        socket.on('data', () => {
            clearTimeout(timer);
            done(true);
        });
        socket.on('error', () => {
            clearTimeout(timer);
            done(false);
        });
    });
};

// Whether the TCP port closes on a client that handshakes without TLS, without sending it anything.
const tcpRefusesWithoutTls = function (port: number): Promise<boolean> {
    return new Promise(resolve => {
        let received = 0;
        const socket = net.connect(port, '127.0.0.1', () => socket.write(encodeHandshakeFrame(PROTOCOL_VERSION, 'image-check', 'no-tls')));
        const timer = setTimeout(() => {
            socket.destroy();
            resolve(false);
        }, 5000);
        socket.on('data', data => (received += data.length));
        socket.on('error', () => undefined);
        socket.on('close', () => {
            clearTimeout(timer);
            resolve(received === 0);
        });
    });
};

// The SHA-256 fingerprint of the certificate a new TLS connection to the port is served.
const servedFingerprint = function (port: number): Promise<string | undefined> {
    return new Promise(resolve => {
        const socket = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false }, () => {
            resolve(socket.getPeerX509Certificate()?.fingerprint256);
            socket.destroy();
        });
        socket.on('error', () => resolve(undefined));
    });
};

// Does what the admin UI's log page does on load: connects over Socket.IO as the `colibri` app
// and asks for the log history, which by now holds at least the server's own startup lines.
const adminLogAnswers = function (web: string): Promise<boolean> {
    return new Promise(resolve => {
        const socket = io(web, { query: { app: 'colibri', version: PROTOCOL_VERSION }, transports: [ 'websocket' ], reconnection: false });
        const done = (ok: boolean) => {
            clearTimeout(timer);
            socket.close();
            resolve(ok);
        };
        const timer = setTimeout(() => done(false), 5000);
        socket.on('connect', () => socket.emit('colibri::log', { command: 'requestLog', payload: {} }));
        socket.on('colibri::log', (msg: { command?: string; payload?: { messages?: unknown[] } }) => {
            if (msg.command === 'history' && (msg.payload?.messages?.length ?? 0) > 0) done(true);
        });
        socket.on('connect_error', () => done(false));
    });
};

// The data store as store-export.js prints it, or '' if there is no store.db to read.
const readStore = async function (container: string): Promise<string> {
    const result = await docker([ 'exec', container, 'node', 'dist/server/store-export.js' ]);
    return result.code === 0 ? result.stdout : '';
};

const dataFiles = async function (container: string): Promise<string[]> {
    return (await dockerOk([ 'exec', container, 'ls', '-A', DATA_DIR ])).split('\n').filter(Boolean);
};

const serverUid = async function (container: string): Promise<string> {
    // PID 1 is the server itself: the entrypoint execs it, so `docker stop` signals node directly.
    const status = await dockerOk([ 'exec', container, 'cat', '/proc/1/status' ]);
    const cmdline = (await dockerOk([ 'exec', container, 'cat', '/proc/1/cmdline' ])).split('\0').join(' ').trim();
    const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1] ?? '?';
    return `${uid} ${cmdline}`;
};

// `docker logs` spans every run of the container, so the nth stop must find the nth line.
const stopCleanly = async function (container: string, nth: number): Promise<void> {
    await dockerOk([ 'stop', '-t', '15', container ]);
    const exitCode = (await dockerOk([ 'inspect', '-f', '{{.State.ExitCode}}', container ])).trim();
    const logs = await logsOf(container);
    const received = logs.split('Received SIGTERM, shutting down').length - 1;
    check('docker stop delivers SIGTERM to the server', received === nth, `${received} shutdown line(s)\n${logs.slice(-400)}`);
    // It was a bare console.log, the one line without a timestamp, level and source.
    const formatted = logs.match(/^\d{4}-\d\d-\d\dT[\d:.]+Z INFO {2}\[core\/Server\] Received SIGTERM, shutting down\.\.\.$/gm)?.length ?? 0;
    check('says so in the console log format', formatted === nth, `${formatted} formatted shutdown line(s)\n${logs.slice(-400)}`);
    check('exits with code 0', exitCode === '0', `exit code ${exitCode}`);
};

interface Deployment {
    name: string;
    // The -v argument; prepares whatever the host would already have.
    mount: (image: string) => Promise<string>;
    user?: string;
    // Further `docker run` options.
    dockerArgs?: string[];
    // The server's environment, and the container port that gives it to serve HTTP on.
    env?: Record<string, string>;
    webPort?: number;
    // Whether only the container itself can reach the web server, so that being healthy, and
    // stopping cleanly, is all there is to check.
    healthOnly?: boolean;
    // Seeded by mount(): an app/value that must be readable after startup.
    legacy?: { app: string; key: string; value: unknown };
    // Seeded by mount(): a symlink out of the data directory, whose target must stay root's.
    symlinkOut?: string;
    writable: boolean;
    // When not writable: the error the server must name, and a phrase of the fix it must
    // advise for that error. EACCES and the chown command unless given.
    failure?: { code: string; advice: string };
    // Whether the entrypoint cannot give the data directory to node, and must say so.
    chownFails?: boolean;
    // Serves TLS with `first`, from `dir` mounted read-only, and is then renewed to `second`.
    tls?: TlsSetup;
}

interface TlsSetup {
    dir: string;
    first: TestCertificate;
    second: TestCertificate;
}

// Puts a certificate where the container reads it from: what a renewal does.
const installCertificate = async function (setup: TlsSetup, certificate: TestCertificate): Promise<void> {
    await copyFile(certificate.certPath, path.join(setup.dir, 'fullchain.pem'));
    await copyFile(certificate.keyPath, path.join(setup.dir, 'privkey.pem'));
    // The server runs as uid 1000, which need not be the uid that made the key.
    await chmod(path.join(setup.dir, 'privkey.pem'), 0o644);
};

// TLS on both ports: the certificate, a client without TLS, and a renewal without a restart.
const checkTls = async function (container: string, webPort: number, setup: TlsSetup): Promise<void> {
    const web = await hostPort(container, webPort);
    const tcp = await hostPort(container, 9212);
    const logs = await logsOf(container);

    check('logs the certificate\'s SHA-256 fingerprint', logs.includes(`SHA-256 fingerprint ${setup.first.fingerprint256}`), logs.slice(0, 1500));
    check('serves the certificate on the web port', await servedFingerprint(web) === setup.first.fingerprint256);
    check('serves the certificate on the TCP port', await servedFingerprint(tcp) === setup.first.fingerprint256);
    check('serves no unencrypted HTTP', await fetch(`http://127.0.0.1:${web}/api/store`).then(() => false, () => true));
    check('refuses a TCP client without TLS, and sends it nothing', await tcpRefusesWithoutTls(tcp));
    check('says why it refused that client', (await logsOf(container)).includes('it does not use TLS'));

    await installCertificate(setup, setup.second);
    // Taken up once two reads 10 s apart have found it.
    let webRenewed = false;
    let tcpRenewed = false;
    for (let i = 0; i < 40 && !(webRenewed && tcpRenewed); i++) {
        await sleep(1000);
        webRenewed = await servedFingerprint(web) === setup.second.fingerprint256;
        tcpRenewed = await servedFingerprint(tcp) === setup.second.fingerprint256;
    }
    check('takes up a renewed certificate on the web port without a restart', webRenewed);
    check('takes up a renewed certificate on the TCP port without a restart', tcpRenewed);
    check('logs the renewal', (await logsOf(container)).includes(`(was ${setup.first.fingerprint256})`));
    check('TCP server answers a handshake over the renewed certificate', await tcpAnswers(tcp, true));
};


const runDeployment = async function (image: string, deployment: Deployment): Promise<void> {
    console.log(`\n${deployment.name}${deployment.user ? ` (--user ${deployment.user})` : ''}`);
    const container = `${PREFIX}-${deployment.name}`;
    await docker([ 'rm', '-f', container ]);

    const mount = await deployment.mount(image);
    const webPort = deployment.webPort ?? 9211;
    const args = [ 'run', '-d', '--name', container, ...publish(0, webPort), ...publish(1, 9212), '-v', mount, ...(deployment.dockerArgs ?? []) ];
    for (const [ name, value ] of Object.entries(deployment.env ?? {})) args.push('-e', `${name}=${value}`);
    if (deployment.user) args.push('--user', deployment.user);
    args.push(image);
    created.containers.add(container);
    await dockerOk(args);

    const health = await waitHealthy(container);
    check('becomes healthy', health === 'running healthy', `${health}\n${(await logsOf(container)).slice(-1500)}`);
    if (health !== 'running healthy') return;

    const proc = await serverUid(container);
    check('server is PID 1 and runs as uid 1000', proc.startsWith('1000 node '), proc);

    if (deployment.healthOnly) {
        await stopCleanly(container, 1);
        return;
    }

    const scheme = deployment.tls ? 'https' : 'http';
    const web = `${scheme}://127.0.0.1:${await hostPort(container, webPort)}`;

    if (deployment.symlinkOut) {
        const owner = (await dockerOk([ 'exec', container, 'stat', '-c', '%U', deployment.symlinkOut ])).trim();
        check('leaves the target of a symlink in the data directory alone', owner === 'root', `${deployment.symlinkOut} is owned by ${owner}`);
    }

    const index = await fetch(`${web}/`);
    const indexHtml = await index.text();
    check('serves the admin UI at /', index.status === 200 && indexHtml.includes('<app-root'), `HTTP ${index.status}`);
    // The bundles themselves, not only the page that loads them: index.html would be served by
    // the SPA fallback even if dist/ui were missing everything else.
    const assets = [ ...indexHtml.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g) ].map(match => match[1]!);
    const missing: string[] = [];
    for (const asset of new Set(assets)) {
        const res = await fetch(`${web}/${asset}`);
        if (res.status !== 200 || (await res.arrayBuffer()).byteLength === 0) missing.push(`${asset} (HTTP ${res.status})`);
    }
    check('serves the admin UI\'s scripts and styles', assets.length > 0 && missing.length === 0, missing.join(', ') || 'index.html references none');

    check('sends the admin UI its log over Socket.IO', await adminLogAnswers(web));

    check('TCP server answers a handshake', await tcpAnswers(await hostPort(container, 9212), deployment.tls !== undefined));

    const malformed = await fetch(`${web}/api/store/image-check/malformed`, {
        method: 'PUT',
        headers: { 'content-type': REST_MEDIA_TYPE },
        body: '{"unterminated',
    });
    const malformedBody = await malformed.text();
    check('answers malformed JSON without a stack trace', malformed.status === 400 && !malformedBody.includes('node_modules'), malformedBody.slice(0, 300));

    if (deployment.legacy) {
        const { app, key, value } = deployment.legacy;
        const res = await fetch(`${web}/api/store/${app}/${key}`);
        const body = res.status === 200 ? await res.json() : undefined;
        check('loads the store.json that was already there', JSON.stringify(body) === JSON.stringify(value), `HTTP ${res.status}`);
        if (deployment.writable) {
            const files = await dataFiles(container);
            check('imports it into store.db and renames it', files.includes('store.db') && !files.includes('store.json')
                && files.some(file => file.startsWith('store.json.imported-')), files.join(' '));
        }
    }

    const value = { saved: deployment.name };
    const put = await fetch(`${web}/api/store/image-check/value`, {
        method: 'PUT',
        headers: { 'content-type': REST_MEDIA_TYPE },
        body: JSON.stringify(value),
    });
    check('PUT /api/store answers 201', put.status === 201, `HTTP ${put.status}`);

    // In store.db as soon as the PUT is answered.
    const stored = await readStore(container);

    const logs = await logsOf(container);
    if (deployment.chownFails) {
        check('the entrypoint says it could not give the data directory to node', logs.includes('colibri-entrypoint: could not give'), logs.slice(0, 1500));
    }
    // It used to point at "the server's own message below" - which a directory node can still
    // write never gets.
    check('the entrypoint promises no warning from the server that does not come',
        !logs.includes('message below') || logs.includes('DATA_ROOT is not writable'), logs.slice(0, 1500));
    if (deployment.writable) {
        check('writes store.db', stored.includes(deployment.name), stored || '(no store.db)');
        check('logs no permission error', !/EACCES|EPERM|not writable/.test(logs), logs.slice(-1500));
    } else {
        const failure = deployment.failure ?? { code: 'EACCES', advice: 'chown -R 1000:1000' };
        check('does not pretend to have written store.db', !stored.includes(deployment.name));
        check(`says on stderr that DATA_ROOT is not writable, naming the path, the uid, ${failure.code} and its fix`,
            logs.includes(`DATA_ROOT is not writable: ${DATA_DIR}`) && logs.includes('uid 1000') && logs.includes(failure.code) && logs.includes(failure.advice),
            logs.slice(-2500));
        if (failure.code !== 'EACCES') {
            check(`does not advise chown for ${failure.code}`, !logs.includes('chown -R'), logs.slice(-2500));
        }
        check('says the data store keeps its values in memory', logs.includes(`Could not open ${DATA_DIR}/store.db`)
            && logs.includes('keeps its values in memory'), logs.slice(-1500));
        const get = await fetch(`${web}/api/store/image-check/value`);
        check('keeps serving the value from memory', get.status === 200 && JSON.stringify(await get.json()) === JSON.stringify(value));
    }

    if (deployment.tls) await checkTls(container, webPort, deployment.tls);

    await stopCleanly(container, 1);

    if (!deployment.writable) return;

    // The same data directory, a second time: what a restart, an image upgrade or a crash
    // followed by `restart: unless-stopped` all come down to.
    await dockerOk([ 'start', container ]);
    const again = await waitHealthy(container);
    check('comes back healthy on the same data', again === 'running healthy', again);
    if (again !== 'running healthy') return;
    const restartedWeb = `${scheme}://127.0.0.1:${await hostPort(container, webPort)}`;
    const res = await fetch(`${restartedWeb}/api/store/image-check/value`);
    const body = res.status === 200 ? await res.json() : undefined;
    check('still has the value after a restart', JSON.stringify(body) === JSON.stringify(value), `HTTP ${res.status}`);
    await stopCleanly(container, 2);
};

const main = async function (): Promise<void> {
    let image = process.env.COLIBRI_DOCKER_IMAGE;
    if (!image) {
        image = `${PREFIX}-img:test`;
        console.log(`Building ${image} from ${SERVER_DIR} ...`);
        created.images.add(image);
        await dockerOk([ 'build', '-q', '-t', image, SERVER_DIR ]);
    }

    console.log(`\nimage ${image}`);
    const env = JSON.parse(await dockerOk([ 'image', 'inspect', '-f', '{{json .Config.Env}}', image ])) as string[];
    check('sets NODE_ENV=production', env.includes('NODE_ENV=production'), env.join(' '));
    const installed = (await dockerOk([ 'run', '--rm', '--entrypoint', 'ls', image, '-A', 'node_modules' ])).split('\n');
    const leaked = UI_ONLY_PACKAGES.filter(name => installed.includes(name));
    check('installs no admin-UI-only packages', leaked.length === 0, leaked.join(', '));
    // A chown -R over /srv/colibri left the server's own code writable by the user it runs as,
    // and copied node_modules and dist into a layer of their own.
    const nodeOwned = (await dockerOk([ 'run', '--rm', '--entrypoint', 'find', image, '/srv/colibri', '-path', DATA_DIR, '-prune', '-o', '-user', 'node', '-print' ])).trim();
    check('gives the node user nothing outside the data directory', nodeOwned === '', nodeOwned.split('\n').slice(0, 5).join(', '));
    const dataOwner = (await dockerOk([ 'run', '--rm', '--entrypoint', 'stat', image, '-c', '%U:%G', DATA_DIR ])).trim();
    check('gives the node user the data directory', dataOwner === 'node:node', dataOwner);
    const size = (await dockerOk([ 'image', 'inspect', '-f', '{{.Size}}', image ])).trim();
    console.log(`  size ${(Number(size) / 1e6).toFixed(1)} MB`);

    const tmp = await mkdtemp(path.join(TMP_ROOT, `${PREFIX}-`));
    const rootOwnedDir = async function (name: string, files: Record<string, string>, img: string, symlinkOut?: string, mode = 0o755): Promise<string> {
        const dir = path.join(tmp, name);
        // Docker creates the missing source as root, and the root container fills it in, so
        // the directory and everything in it is owned by root - exactly what a 1.x install left.
        const link = symlinkOut ? `fs.symlinkSync(${JSON.stringify(symlinkOut)}, '/x/link-out-of-data');` : '';
        await asRoot(img, dir, `const fs = require('fs'); for (const [f, c] of Object.entries(${JSON.stringify(files)})) fs.writeFileSync('/x/' + f, c); ${link} fs.chmodSync('/x', ${mode});`);
        return `${dir}:${DATA_DIR}`;
    };
    const volume = async function (name: string): Promise<string> {
        const vol = `${PREFIX}-${name}`;
        await docker([ 'volume', 'rm', '-f', vol ]);
        created.volumes.add(vol);
        return `${vol}:${DATA_DIR}`;
    };

    // Self-signed, for 127.0.0.1 among others, and trusted from here on by everything in this
    // process that checks certificates: fetch, Socket.IO and tls.connect alike.
    const madeDir = path.join(tmp, 'tls-made');
    await mkdir(madeDir);
    const tlsSetup: TlsSetup = {
        dir: path.join(tmp, 'tls-mount'),
        first: createTestCertificate(madeDir, 'first'),
        second: createTestCertificate(madeDir, 'second'),
    };
    await mkdir(tlsSetup.dir);
    await chmod(tlsSetup.dir, 0o755);
    await installCertificate(tlsSetup, tlsSetup.first);
    tls.setDefaultCACertificates([ ...tls.getCACertificates('default'), tlsSetup.first.cert, tlsSetup.second.cert ]);

    const legacy = { app: 'legacy-app', key: 'greeting', value: 'stored by colibri 1.x' };
    const legacyStore = { 'store.json': JSON.stringify({ [legacy.app]: { [legacy.key]: legacy.value } }) };
    const envFile = path.join(tmp, 'web-port.env');
    await writeFile(envFile, 'WEBSERVER_PORT=9112\n', { mode: 0o644 });
    const deployments: Deployment[] = [
        {
            name: 'bind-missing-dir',
            mount: async () => `${path.join(tmp, 'bind-missing-dir')}:${DATA_DIR}`,
            writable: true,
        },
        {
            name: 'bind-root-owned-1x',
            mount: img => rootOwnedDir('bind-root-owned-1x', legacyStore, img, '/etc/shadow'),
            legacy,
            symlinkOut: '/etc/shadow',
            writable: true,
        },
        {
            name: 'named-volume',
            mount: () => volume('named-volume'),
            writable: true,
        },
        {
            name: 'user-1000-named-volume',
            mount: () => volume('user-1000-named-volume'),
            user: '1000:1000',
            writable: true,
        },
        {
            // Nothing can fix this one from inside: the container never has root. What it must
            // do is say so, loudly, and keep running.
            name: 'user-1000-root-owned-dir',
            mount: img => rootOwnedDir('user-1000-root-owned-dir', {}, img),
            user: '1000:1000',
            writable: false,
        },
        {
            // The 1.x data mounted read-only: chown fails, and so does every save. A chown
            // command would be no help, so the server must name the read-only mount instead.
            name: 'bind-read-only',
            mount: async img => `${await rootOwnedDir('bind-read-only', legacyStore, img)}:ro`,
            legacy,
            writable: false,
            failure: { code: 'EROFS', advice: 'drop ":ro"' },
            chownFails: true,
        },
        {
            // Without CAP_CHOWN - as on a file system without Unix owners - the entrypoint
            // cannot hand the 1.x data over. This directory is writable for everyone, though,
            // so the server can use it anyway and has nothing to warn about.
            name: 'bind-world-writable-no-chown',
            mount: img => rootOwnedDir('bind-world-writable-no-chown', legacyStore, img, undefined, 0o777),
            dockerArgs: [ '--cap-drop', 'CHOWN' ],
            legacy,
            writable: true,
            chownFails: true,
        },
        {
            // The health check has to ask the port the server listens on: one hard-coded to
            // the default port left this container unhealthy for good, and an orchestrator
            // restarting it.
            name: 'web-port-9111',
            mount: () => volume('web-port-9111'),
            env: { WEBSERVER_PORT: '9111' },
            webPort: 9111,
            writable: true,
        },
        {
            // ...and the host: Node binds localhost to ::1 here, which 127.0.0.1 never reaches.
            name: 'web-host-localhost',
            mount: () => volume('web-host-localhost'),
            env: { WEBSERVER_HOST: 'localhost' },
            writable: true,
            healthOnly: true,
        },
        {
            // ...wherever the port is set: the server also reads a .env in its working directory.
            name: 'web-port-from-env-file',
            mount: () => volume('web-port-from-env-file'),
            dockerArgs: [ '-v', `${envFile}:/srv/colibri/.env:ro` ],
            webPort: 9112,
            writable: true,
        },
        {
            // TLS on both ports, with a self-signed certificate mounted read-only. The health check
            // has to pass over HTTPS without trusting it, and a renewal has to be taken up without
            // a restart.
            name: 'tls-self-signed',
            mount: () => volume('tls-self-signed'),
            dockerArgs: [ '-v', `${tlsSetup.dir}:/srv/colibri/certs:ro` ],
            env: { TLS_CERT: '/srv/colibri/certs/fullchain.pem', TLS_KEY: '/srv/colibri/certs/privkey.pem' },
            tls: tlsSetup,
            writable: true,
        },
    ];

    try {
        const only = process.argv.slice(2);
        for (const deployment of deployments) {
            if (only.length > 0 && !only.includes(deployment.name)) continue;
            try {
                await runDeployment(image, deployment);
            } catch (err) {
                check(`${deployment.name} ran to completion`, false, err instanceof Error ? err.message : String(err));
            } finally {
                // A deployment that failed early leaves its container running, and with
                // COLIBRI_DOCKER_PORT set, the next one could not publish the same ports.
                await docker([ 'rm', '-f', '-v', `${PREFIX}-${deployment.name}` ]);
            }
        }
    } finally {
        for (const container of created.containers) await docker([ 'rm', '-f', '-v', container ]);
        for (const vol of created.volumes) await docker([ 'volume', 'rm', '-f', vol ]);
        // The bind-mount sources are root-owned by now (or node-owned, after the entrypoint),
        // so only a root container can remove what is inside them.
        await asRoot(image, tmp, 'for (const f of require("fs").readdirSync("/x")) require("fs").rmSync("/x/" + f, { recursive: true, force: true })').catch(() => undefined);
        await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
        for (const img of created.images) await docker([ 'rmi', img ]);
    }

    console.log(failures.length === 0 ? '\nAll checks passed.' : `\n${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`);
    process.exitCode = failures.length === 0 ? 0 : 1;
};

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
