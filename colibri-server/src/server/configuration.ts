import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { readTlsFiles } from './modules/core/tls-files.js';
import { parseTrustedProxies } from './modules/networking/trusted-proxies.js';

// automatically load .env file. Quietly: dotenv 17 otherwise prints an "injected env"
// line with a rotating advertising tip on every start, docker logs included.
dotenv.config({ quiet: true });

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// `Number(process.env.X)` silently yields NaN for anything malformed, which then
// propagates into `net.Server.listen`/`dgram.Socket.bind` and fails in confusing ways far
// from the actual misconfiguration. Fail fast at startup instead, with a message that
// names the offending variable.
const parsePort = function (name: string, raw: string | undefined, fallback: number): number {
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
        throw new Error(`Invalid ${name}: "${raw}" is not a valid port (expected an integer between 1 and 65535)`);
    }
    return value;
};

const parsePositiveInt = function (name: string, raw: string | undefined, fallback: number): number {
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`Invalid ${name}: "${raw}" is not a positive integer`);
    }
    return value;
};

// For the limits below, where 0 is meaningful: it switches the limit off.
const parseNonNegativeInt = function (name: string, raw: string | undefined, fallback: number): number {
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`Invalid ${name}: "${raw}" is not a non-negative integer (0 turns it off)`);
    }
    return value;
};

// TLS_CERT and TLS_KEY: both or neither. Read and checked here, so that a server that cannot serve
// TLS with them does not start at all, rather than start without TLS, or fail only once the first
// client connects. Resolved like DATA_ROOT below.
const parseTlsFiles = function (rawCert: string | undefined, rawKey: string | undefined): { cert: string; key: string } | undefined {
    const cert = rawCert?.trim() ?? '';
    const key = rawKey?.trim() ?? '';
    if (cert === '' && key === '') return undefined;
    if (cert === '' || key === '') {
        const [set, missing] = cert === '' ? ['TLS_KEY', 'TLS_CERT'] : ['TLS_CERT', 'TLS_KEY'];
        throw new Error(
            `${set} is set, but ${missing} is not. Set both, to the PEM files of the certificate and of its private key, ` +
                'to serve the TCP port and the web port over TLS only; or neither, to serve both unencrypted.'
        );
    }

    const files = { cert: path.resolve(__dirname, cert), key: path.resolve(__dirname, key) };
    // Throws, naming the variable, the file and the fix, if they cannot be used.
    readTlsFiles(files.cert, files.key);
    return files;
};

const tlsFiles = parseTlsFiles(process.env.TLS_CERT, process.env.TLS_KEY);

// Strictly true or false: TCP_PROXY_PROTOCOL mistyped and taken as false would leave every Unity
// connection through the proxy failing, with nothing at startup to say why.
const parseBoolean = function (name: string, raw: string | undefined, fallback: boolean): boolean {
    const value = raw?.trim().toLowerCase() ?? '';
    if (value === '') return fallback;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error(`Invalid ${name}: "${raw}" is not true or false`);
};

const trustedProxies = parseTrustedProxies(process.env.TRUSTED_PROXIES);
const tcpProxyProtocol = parseBoolean('TCP_PROXY_PROTOCOL', process.env.TCP_PROXY_PROTOCOL, false);
if (tcpProxyProtocol && trustedProxies.length === 0) {
    throw new Error(
        'TCP_PROXY_PROTOCOL is true, but TRUSTED_PROXIES is empty, so every PROXY protocol header would be refused. ' +
            'Set TRUSTED_PROXIES to the address of the proxy, e.g. loopback; or TCP_PROXY_PROTOCOL to false.'
    );
}
// Whether the proxy in front of the TCP port ends TLS. nginx's PROXY protocol header, version 1,
// does not say, so the operator does. Without TCP_PROXY_PROTOCOL it has no effect; see
// configurationWarnings.
const tcpTlsAtProxy = parseBoolean('TCP_TLS_AT_PROXY', process.env.TCP_TLS_AT_PROXY, false);

// The default ports are 9211, 9212 and 9213, not 1.x's 9011, 9012 and 9013: a 1.x and a 2.x
// server can then run side by side on one host, and a client of one version does not reach a
// server of the other by its defaults. A 1.x Unity client cannot even decode this server's
// refusal.
export const Config = {
    TCP_HOST: process.env.TCP_HOST || '0.0.0.0',
    TCP_PORT: parsePort('TCP_PORT', process.env.TCP_PORT, 9212),

    VOICE_HOST: process.env.VOICE_HOST || '0.0.0.0',
    VOICE_PORT: parsePort('VOICE_PORT', process.env.VOICE_PORT, 9213),
    VOICE_SAMPLING_RATE: parsePositiveInt('VOICE_SAMPLING_RATE', process.env.VOICE_SAMPLING_RATE, 48000),
    VOICE_RECORDING: process.env.VOICE_RECORDING?.toLowerCase() === 'true',

    WEBSERVER_HOST: process.env.WEBSERVER_HOST || '0.0.0.0',
    WEBSERVER_PORT: parsePort('WEBSERVER_PORT', process.env.WEBSERVER_PORT, 9211),
    // WEBSERVER_ROOT and DATA_ROOT use path.resolve, not path.join: join glued even an
    // absolute path onto __dirname, so DATA_ROOT=/var/lib/colibri ended up at
    // dist/server/var/lib/colibri. A relative path still resolves against __dirname
    // (dist/server) to the same place as before.
    WEBSERVER_ROOT: path.resolve(
        __dirname,
        process.env.WEBSERVER_ROOT || '../ui/'
    ),

    BASE_URL: process.env.BASE_URL || '',

    DATA_ROOT: path.resolve(
        __dirname,
        process.env.DATA_ROOT || '../../data/'
    ),

    // Default of 30 (was Error.stackTraceLimit = Infinity) caps the cost of every stack
    // capture - each logError call with printStacktrace on walks this many frames - while
    // still being enough to see past RxJS's internal call chain into application code.
    STACK_TRACE_LIMIT: parsePositiveInt('STACK_TRACE_LIMIT', process.env.STACK_TRACE_LIMIT, 30),

    // How many TCP messages may wait for the main thread before the TCP worker holds back incoming
    // model::update and drops broadcast::* messages (see DEFAULT_INBOUND_BACKLOG_LIMIT). 0: no limit.
    TCP_INBOUND_BACKLOG_LIMIT: parseNonNegativeInt('TCP_INBOUND_BACKLOG_LIMIT', process.env.TCP_INBOUND_BACKLOG_LIMIT, 2000),

    // Seconds a TCP client may send nothing at all before it is disconnected as gone (see
    // DEFAULT_IDLE_TIMEOUT_MILLIS); 0: never.
    TCP_IDLE_TIMEOUT_SECONDS: parseNonNegativeInt('TCP_IDLE_TIMEOUT_SECONDS', process.env.TCP_IDLE_TIMEOUT_SECONDS, 10),

    // How many model::update and broadcast::* messages a second one client may send, on either
    // transport, before the rest are held back or dropped (see DEFAULT_RATE_LIMIT); 0: no limit.
    // The burst is how many it may send at once after a quieter stretch.
    CLIENT_MESSAGE_RATE_LIMIT: parseNonNegativeInt('CLIENT_MESSAGE_RATE_LIMIT', process.env.CLIENT_MESSAGE_RATE_LIMIT, 1000),
    CLIENT_MESSAGE_RATE_BURST: parsePositiveInt('CLIENT_MESSAGE_RATE_BURST', process.env.CLIENT_MESSAGE_RATE_BURST || undefined, 2000),

    // Warn when one app has more clients than this, across both transports (see
    // DEFAULT_APP_CLIENT_WARNING_THRESHOLD); 0: never.
    APP_CLIENT_WARNING_THRESHOLD: parseNonNegativeInt('APP_CLIENT_WARNING_THRESHOLD', process.env.APP_CLIENT_WARNING_THRESHOLD, 8),

    // Seconds the server remembers that a synced model was deleted, refusing updates that would
    // create it again (see DataStore.removeModel); 0: not at all.
    MODEL_TOMBSTONE_SECONDS: parseNonNegativeInt('MODEL_TOMBSTONE_SECONDS', process.env.MODEL_TOMBSTONE_SECONDS, 600),

    // Absolute paths of the PEM certificate and private key, or both undefined. Set, the TCP port
    // accepts only TLS connections and the web port serves only HTTPS and WSS.
    TLS_CERT: tlsFiles?.cert,
    TLS_KEY: tlsFiles?.key,

    // The reverse proxies whose word on a client's address is taken (see trusted-proxies.ts);
    // empty: none, and every client is logged at the address it comes from.
    TRUSTED_PROXIES: trustedProxies,
    // Whether a connection to the TCP port from one of them has to start with a PROXY protocol
    // header, which names the Unity client (see TCPServerWorker.handleProxyProtocolConnection).
    TCP_PROXY_PROTOCOL: tcpProxyProtocol,
    // Whether a Unity client whose connection starts with such a header reached the proxy over TLS,
    // as the admin UI shows it. The header does not say.
    TCP_TLS_AT_PROXY: tcpTlsAtProxy,
};

type TcpTlsAtProxySettings = Pick<typeof Config, 'TRUSTED_PROXIES' | 'TCP_PROXY_PROTOCOL' | 'TCP_TLS_AT_PROXY'>;

// Whether TCP_TLS_AT_PROXY applies: only a connection that starts with a PROXY protocol header from
// a trusted proxy counts as TLS at the proxy, and only with TCP_PROXY_PROTOCOL is one read. The
// server topic's tlsAtProxy.tcp.
export const tcpTlsAtProxyInEffect = function (config: TcpTlsAtProxySettings): boolean {
    return config.TCP_TLS_AT_PROXY && config.TCP_PROXY_PROTOCOL && config.TRUSTED_PROXIES.length > 0;
};

// Settings that are valid but have no effect as set, as warnings. Not refused like the errors above:
// the server works the same without them. Returned rather than logged, since nothing listens to the
// log yet while this module loads; main.ts logs them at startup.
export const configurationWarnings = function (config: TcpTlsAtProxySettings): string[] {
    if (!config.TCP_TLS_AT_PROXY || tcpTlsAtProxyInEffect(config)) return [];

    // TCP_PROXY_PROTOCOL without TRUSTED_PROXIES has stopped the server already. The fix names the
    // proxy's side first: TCP_PROXY_PROTOCOL alone refuses every Unity connection through a proxy
    // that sends no header.
    const proxySide = 'Turn on the PROXY protocol in the proxy (nginx: proxy_protocol on;)';
    const [missing, fix] = config.TRUSTED_PROXIES.length === 0
        ? [
            'TRUSTED_PROXIES is empty and TCP_PROXY_PROTOCOL is false',
            `${proxySide}, set TRUSTED_PROXIES to its address, e.g. loopback, and TCP_PROXY_PROTOCOL to true`,
        ]
        : [ 'TCP_PROXY_PROTOCOL is false', `${proxySide} and set TCP_PROXY_PROTOCOL to true` ];
    return [
        `TCP_TLS_AT_PROXY is true, but ${missing}, so the server cannot tell which Unity clients come through the ` +
            `proxy, and it has no effect. ${fix}; or set TCP_TLS_AT_PROXY to false.`,
    ];
};
