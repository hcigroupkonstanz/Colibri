import type { ClientActivity } from '../limits/client-activity.js';
import type { RateLimit } from '../limits/inbound-limits.js';

// Passed as workerData by TCPServerProxy; the bootstrap at the bottom of worker/tcp-server-worker.ts
// starts the worker only with it. A test runner that runs suites in worker threads (vitest's threads
// pool) would otherwise start a second worker on import, listening on the runner's own message channel.
export const TCP_SERVER_WORKER_ROLE = 'colibri-tcp-server';

// What the worker posts as 'clientConnected$' once a client's handshake is accepted.
export interface TcpClientConnected {
    id: string;
    app: string;
    name: string;
    version: string;
    // The address its PROXY protocol header named, else the one it connected from; see
    // ProxyProtocolGate.clientAddress.
    address: string;
    // Whether its connection to this server is encrypted.
    tls: boolean;
    // Whether it reached the proxy over TLS: it came through a trusted proxy, and TCP_TLS_AT_PROXY
    // says that proxy ends TLS. See TcpServerOptions.tlsAtProxy.
    tlsAtProxy: boolean;
    // Date.now() of the connection, before its handshake.
    connectedAt: number;
}

// What the worker posts as 'clientActivity$' in answer to an 'm:clientActivity': the activity of every
// handshaked client, with its rate history if requested. Posted only on request, which the admin UI
// makes for its clients page, asking for the history with a page's first snapshot.
export interface TcpClientActivityReport {
    request: number;
    clients: (ClientActivity & { id: string })[];
}

// The certificate (with its chain) and private key the TCP port serves TLS with, both PEM. Buffers
// on the main thread, plain Uint8Arrays once they have been cloned into the worker thread.
export interface TcpTlsCredentials {
    cert: Uint8Array;
    key: Uint8Array;
}

// Settings the proxy sends along with 'm:start'; anything left out keeps its default.
export interface TcpServerOptions {
    // TCPServerProxy's backlog counter. Without it the backlog is neither counted nor limited.
    inboundBacklog?: Int32Array;
    // 0 turns the limit off.
    inboundBacklogLimit?: number;
    // Per client; see InboundRateLimiter.
    rateLimit?: RateLimit;
    // See IdleWatch. 0 never times a client out.
    idleTimeoutMillis?: number;
    // Set, the port accepts only TLS connections, served with this certificate; see
    // TlsPort.handleTlsPortConnection. 'm:tlsCredentials' replaces it.
    tls?: TcpTlsCredentials;
    // The proxies whose PROXY protocol headers name the client, as TRUSTED_PROXIES lists them. The
    // list, not a TrustProxy, which cannot be posted to the worker: the worker compiles its own.
    trustedProxies?: string[];
    // TCP_PROXY_PROTOCOL; see ProxyProtocolGate.
    proxyProtocol?: boolean;
    // TCP_TLS_AT_PROXY: a client whose connection started with a PROXY protocol header from a trusted
    // proxy reached that proxy over TLS. The header does not say so itself. Only with proxyProtocol,
    // so a connection that does not come through the proxy never counts.
    tlsAtProxy?: boolean;
}

// The worker only handles raw payload bytes. Payload, which caches the decoded forms, lives on the
// main thread across the postMessage boundary, so a TCP to TCP relay never transcodes utf8 and only
// a hook that inspects the payload pays for decoding it.
export interface WireNetworkMessage {
    origin?: {
        id: string;
        app: string;
        name: string;
        version: string;
        metadata: Record<string, unknown>;
    };
    channel: string;
    command: string;
    payload: Buffer;
}
