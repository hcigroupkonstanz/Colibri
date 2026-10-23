import { fileURLToPath } from 'url';
import { BroadcastLogger } from './modules/command-hooks/broadcast-logger.js';
import { Broadcaster } from './modules/command-hooks/broadcaster.js';
import { ClientBroadcast } from './modules/command-hooks/client-broadcast.js';
import { ClientLogger } from './modules/command-hooks/client-logger.js';
import { ConnectionPool } from './modules/command-hooks/connection-pool.js';
import { DataStore } from './modules/command-hooks/data-store.js';
import { MeasureLatency } from './modules/command-hooks/measure-latency.js';
import { ModelSynchronization } from './modules/command-hooks/model-sync.js';
import { readBuildInfo } from './modules/core/build-info.js';
import { ConsoleLog } from './modules/core/console-log.js';
import { DataRootCheck } from './modules/core/data-root-check.js';
import { ProxyCertificateCheck, formatProxyTlsAddress } from './modules/core/proxy-certificate.js';
import { ServerProcess } from './modules/core/server-process.js';
import { readServerVersion } from './modules/core/server-version.js';
import { Service } from './modules/core/service.js';
import { TlsCertificate } from './modules/core/tls-certificate.js';
import { SocketIOServer } from './modules/networking/socket-io-server.js';
import { TCPServerProxy } from './modules/networking/tcp-server-proxy.js';
import { compileTrustedProxies } from './modules/networking/trusted-proxies.js';
import { AdminData } from './modules/web/admin-data.js';
import { RestAPI } from './modules/web/rest-api.js';
import { VoiceServer } from './modules/web/voice-server.js';
import { WebLog } from './modules/web/web-log.js';
import { WebServer } from './modules/web/web-server.js';
import { Config, configurationWarnings, tcpTlsAtProxyInEffect } from './configuration.js';

/**
 * Debugging
 */

// See Config.STACK_TRACE_LIMIT for why this isn't Infinity.
Error.stackTraceLimit = Config.STACK_TRACE_LIMIT;

// Attached before any service exists, so nothing logged during construction or init() is missed
// - the admin UI's WebLog only starts listening once its own init() has run. The options are
// read here rather than when modules/ is imported, which happens before Config loads .env.
new ConsoleLog(ConsoleLog.optionsFromEnv(process.env)).attach(Service.output$);

// The release, and the commit it was built from: dist/server/build-info.json, next to this file.
const version = readServerVersion(fileURLToPath(new URL('../../package.json', import.meta.url)));
const build = readBuildInfo(fileURLToPath(new URL('./build-info.json', import.meta.url)));

const dataStore = new DataStore();
dataStore.tombstoneMillis = Config.MODEL_TOMBSTONE_SECONDS * 1000;

/**
 *    Servers
 */

// With TLS_CERT and TLS_KEY set, the TCP port and the web port serve TLS with the same certificate,
// and take up a renewed one together. Config has checked both files already.
const tlsCertificate = Config.TLS_CERT && Config.TLS_KEY
    ? new TlsCertificate(Config.TLS_CERT, Config.TLS_KEY)
    : undefined;

// The certificates the proxy in front of the server presents to clients, which the server cannot
// see otherwise, for the monitoring page.
const proxyCertificates = Config.PROXY_TLS_ADDRESSES.length > 0
    ? new ProxyCertificateCheck(Config.PROXY_TLS_ADDRESSES)
    : undefined;

// Behind these proxies, a web client's address is taken from X-Forwarded-For. The TCP worker
// compiles its own from the same list, for the PROXY protocol.
const trustProxy = compileTrustedProxies(Config.TRUSTED_PROXIES);

const webServer = new WebServer(
    Config.WEBSERVER_HOST,
    Config.WEBSERVER_PORT,
    Config.WEBSERVER_ROOT,
    Config.BASE_URL,
    tlsCertificate,
    trustProxy
);

const tcpServer = new TCPServerProxy();
// Relays voice only from the address of a Unity client of the packet's app, or unchecked from a
// trusted proxy.
const voiceServer = new VoiceServer(Config.VOICE_SAMPLING_RATE, Config.DATA_ROOT, Config.VOICE_RECORDING, tcpServer, trustProxy);
const socketioServer = new SocketIOServer();
const connectionPool = new ConnectionPool(tcpServer, socketioServer);
connectionPool.appClientWarningThreshold = Config.APP_CLIENT_WARNING_THRESHOLD;

/**
 *    APIs
 */
const restApi = new RestAPI(Config.DATA_ROOT, webServer, {
    expiryDays: Config.STORE_EXPIRY_DAYS,
    maxBytes: Config.STORE_MAX_MB * 1024 * 1024,
});
const dataRootCheck = new DataRootCheck(Config.DATA_ROOT);

/**
 *    Plumbing
 *
 *    Constructed for their side effects only (each subscribes to the connection pool /
 *    registers itself as a Service in its constructor) - never referenced again, so none
 *    of these are assigned to a variable.
 */
new ClientLogger(connectionPool);
new WebLog(socketioServer);
new ModelSynchronization(connectionPool, dataStore);
new Broadcaster(connectionPool);
new BroadcastLogger(connectionPool);
new ClientBroadcast(connectionPool);
new MeasureLatency(connectionPool, socketioServer);

// Read-only data for the admin UI's pages. The settings by the names of the variables that set
// them; TLS_CERT and TLS_KEY only as the certificate's description, never their paths or contents.
const adminData = new AdminData({
    store: dataStore,
    socketio: socketioServer,
    tcp: tcpServer,
    version,
    build,
    startedAt: Date.now(),
    settings: {
        WEBSERVER_HOST: Config.WEBSERVER_HOST,
        WEBSERVER_PORT: Config.WEBSERVER_PORT,
        BASE_URL: Config.BASE_URL,
        TCP_HOST: Config.TCP_HOST,
        TCP_PORT: Config.TCP_PORT,
        VOICE_HOST: Config.VOICE_HOST,
        VOICE_PORT: Config.VOICE_PORT,
        VOICE_SAMPLING_RATE: Config.VOICE_SAMPLING_RATE,
        VOICE_RECORDING: Config.VOICE_RECORDING,
        TCP_IDLE_TIMEOUT_SECONDS: Config.TCP_IDLE_TIMEOUT_SECONDS,
        TCP_INBOUND_BACKLOG_LIMIT: Config.TCP_INBOUND_BACKLOG_LIMIT,
        CLIENT_MESSAGE_RATE_LIMIT: Config.CLIENT_MESSAGE_RATE_LIMIT,
        CLIENT_MESSAGE_RATE_BURST: Config.CLIENT_MESSAGE_RATE_BURST,
        APP_CLIENT_WARNING_THRESHOLD: Config.APP_CLIENT_WARNING_THRESHOLD,
        MODEL_TOMBSTONE_SECONDS: Config.MODEL_TOMBSTONE_SECONDS,
        STORE_EXPIRY_DAYS: Config.STORE_EXPIRY_DAYS,
        STORE_MAX_MB: Config.STORE_MAX_MB,
        TRUSTED_PROXIES: Config.TRUSTED_PROXIES,
        TCP_PROXY_PROTOCOL: Config.TCP_PROXY_PROTOCOL,
        TCP_TLS_AT_PROXY: Config.TCP_TLS_AT_PROXY,
        PROXY_TLS_ADDRESSES: Config.PROXY_TLS_ADDRESSES.map(formatProxyTlsAddress),
    },
    tls: tlsCertificate,
    proxyTls: proxyCertificates,
    tcpTlsAtProxy: tcpTlsAtProxyInEffect(Config),
    voice: voiceServer,
    restStore: restApi,
});

// Logs what happens to the process itself, and shuts it down, in this order. restApi.close()
// checkpoints the data store's write-ahead log into store.db. The voice server goes last: it
// saves the voice recordings still in progress, which can take a while for long ones, and must
// not leave the data store's close to the watchdog.
const SHUTDOWN_TIMEOUT_MILLIS = 5000;
const serverProcess = new ServerProcess([
    { name: 'AdminData', stop: () => adminData.stop() },
    { name: 'WebServer', stop: () => webServer.stop() },
    { name: 'SocketIOServer', stop: () => socketioServer.stop() },
    { name: 'TCPServer', stop: () => tcpServer.stop() },
    { name: 'RestAPI', stop: () => restApi.close() },
    { name: 'VoiceServer', stop: () => voiceServer.stop() },
], SHUTDOWN_TIMEOUT_MILLIS);

/**
 *    Startup
 */

const startup = async () => {
    for (const service of Service.Current) {
        await service.init();
    }

    // After every init(), so the admin UI's WebLog is listening for these too. First, which
    // server this is.
    serverProcess.reportStart(version, build);
    // Settings that have no effect as set.
    for (const warning of configurationWarnings(Config)) serverProcess.reportWarning(warning);
    // Not fatal: the server is still useful without persistence, it just has to say so.
    await dataRootCheck.check();
    // Likewise: logs the certificate's fingerprint.
    tlsCertificate?.start();

    const rateLimit = { messagesPerSecond: Config.CLIENT_MESSAGE_RATE_LIMIT, burst: Config.CLIENT_MESSAGE_RATE_BURST };
    const httpServer = webServer.start();
    socketioServer.start(httpServer, { rateLimit, trustProxy });
    tcpServer.start(Config.TCP_PORT, Config.TCP_HOST, {
        inboundBacklogLimit: Config.TCP_INBOUND_BACKLOG_LIMIT,
        rateLimit,
        idleTimeoutMillis: Config.TCP_IDLE_TIMEOUT_SECONDS * 1000,
        trustedProxies: Config.TRUSTED_PROXIES,
        proxyProtocol: Config.TCP_PROXY_PROTOCOL,
        tlsAtProxy: Config.TCP_TLS_AT_PROXY,
    }, tlsCertificate);
    voiceServer.start(Config.VOICE_PORT, Config.VOICE_HOST);
    // Last: a proxy that forwards to this server can then pass a check through to it.
    proxyCertificates?.start();
};

startup().catch((err) => {
    serverProcess.reportError('Startup failed', err);
    process.exit(1);
});

/**
 *    Shutdown
 */

// `docker stop` sends SIGTERM (then SIGKILL after a grace period) with no handler
// installed for either, so the TCP worker thread was never terminated and the data store
// was never closed.
process.on('SIGTERM', (signal) => void serverProcess.shutdown(`Received ${signal}`, 0));
process.on('SIGINT', (signal) => void serverProcess.shutdown(`Received ${signal}`, 0));

// Both of these used to process.exit(1) directly, skipping the orderly shutdown above, in
// exactly the situation where it matters most.
process.on('unhandledRejection', (reason) => {
    serverProcess.reportError('Unhandled rejection', reason);
    void serverProcess.shutdown('Unhandled rejection', 1);
});

process.on('uncaughtException', (err) => {
    serverProcess.reportError('Uncaught exception', err);
    void serverProcess.shutdown('Uncaught exception', 1);
});
