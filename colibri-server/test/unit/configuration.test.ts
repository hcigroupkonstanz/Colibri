import { describe, it, expect, afterEach, afterAll, beforeAll, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { TestCertificate } from '../tls-test-certificate.js';
import { createTestCertificate, encryptTestKey } from '../tls-test-certificate.js';

// configuration.ts resolves its paths against its own directory: src/server here,
// dist/server in a build.
const CONFIG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/server');

// Config is computed when the module is first evaluated, so each case evaluates it afresh.
const loadConfiguration = async (env: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(env)) {
        vi.stubEnv(name, value);
    }
    vi.resetModules();
    return import('../../src/server/configuration.js');
};

const loadConfig = async (env: Record<string, string | undefined>) => (await loadConfiguration(env)).Config;

// What main.ts logs at startup for these settings.
const startupWarnings = async (env: Record<string, string | undefined>) => {
    const { Config, configurationWarnings } = await loadConfiguration(env);
    return configurationWarnings(Config);
};

// What main.ts passes on as the server topic's tlsAtProxy.tcp.
const tcpTlsAtProxy = async (env: Record<string, string | undefined>) => {
    const { Config, tcpTlsAtProxyInEffect } = await loadConfiguration(env);
    return tcpTlsAtProxyInEffect(Config);
};

describe('Config', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    describe('DATA_ROOT and WEBSERVER_ROOT', () => {
        it('honour an absolute path as it is', async () => {
            const config = await loadConfig({ DATA_ROOT: '/var/lib/colibri', WEBSERVER_ROOT: '/srv/colibri-ui/' });

            expect(config.DATA_ROOT).toBe(path.resolve('/var/lib/colibri'));
            expect(config.WEBSERVER_ROOT).toBe(path.resolve('/srv/colibri-ui'));
        });

        it('resolve a relative path against the server directory, to the same place as before', async () => {
            const config = await loadConfig({ DATA_ROOT: '../../my-data', WEBSERVER_ROOT: 'public' });

            expect(config.DATA_ROOT).toBe(path.resolve(CONFIG_DIR, '../../my-data'));
            expect(config.WEBSERVER_ROOT).toBe(path.resolve(CONFIG_DIR, 'public'));
            // ...which is where path.join(__dirname, value) pointed, minus a trailing separator
            expect(path.relative(path.join(CONFIG_DIR, '../../my-data'), config.DATA_ROOT)).toBe('');
            expect(path.relative(path.join(CONFIG_DIR, 'public'), config.WEBSERVER_ROOT)).toBe('');
        });

        it('default to the data and ui directories next to the build', async () => {
            const config = await loadConfig({ DATA_ROOT: '', WEBSERVER_ROOT: '' });

            expect(config.DATA_ROOT).toBe(path.resolve(CONFIG_DIR, '../../data'));
            expect(config.WEBSERVER_ROOT).toBe(path.resolve(CONFIG_DIR, '../ui'));
        });
    });

    describe('ports', () => {
        // Not 1.x's 9011, 9012 and 9013, so that a 1.x server can run next to this one, and a
        // client of one version does not reach the other by its defaults.
        it('default to 9211 (web), 9212 (TCP) and 9213 (voice)', async () => {
            const config = await loadConfig({ WEBSERVER_PORT: undefined, TCP_PORT: undefined, VOICE_PORT: undefined });

            expect([ config.WEBSERVER_PORT, config.TCP_PORT, config.VOICE_PORT ]).toEqual([ 9211, 9212, 9213 ]);
        });

        it('take the 1.x ports when set', async () => {
            const config = await loadConfig({ WEBSERVER_PORT: '9011', TCP_PORT: '9012', VOICE_PORT: '9013' });

            expect([ config.WEBSERVER_PORT, config.TCP_PORT, config.VOICE_PORT ]).toEqual([ 9011, 9012, 9013 ]);
        });
    });

    describe('hosts', () => {
        // :: listens on IPv6 and IPv4. 1.x listened on IPv4 only.
        it('default to :: for web, TCP and voice', async () => {
            const config = await loadConfig({ WEBSERVER_HOST: undefined, TCP_HOST: undefined, VOICE_HOST: undefined });

            expect([ config.WEBSERVER_HOST, config.TCP_HOST, config.VOICE_HOST ]).toEqual([ '::', '::', '::' ]);
        });

        it('take 0.0.0.0 for IPv4 only when set', async () => {
            const config = await loadConfig({ WEBSERVER_HOST: '0.0.0.0', TCP_HOST: '0.0.0.0', VOICE_HOST: '0.0.0.0' });

            expect([ config.WEBSERVER_HOST, config.TCP_HOST, config.VOICE_HOST ]).toEqual([ '0.0.0.0', '0.0.0.0', '0.0.0.0' ]);
        });
    });

    describe('inbound limits', () => {
        it('default to dropping past a backlog of 2000 TCP messages', async () => {
            const config = await loadConfig({ TCP_INBOUND_BACKLOG_LIMIT: undefined });

            expect(config.TCP_INBOUND_BACKLOG_LIMIT).toBe(2000);
        });

        it('take 0 to turn a limit off', async () => {
            const config = await loadConfig({ TCP_INBOUND_BACKLOG_LIMIT: '0' });

            expect(config.TCP_INBOUND_BACKLOG_LIMIT).toBe(0);
        });

        it.each(['-1', '1.5', 'lots'])('refuse to start with a limit of "%s"', async (raw) => {
            await expect(loadConfig({ TCP_INBOUND_BACKLOG_LIMIT: raw })).rejects.toThrow('TCP_INBOUND_BACKLOG_LIMIT');
        });

        it('default to 1000 messages a second per client, in bursts of up to 2000', async () => {
            const config = await loadConfig({ CLIENT_MESSAGE_RATE_LIMIT: undefined, CLIENT_MESSAGE_RATE_BURST: undefined });

            expect(config.CLIENT_MESSAGE_RATE_LIMIT).toBe(1000);
            expect(config.CLIENT_MESSAGE_RATE_BURST).toBe(2000);
        });

        it('take a rate limit of 0 to turn it off', async () => {
            const config = await loadConfig({ CLIENT_MESSAGE_RATE_LIMIT: '0', CLIENT_MESSAGE_RATE_BURST: '500' });

            expect(config.CLIENT_MESSAGE_RATE_LIMIT).toBe(0);
            expect(config.CLIENT_MESSAGE_RATE_BURST).toBe(500);
        });

        it('default to disconnecting a TCP client after 10 s of silence, and take 0 to never', async () => {
            expect((await loadConfig({ TCP_IDLE_TIMEOUT_SECONDS: undefined })).TCP_IDLE_TIMEOUT_SECONDS).toBe(10);
            expect((await loadConfig({ TCP_IDLE_TIMEOUT_SECONDS: '0' })).TCP_IDLE_TIMEOUT_SECONDS).toBe(0);
        });

        it('default to warning about an app of more than 8 clients, and take 0 to never warn', async () => {
            expect((await loadConfig({ APP_CLIENT_WARNING_THRESHOLD: undefined })).APP_CLIENT_WARNING_THRESHOLD).toBe(8);
            expect((await loadConfig({ APP_CLIENT_WARNING_THRESHOLD: '0' })).APP_CLIENT_WARNING_THRESHOLD).toBe(0);
        });

        // A bucket that can never hold a token would drop every update.
        it('refuse a burst of 0', async () => {
            await expect(loadConfig({ CLIENT_MESSAGE_RATE_BURST: '0' })).rejects.toThrow('CLIENT_MESSAGE_RATE_BURST');
        });
    });

    describe('MODEL_TOMBSTONE_SECONDS', () => {
        it('defaults to remembering a deleted model for 10 minutes, and takes 0 to not remember it', async () => {
            expect((await loadConfig({ MODEL_TOMBSTONE_SECONDS: undefined })).MODEL_TOMBSTONE_SECONDS).toBe(600);
            expect((await loadConfig({ MODEL_TOMBSTONE_SECONDS: '0' })).MODEL_TOMBSTONE_SECONDS).toBe(0);
            expect((await loadConfig({ MODEL_TOMBSTONE_SECONDS: '30' })).MODEL_TOMBSTONE_SECONDS).toBe(30);
        });

        it.each(['-1', '2.5', 'forever'])('refuses to start with "%s"', async (raw) => {
            await expect(loadConfig({ MODEL_TOMBSTONE_SECONDS: raw })).rejects.toThrow('MODEL_TOMBSTONE_SECONDS');
        });
    });

    describe('PROXY_TLS_ADDRESSES', () => {
        it('is empty by default, and takes host names with ports', async () => {
            expect((await loadConfig({ PROXY_TLS_ADDRESSES: undefined })).PROXY_TLS_ADDRESSES).toEqual([]);
            expect((await loadConfig({ PROXY_TLS_ADDRESSES: 'colibri.example.org, colibri.example.org:9212' })).PROXY_TLS_ADDRESSES)
                .toEqual([ { host: 'colibri.example.org', port: 443 }, { host: 'colibri.example.org', port: 9212 } ]);
        });

        it('refuses to start with an entry that is no address, naming it', async () => {
            await expect(loadConfig({ PROXY_TLS_ADDRESSES: 'https://colibri.example.org' }))
                .rejects.toThrow('Invalid PROXY_TLS_ADDRESSES: "https://colibri.example.org"');
        });
    });
    
    describe('data store', () => {
        it('defaults to deleting values not written for 30 days, and takes 0 to keep them', async () => {
            expect((await loadConfig({ STORE_EXPIRY_DAYS: undefined })).STORE_EXPIRY_DAYS).toBe(30);
            expect((await loadConfig({ STORE_EXPIRY_DAYS: '0' })).STORE_EXPIRY_DAYS).toBe(0);
            expect((await loadConfig({ STORE_EXPIRY_DAYS: '7' })).STORE_EXPIRY_DAYS).toBe(7);
        });

        it('defaults to no size limit, and takes one in MiB', async () => {
            expect((await loadConfig({ STORE_MAX_MB: undefined })).STORE_MAX_MB).toBe(0);
            expect((await loadConfig({ STORE_MAX_MB: '512' })).STORE_MAX_MB).toBe(512);
        });

        it.each([
            [ 'STORE_EXPIRY_DAYS', '-1' ], [ 'STORE_EXPIRY_DAYS', '1.5' ], [ 'STORE_EXPIRY_DAYS', 'never' ],
            [ 'STORE_MAX_MB', '-1' ], [ 'STORE_MAX_MB', '1GB' ],
        ])('refuses to start with %s "%s"', async (name, raw) => {
            await expect(loadConfig({ [name]: raw })).rejects.toThrow(name);
        });
    });

    describe('TRUSTED_PROXIES', () => {
        it('trusts no proxy when unset or empty', async () => {
            expect((await loadConfig({ TRUSTED_PROXIES: undefined })).TRUSTED_PROXIES).toEqual([]);
            expect((await loadConfig({ TRUSTED_PROXIES: '' })).TRUSTED_PROXIES).toEqual([]);
        });

        it('takes addresses, CIDR ranges and named ranges', async () => {
            const config = await loadConfig({ TRUSTED_PROXIES: 'loopback, uniquelocal, 203.0.113.7, 2001:db8::/32' });

            expect(config.TRUSTED_PROXIES).toEqual(['loopback', 'uniquelocal', '203.0.113.7', '2001:db8::/32']);
        });

        it.each([
            ['loopback, proxy.example.org', '"proxy.example.org" is not an IP address'],
            ['172.20', '"172.20" is not an IP address'],
            ['10.0.0.0/33', '"10.0.0.0/33" has an invalid prefix length'],
        ])('refuses to start with "%s", naming the entry', async (raw, problem) => {
            await expect(loadConfig({ TRUSTED_PROXIES: raw })).rejects.toThrow(`Invalid TRUSTED_PROXIES: ${problem}`);
        });
    });

    describe('TCP_PROXY_PROTOCOL', () => {
        it('is off unless set to true', async () => {
            expect((await loadConfig({ TCP_PROXY_PROTOCOL: undefined })).TCP_PROXY_PROTOCOL).toBe(false);
            expect((await loadConfig({ TCP_PROXY_PROTOCOL: '' })).TCP_PROXY_PROTOCOL).toBe(false);
            expect((await loadConfig({ TCP_PROXY_PROTOCOL: 'false' })).TCP_PROXY_PROTOCOL).toBe(false);
            expect((await loadConfig({ TCP_PROXY_PROTOCOL: 'True', TRUSTED_PROXIES: 'loopback' })).TCP_PROXY_PROTOCOL).toBe(true);
        });

        it.each(['yes', '1', 'ture'])('refuses to start with "%s"', async (raw) => {
            await expect(loadConfig({ TCP_PROXY_PROTOCOL: raw, TRUSTED_PROXIES: 'loopback' }))
                .rejects.toThrow(`Invalid TCP_PROXY_PROTOCOL: "${raw}" is not true or false`);
        });

        // Every header would come from a peer that is not trusted, and be refused.
        it('refuses to start without TRUSTED_PROXIES', async () => {
            await expect(loadConfig({ TCP_PROXY_PROTOCOL: 'true', TRUSTED_PROXIES: '' }))
                .rejects.toThrow('TCP_PROXY_PROTOCOL is true, but TRUSTED_PROXIES is empty');
        });
    });

    describe('TCP_TLS_AT_PROXY', () => {
        const throughProxy = { TRUSTED_PROXIES: 'loopback', TCP_PROXY_PROTOCOL: 'true' };

        it('is off unless set to true', async () => {
            expect((await loadConfig({ TCP_TLS_AT_PROXY: undefined })).TCP_TLS_AT_PROXY).toBe(false);
            expect((await loadConfig({ TCP_TLS_AT_PROXY: '' })).TCP_TLS_AT_PROXY).toBe(false);
            expect((await loadConfig({ TCP_TLS_AT_PROXY: 'false', ...throughProxy })).TCP_TLS_AT_PROXY).toBe(false);
            expect((await loadConfig({ TCP_TLS_AT_PROXY: 'TRUE', ...throughProxy })).TCP_TLS_AT_PROXY).toBe(true);
        });

        it.each(['yes', '1', 'on'])('refuses to start with "%s"', async (raw) => {
            await expect(loadConfig({ TCP_TLS_AT_PROXY: raw, ...throughProxy }))
                .rejects.toThrow(`Invalid TCP_TLS_AT_PROXY: "${raw}" is not true or false`);
        });

        it('applies only with TCP_PROXY_PROTOCOL, and so TRUSTED_PROXIES', async () => {
            expect(await tcpTlsAtProxy({ TCP_TLS_AT_PROXY: 'true', ...throughProxy })).toBe(true);
            expect(await tcpTlsAtProxy({ TCP_TLS_AT_PROXY: 'false', ...throughProxy })).toBe(false);
            expect(await tcpTlsAtProxy({ TCP_TLS_AT_PROXY: undefined, ...throughProxy })).toBe(false);
            expect(await tcpTlsAtProxy({ TCP_TLS_AT_PROXY: 'true', TRUSTED_PROXIES: 'loopback', TCP_PROXY_PROTOCOL: 'false' })).toBe(false);
            expect(await tcpTlsAtProxy({ TCP_TLS_AT_PROXY: 'true', TRUSTED_PROXIES: '', TCP_PROXY_PROTOCOL: undefined })).toBe(false);
        });

        it('warns of nothing with TRUSTED_PROXIES and TCP_PROXY_PROTOCOL, or when off', async () => {
            expect(await startupWarnings({ TCP_TLS_AT_PROXY: 'true', ...throughProxy })).toEqual([]);
            expect(await startupWarnings({ TCP_TLS_AT_PROXY: 'false', TRUSTED_PROXIES: '', TCP_PROXY_PROTOCOL: 'false' })).toEqual([]);
            expect(await startupWarnings({ TCP_TLS_AT_PROXY: undefined, TRUSTED_PROXIES: 'loopback', TCP_PROXY_PROTOCOL: 'false' })).toEqual([]);
        });

        // It goes by the PROXY protocol header, which only a trusted proxy may send. The proxy's side
        // comes first: TCP_PROXY_PROTOCOL alone refuses every connection through a proxy without it.
        it('warns once that it has no effect without TCP_PROXY_PROTOCOL, naming what is missing on both sides', async () => {
            expect(await startupWarnings({ TCP_TLS_AT_PROXY: 'true', TRUSTED_PROXIES: 'loopback', TCP_PROXY_PROTOCOL: 'false' })).toEqual([
                'TCP_TLS_AT_PROXY is true, but TCP_PROXY_PROTOCOL is false, so the server cannot tell which Unity clients ' +
                    'come through the proxy, and it has no effect. Turn on the PROXY protocol in the proxy (nginx: ' +
                    'proxy_protocol on;) and set TCP_PROXY_PROTOCOL to true; or set TCP_TLS_AT_PROXY to false.',
            ]);
            expect(await startupWarnings({ TCP_TLS_AT_PROXY: 'true', TRUSTED_PROXIES: '', TCP_PROXY_PROTOCOL: undefined })).toEqual([
                'TCP_TLS_AT_PROXY is true, but TRUSTED_PROXIES is empty and TCP_PROXY_PROTOCOL is false, so the server cannot ' +
                    'tell which Unity clients come through the proxy, and it has no effect. Turn on the PROXY protocol in the ' +
                    'proxy (nginx: proxy_protocol on;), set TRUSTED_PROXIES to its address, e.g. loopback, and ' +
                    'TCP_PROXY_PROTOCOL to true; or set TCP_TLS_AT_PROXY to false.',
            ]);
        });
    });

    describe('TLS_CERT and TLS_KEY', () => {
        let dir: string;
        let server: TestCertificate;
        let other: TestCertificate;
        // server and other have EC keys.
        let rsa: TestCertificate;

        beforeAll(async () => {
            dir = await mkdtemp(path.join(tmpdir(), 'colibri-config-tls-'));
            server = createTestCertificate(dir, 'server');
            other = createTestCertificate(dir, 'other');
            rsa = createTestCertificate(dir, 'rsa', { keyType: 'rsa' });
        });

        afterAll(async () => {
            await rm(dir, { recursive: true, force: true });
        });

        it('leave TLS off when neither is set, or both are empty', async () => {
            const unset = await loadConfig({ TLS_CERT: undefined, TLS_KEY: undefined });
            expect(unset.TLS_CERT).toBeUndefined();
            expect(unset.TLS_KEY).toBeUndefined();

            const empty = await loadConfig({ TLS_CERT: '', TLS_KEY: '' });
            expect(empty.TLS_CERT).toBeUndefined();
            expect(empty.TLS_KEY).toBeUndefined();
        });

        it('take a certificate and its key', async () => {
            const config = await loadConfig({ TLS_CERT: server.certPath, TLS_KEY: server.keyPath });

            expect(config.TLS_CERT).toBe(server.certPath);
            expect(config.TLS_KEY).toBe(server.keyPath);
        });

        it('take an RSA certificate and its key', async () => {
            const config = await loadConfig({ TLS_CERT: rsa.certPath, TLS_KEY: rsa.keyPath });

            expect(config.TLS_CERT).toBe(rsa.certPath);
            expect(config.TLS_KEY).toBe(rsa.keyPath);
        });

        it('resolve relative paths like DATA_ROOT\'s', async () => {
            const config = await loadConfig({
                TLS_CERT: path.relative(CONFIG_DIR, server.certPath),
                TLS_KEY: path.relative(CONFIG_DIR, server.keyPath),
            });

            expect(config.TLS_CERT).toBe(server.certPath);
            expect(config.TLS_KEY).toBe(server.keyPath);
        });

        it.each([
            [ 'TLS_CERT', 'TLS_KEY' ],
            [ 'TLS_KEY', 'TLS_CERT' ],
        ])('refuse to start with only %s set, naming %s', async (set, missing) => {
            const env = { TLS_CERT: undefined as string | undefined, TLS_KEY: undefined as string | undefined };
            env[set as 'TLS_CERT' | 'TLS_KEY'] = set === 'TLS_CERT' ? server.certPath : server.keyPath;

            await expect(loadConfig(env)).rejects.toThrow(`${set} is set, but ${missing} is not`);
        });

        it('refuse to start with a file that does not exist, naming it', async () => {
            const missing = path.join(dir, 'missing.pem');

            await expect(loadConfig({ TLS_CERT: missing, TLS_KEY: server.keyPath }))
                .rejects.toThrow(`Cannot read TLS_CERT (${missing})`);
        });

        it('refuse to start with a directory instead of a file', async () => {
            await expect(loadConfig({ TLS_CERT: server.certPath, TLS_KEY: dir }))
                .rejects.toThrow('has to name the PEM file itself');
        });

        // root reads any file, so there is nothing to refuse when the tests run as root. Nor on
        // Windows, where chmod 0o000 only sets the read-only attribute and the file stays readable.
        it.skipIf(process.getuid?.() === 0 || process.platform === 'win32')('refuse to start with a key the server cannot read, naming its uid', async () => {
            const locked = path.join(dir, 'locked');
            await mkdir(locked, { recursive: true });
            const keyPath = path.join(locked, 'server.key');
            await writeFile(keyPath, server.key);
            await chmod(keyPath, 0o000);
            try {
                await expect(loadConfig({ TLS_CERT: server.certPath, TLS_KEY: keyPath }))
                    .rejects.toThrow(new RegExp(`Cannot read TLS_KEY \\(${keyPath}\\).*runs as uid ${process.getuid?.()}`));
            } finally {
                await chmod(keyPath, 0o600);
            }
        });

        it('refuse to start with a key where the certificate belongs', async () => {
            await expect(loadConfig({ TLS_CERT: server.keyPath, TLS_KEY: server.keyPath }))
                .rejects.toThrow(`TLS_CERT (${server.keyPath}) holds no certificate the server can use`);
        });

        it('refuse to start with a certificate where the key belongs', async () => {
            await expect(loadConfig({ TLS_CERT: server.certPath, TLS_KEY: server.certPath }))
                .rejects.toThrow(`TLS_KEY (${server.certPath}) holds no private key the server can use`);
        });

        it('refuse to start with the key of another certificate', async () => {
            await expect(loadConfig({ TLS_CERT: server.certPath, TLS_KEY: other.keyPath }))
                .rejects.toThrow(`TLS_KEY (${other.keyPath}) is not the private key of the certificate in TLS_CERT (${server.certPath})`);
        });

        // OpenSSL itself takes these without a word, and then fails every handshake.
        it.each([
            [ 'an RSA certificate and an EC key', 'rsa', 'server' ],
            [ 'an EC certificate and an RSA key', 'server', 'rsa' ],
        ] as const)('refuse to start with %s', async (_what, certOf, keyOf) => {
            const certificates = { server, rsa };
            const { certPath } = certificates[certOf];
            const { keyPath } = certificates[keyOf];

            await expect(loadConfig({ TLS_CERT: certPath, TLS_KEY: keyPath }))
                .rejects.toThrow(`TLS_KEY (${keyPath}) is not the private key of the certificate in TLS_CERT (${certPath})`);
        });

        // Node would otherwise either fail with an OpenSSL decoder error or, on a terminal, ask for it.
        it.each([ 'pkcs8', 'traditional' ] as const)('refuse to start with a key protected by a passphrase (%s), and say so', async (format) => {
            const keyPath = encryptTestKey(dir, server, format);

            await expect(loadConfig({ TLS_CERT: server.certPath, TLS_KEY: keyPath }))
                .rejects.toThrow(`TLS_KEY (${keyPath}) is protected by a passphrase`);
        });
    });

    it('loads .env without printing dotenv\'s banner and tip', async () => {
        // dotenv reads .env from the working directory.
        const cwd = await mkdtemp(path.join(tmpdir(), 'colibri-config-'));
        try {
            await writeFile(path.join(cwd, '.env'), 'VOICE_SAMPLING_RATE=44100\n', 'utf8');
            vi.spyOn(process, 'cwd').mockReturnValue(cwd);
            const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

            const config = await loadConfig({ DOTENV_CONFIG_QUIET: undefined, VOICE_SAMPLING_RATE: undefined });

            expect(config.VOICE_SAMPLING_RATE).toBe(44100);
            const printed = log.mock.calls.map(args => args.map(String).join(' '));
            expect(printed.filter(line => /dotenv|injected env|tip:/i.test(line))).toEqual([]);
        } finally {
            // dotenv wrote the value into process.env itself, outside of stubEnv
            delete process.env.VOICE_SAMPLING_RATE;
            await rm(cwd, { recursive: true, force: true });
        }
    });
});
