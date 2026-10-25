import { fileURLToPath } from 'url';
import { BroadcastLogger } from './modules/hooks/broadcast-logger.js';
import { Broadcaster } from './modules/hooks/broadcaster.js';
import { ClientBroadcast } from './modules/hooks/client-broadcast.js';
import { ClientLogger } from './modules/hooks/client-logger.js';
import { ConnectionPool } from './modules/hooks/connection-pool.js';
import { DataStore } from './modules/models/data-store.js';
import { MeasureLatency } from './modules/hooks/measure-latency.js';
import { ModelSynchronization } from './modules/models/model-sync.js';
import { readBuildInfo } from './modules/core/build-info.js';
import { ConsoleLog } from './modules/core/console-log.js';
import { DataRootCheck } from './modules/core/data-root-check.js';
import { ProxyCertificateCheck, formatProxyTlsAddress } from './modules/tls/proxy-certificate.js';
import { ServerProcess } from './modules/core/server-process.js';
import { readServerVersion } from './modules/core/server-version.js';
import { Service } from './modules/core/service.js';
import { TlsCertificate } from './modules/tls/tls-certificate.js';
import { SocketIOServer } from './modules/socket-io/socket-io-server.js';
import { TCPServerProxy } from './modules/tcp/tcp-server-proxy.js';
import { compileTrustedProxies } from './modules/net/trusted-proxies.js';
import { AdminData } from './modules/admin/admin-data.js';
import { RestAPI } from './modules/store/rest-api.js';
import { VoiceServer } from './modules/voice/voice-server.js';
import { WebLog } from './modules/admin/web-log.js';
import { WebServer } from './modules/http/web-server.js';
import { Config, configurationWarnings, tcpTlsAtProxyInEffect } from './configuration.js';

/**
 * Debugging
 */

Error.stackTraceLimit = Config.STACK_TRACE_LIMIT;

// Attached before any service exists, so nothing logged during construction or init() is missed
// (the admin UI's WebLog only listens once its own init() has run). The options are read here, not
// when modules/ is imported, which happens before Config loads .env.
new ConsoleLog(ConsoleLog.optionsFromEnv(process.env)).attach(Service.output$);

const version = readServerVersion(fileURLToPath(new URL('../../package.json', import.meta.url)));
const build = readBuildInfo(fileURLToPath(new URL('./build-info.json', import.meta.url)));

const dataStore = new DataStore();
dataStore.tombstoneMillis = Config.MODEL_TOMBSTONE_SECONDS * 1000;

/**
 *    Servers
 */

// The TCP port and the web port share one certificate, so both switch to a renewed one together.
// Config has checked the files already.
const tlsCertificate = Config.TLS_CERT && Config.TLS_KEY
    ? new TlsCertificate(Config.TLS_CERT, Config.TLS_KEY)
    : undefined;

// The certificates the proxy in front of the server presents to clients, for the monitoring page.
const proxyCertificates = Config.PROXY_TLS_ADDRESSES.length > 0
    ? new ProxyCertificateCheck(Config.PROXY_TLS_ADDRESSES)
    : undefined;

// A web client's address is taken from X-Forwarded-For when the peer is one of these proxies. The TCP
// worker compiles its own from the same list, for the PROXY protocol.
const trustProxy = compileTrustedProxies(Config.TRUSTED_PROXIES);

const webServer = new WebServer({
    hostname: Config.WEBSERVER_HOST,
    webPort: Config.WEBSERVER_PORT,
    webRoot: Config.WEBSERVER_ROOT,
    baseUrl: Config.BASE_URL,
    tls: tlsCertificate,
    trustProxy
});

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
 *    Constructed for their side effects only: each is a Service and hooks itself up in its constructor.
 */
new ClientLogger(connectionPool);
new WebLog(socketioServer);
new ModelSynchronization(connectionPool, dataStore);
new Broadcaster(connectionPool);
new BroadcastLogger(connectionPool);
new ClientBroadcast(connectionPool);
new MeasureLatency(connectionPool, socketioServer);

// Read-only data for the admin UI. Settings go by the names of their variables; TLS_CERT and TLS_KEY
// only as the certificate's description (tls), never their paths or contents.
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

// The steps run in this order. restApi.close() checkpoints the data store's write-ahead log into
// store.db. The voice server goes last: saving the recordings in progress can take long, and must not
// leave the data store's close to the watchdog.
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

    // After every init(), so the admin UI's WebLog is listening for these too.
    serverProcess.reportStart(version, build);
    for (const warning of configurationWarnings(Config)) serverProcess.reportWarning(warning);
    // Not fatal: the server still works without persistence.
    await dataRootCheck.check();
    // Logs the certificate's fingerprint.
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

// `docker stop` sends SIGTERM, then SIGKILL after a grace period.
process.on('SIGTERM', (signal) => void serverProcess.shutdown(`Received ${signal}`, 0));
process.on('SIGINT', (signal) => void serverProcess.shutdown(`Received ${signal}`, 0));

process.on('unhandledRejection', (reason) => {
    serverProcess.reportError('Unhandled rejection', reason);
    void serverProcess.shutdown('Unhandled rejection', 1);
});

process.on('uncaughtException', (err) => {
    serverProcess.reportError('Uncaught exception', err);
    void serverProcess.shutdown('Uncaught exception', 1);
});
