import type { ClientActivity } from '../limits/client-activity.js';
import type { RateLimit } from '../limits/inbound-limits.js';

// Passed as workerData by TCPServerProxy and checked by the bootstrap at the bottom of
// tcp-server-worker.ts. `!threads.isMainThread` alone was not enough of a guard: any test runner that
// executes its suites inside worker threads (vitest's default pool does) would construct a
// second TCPServerWorker on import and have it subscribe to *that* thread's message
// channel, which is the runner's own RPC.
export const TCP_SERVER_WORKER_ROLE = 'colibri-tcp-server';

// What the worker posts as 'clientConnected$' once a client's handshake is accepted.
export interface TcpClientConnected {
    id: string;
    app: string;
    name: string;
    version: string;
    // Its address: the one its PROXY protocol header named, if it had one; see clientAddress.
    address: string;
    // Whether its connection to this server is encrypted.
    tls: boolean;
    // Whether it reached the proxy over TLS: it came through a trusted proxy, and TCP_TLS_AT_PROXY
    // says that proxy ends TLS. See TcpServerOptions.tlsAtProxy.
    tlsAtProxy: boolean;
    // Date.now() of the connection, before its handshake.
    connectedAt: number;
}

// What the worker posts as 'clientActivity$', answering an 'm:clientActivity' from TCPServerProxy:
// the activity of every client whose handshake was accepted, with each one's rate history if the
// request asks for it. Only ever posted when asked, which the proxy does only while an admin UI page
// shows it, and asks for the history only for a page's first snapshot.
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
    // See DEFAULT_IDLE_TIMEOUT_MILLIS. 0 never times a client out.
    idleTimeoutMillis?: number;
    // Set, the port accepts only TLS connections, served with this certificate; see
    // TlsPort.handleTlsPortConnection. 'm:tlsCredentials' replaces it.
    tls?: TcpTlsCredentials;
    // The proxies whose PROXY protocol headers name the client, as TRUSTED_PROXIES lists them. The
    // list rather than the main thread's TrustProxy, which cannot be posted to the worker thread:
    // compiled in the worker from the same list, it trusts the same peers.
    trustedProxies?: string[];
    // TCP_PROXY_PROTOCOL; see handleProxyProtocolConnection.
    proxyProtocol?: boolean;
    // TCP_TLS_AT_PROXY: a client whose connection started with a PROXY protocol header from a trusted
    // proxy reached that proxy over TLS. The header does not say so itself. Only with proxyProtocol,
    // so a connection that does not come through the proxy never counts.
    tlsAtProxy?: boolean;
}

// The worker thread only ever deals in raw payload bytes (straight off the wire, or
// destined for it) - the Payload memoization abstraction lives at the ConnectionPool
// layer on the main thread, on the other side of the postMessage boundary. Keeping the
// payload as a Buffer here means a byte-verbatim TCP->TCP relay never pays a utf8
// transcode; only a hook that actually inspects the payload (on the main thread) pays
// for decoding it.
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
