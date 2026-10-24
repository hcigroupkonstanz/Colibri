import type * as net from 'net';
import { errorMessage } from '../../core/error-message.js';
import { normalizeAddress } from '../../net/addresses.js';
import type { TrustProxy } from '../../net/trusted-proxies.js';
import { compileTrustedProxies, trustNoProxy } from '../../net/trusted-proxies.js';
import type { TcpServerOptions } from '../worker-messages.js';
import { AddressThrottle } from './address-throttle.js';
import { endRefused } from './end-refused.js';
import { readProxyHeader } from './proxy-protocol.js';
import type { ProxyHeader } from './proxy-protocol.js';
import { tcpSocketOf } from './socket-errors.js';
import { TLS_HANDSHAKE_TIMEOUT_MILLIS } from './tls-port.js';

// With TCP_PROXY_PROTOCOL set: how long a connection has to send its PROXY protocol header, or, from
// a peer that is not a trusted proxy, enough of its first bytes to show that it sends none. The same
// as for a TLS handshake.
const PROXY_HEADER_TIMEOUT_MILLIS = TLS_HANDSHAKE_TIMEOUT_MILLIS;

export const NOTHING_READ = Buffer.alloc(0);

// `alreadyRead`: what the PROXY protocol check read past the header, or all it read if there was none.
export type ConnectionHandler = (socket: net.Socket, alreadyRead: Buffer) => void;

const NO_PROXY_HEADER_FIX =
    'Turn on the PROXY protocol for this port in the proxy (nginx: proxy_protocol on; in its stream server). A ' +
    'client that connects directly from an address in TRUSTED_PROXIES is refused like this too.';

// What a connection with TCP_PROXY_PROTOCOL set comes to after its latest bytes: it waits for more,
// is refused, or goes on to its ConnectionHandler with the header it starts with, if any.
type ProxyHeaderDecision =
    | { action: 'wait' }
    | { action: 'refuse'; reason: string; fix?: string }
    | { action: 'handle'; header: ProxyHeader | 'none' };

const UNTRUSTED_PROXY_HEADER: ProxyHeaderDecision = {
    action: 'refuse',
    reason: 'it starts with a PROXY protocol header, but its address is not in TRUSTED_PROXIES',
    fix: 'If it is the proxy in front of this server, add its address to TRUSTED_PROXIES.',
};

// A trusted proxy has to start with a valid header. Anyone else must not start with one, valid or
// not, since only a proxy sends one.
const decideOnProxyHeader = function (received: Buffer, trusted: boolean): ProxyHeaderDecision {
    let header: ReturnType<typeof readProxyHeader>;
    try {
        header = readProxyHeader(received);
    } catch (err) {
        if (!trusted) return UNTRUSTED_PROXY_HEADER;
        return { action: 'refuse', reason: `its PROXY protocol header is invalid: ${errorMessage(err)}` };
    }
    if (header === 'incomplete') return { action: 'wait' };
    if (header === 'none' && trusted) {
        return {
            action: 'refuse',
            reason: 'it is in TRUSTED_PROXIES and TCP_PROXY_PROTOCOL is true, but the connection does not start with a PROXY protocol header',
            fix: NO_PROXY_HEADER_FIX,
        };
    }
    if (header !== 'none' && !trusted) return UNTRUSTED_PROXY_HEADER;
    return { action: 'handle', header };
};

interface ProxyProtocolGateCallbacks {
    logDebug(msg: string): void;
    logWarning(msg: string): void;
}

// The PROXY protocol check in front of the TCP port (TCP_PROXY_PROTOCOL), and the client addresses
// the headers name.
export class ProxyProtocolGate {
    private proxyProtocol = false;
    private tlsAtProxy = false;
    private trustedProxies: string[] = [];
    private trustProxy: TrustProxy = trustNoProxy;
    private proxyHeaderTimeoutMillis = PROXY_HEADER_TIMEOUT_MILLIS;
    // The client addresses PROXY protocol headers named, by the TCP socket each came in on.
    private readonly proxiedAddresses = new WeakMap<net.Socket, string>();
    // The TCP sockets that started with a PROXY protocol header from a trusted proxy, whatever
    // address it named.
    private readonly throughProxy = new WeakSet<net.Socket>();
    // Connections yet to show whether they start with a PROXY protocol header, for destroySockets().
    private readonly proxyHeaderSockets = new Set<net.Socket>();
    // When a connection refused for its PROXY protocol header was last warned about, by the address
    // of the peer that sent it (or did not).
    private readonly proxyHeaderWarnedAt = new AddressThrottle();

    public constructor(private readonly callbacks: ProxyProtocolGateCallbacks) {}

    // Updates the settings only: the sockets already seen keep what their headers named.
    public configure(options: Pick<TcpServerOptions, 'proxyProtocol' | 'tlsAtProxy' | 'trustedProxies'>): void {
        this.proxyProtocol = options.proxyProtocol ?? false;
        this.tlsAtProxy = options.tlsAtProxy ?? false;
        this.trustedProxies = options.trustedProxies ?? [];
        this.trustProxy = compileTrustedProxies(this.trustedProxies);
    }

    // What the worker's start line says about the PROXY protocol: nothing without TCP_PROXY_PROTOCOL.
    public describeSetup(): string {
        return this.proxyProtocol
            ? `, PROXY protocol header required from TRUSTED_PROXIES (${this.trustedProxies.join(', ')})` +
                (this.tlsAtProxy ? ', TLS terminated by proxy (TCP_TLS_AT_PROXY)' : '')
            : '';
    }

    // Every connection to the TCP port: through the PROXY protocol check with TCP_PROXY_PROTOCOL set,
    // else straight on to `handle`.
    public accept(socket: net.Socket, handle: ConnectionHandler): void {
        if (this.proxyProtocol) this.handleProxyProtocolConnection(socket, handle);
        else handle(socket, NOTHING_READ);
    }

    // Ends every connection still to show whether it starts with a PROXY protocol header.
    public destroySockets(): void {
        for (const socket of [...this.proxyHeaderSockets]) {
            socket.destroy();
        }
        this.proxyHeaderSockets.clear();
    }

    // Whether the PROXY protocol header the TCP socket started with named a client address.
    public hasProxiedAddress(tcpSocket: net.Socket): boolean {
        return this.proxiedAddresses.has(tcpSocket);
    }

    // Whether the client reached the proxy over TLS: TCP_TLS_AT_PROXY is set and its connection came
    // through a trusted proxy.
    public tlsAtProxyFor(socket: net.Socket): boolean {
        return this.tlsAtProxy && this.throughProxy.has(tcpSocketOf(socket));
    }

    // The address the connection's PROXY protocol header named, else the one it comes from. The TLS
    // socket of a failed handshake is usually destroyed and no longer knows its peer, but the TCP
    // socket underneath still does: the address was read, and so cached, on accept. An IPv4 client is
    // named by its IPv4 address, also on a dual-stack TCP_HOST and from a PROXY v2 header.
    public clientAddress(socket: net.Socket, unknown = 'UNDEFINED'): string {
        const tcpSocket = tcpSocketOf(socket);
        return normalizeAddress(this.proxiedAddresses.get(tcpSocket) || socket.remoteAddress || tcpSocket.remoteAddress || unknown);
    }

    // A trusted proxy has to start with a PROXY protocol header, and the client it names is the
    // connection's client from then on, in the log and for every per-address limit. Anyone else is
    // refused if it starts with a header, and otherwise goes on as without TCP_PROXY_PROTOCOL.
    // Whatever follows the header goes on to `handle`, a TLS handshake included.
    private handleProxyProtocolConnection(socket: net.Socket, handle: ConnectionHandler): void {
        // Read now, which caches it for clientAddress.
        const peer = normalizeAddress(socket.remoteAddress || 'UNDEFINED');
        const trusted = this.trustProxy(peer, 0);
        const seconds = this.proxyHeaderTimeoutMillis / 1000;
        this.proxyHeaderSockets.add(socket);

        let received: Buffer = NOTHING_READ;
        const stopReading = () => {
            clearTimeout(timeout);
            socket.off('data', onData);
            socket.off('close', stopReading);
            this.proxyHeaderSockets.delete(socket);
        };
        const onError = (error: Error) => {
            this.callbacks.logDebug(`Lost the connection to ${peer} during the PROXY protocol check: ${error.message}`);
        };
        const onData = (chunk: Buffer) => {
            received = received.length === 0 ? chunk : Buffer.concat([received, chunk]);
            const decision = decideOnProxyHeader(received, trusted);
            if (decision.action === 'wait') return;

            stopReading();
            if (decision.action === 'refuse') {
                this.refuseProxyConnection(socket, peer, decision.reason, decision.fix);
                return;
            }
            // Removed in the same tick as `handle` adds its own listeners, so no error is missed.
            socket.off('error', onError);
            if (decision.header !== 'none') {
                this.throughProxy.add(socket);
                if (decision.header.sourceAddress) this.proxiedAddresses.set(socket, decision.header.sourceAddress);
            }
            handle(socket, decision.header === 'none' ? received : received.subarray(decision.header.length));
        };
        const timeout = setTimeout(() => {
            stopReading();
            this.endProxyHeaderWait(socket, peer, trusted, seconds, received);
        }, this.proxyHeaderTimeoutMillis);
        timeout.unref();

        socket.on('data', onData);
        socket.on('error', onError);
        socket.on('close', stopReading);
    }

    // A connection that sent no complete PROXY protocol header in time, or, from a peer that is not a
    // trusted proxy, too few of its first bytes to show that it sends none.
    private endProxyHeaderWait(socket: net.Socket, peer: string, trusted: boolean, seconds: number, received: Buffer): void {
        if (trusted) {
            this.refuseProxyConnection(
                socket,
                peer,
                `it is in TRUSTED_PROXIES and TCP_PROXY_PROTOCOL is true, but it sent no complete PROXY protocol header within ${seconds} s`,
                NO_PROXY_HEADER_FIX
            );
        } else {
            const sent = received.length === 0 ? 'nothing' : `only ${received.length} byte(s)`;
            this.callbacks.logDebug(`Disconnecting ${peer}: it sent ${sent} within ${seconds} s of connecting`);
            socket.destroy();
        }
    }

    // Logged like the other refusals: a warning at most once a minute per address, the rest at debug
    // level. Nothing is sent to the peer.
    private refuseProxyConnection(socket: net.Socket, peer: string, reason: string, fix?: string): void {
        if (!this.proxyHeaderWarnedAt.shouldWarn(peer, performance.now())) {
            this.callbacks.logDebug(`Refusing a connection from ${peer}: ${reason} (warned about this address already)`);
        } else {
            this.callbacks.logWarning(
                `Refusing a connection from ${peer}: ${reason}. ${fix ? `${fix} ` : ''}This is logged at most once a minute per address.`
            );
        }
        endRefused(socket);
    }
}
