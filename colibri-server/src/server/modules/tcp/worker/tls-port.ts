import type * as net from 'net';
import * as tls from 'tls';
import { errorMessage } from '../../core/error-message.js';
import {
    FrameReader,
    FrameType,
    MAX_FRAME_LENGTH,
    TLS_HANDSHAKE_PREFIX_LENGTH,
    V1FramingError,
    looksLikeTlsHandshake,
} from '../../protocol/protocol.js';
import { toBuffer } from '../../protocol/to-buffer.js';
import type { TcpTlsCredentials } from '../worker-messages.js';
import { AddressThrottle } from './address-throttle.js';
import { endRefused } from './end-refused.js';
import { KEEPALIVE_INITIAL_DELAY_MILLIS } from './keepalive.js';
import { describeTlsFailure } from './socket-errors.js';

// How long a connection to the TLS port has to send its first bytes, and then, separately, to
// complete its TLS handshake. colibri-unity gives up on a connect after 5 s, handshake included.
export const TLS_HANDSHAKE_TIMEOUT_MILLIS = 10_000;

const secureContextOptions = function (credentials: TcpTlsCredentials): { cert: Buffer; key: Buffer } {
    return { cert: toBuffer(credentials.cert), key: toBuffer(credentials.key) };
};

// What TlsPort needs from the TCP worker that owns it.
interface TlsPortCallbacks {
    // The client's address; see TCPServerWorker.clientAddress.
    clientAddress(socket: net.Socket, unknown?: string): string;
    // A connection whose TLS handshake is done.
    handleConnection(socket: tls.TLSSocket): void;
    logDebug(msg: string): void;
    logInfo(msg: string): void;
    logWarning(msg: string): void;
    logError(msg: string, printStacktrace: boolean): void;
}

// The TCP port with TLS on: it refuses a connection that does not start a TLS handshake, and hands
// one that completes it on to the worker.
export class TlsPort {
    // With TLS on: never listens itself, but is handed each connection to the port that starts a TLS
    // handshake, and hands it on to handleConnection once the handshake is done.
    private tlsServer: tls.Server | undefined;
    private tlsCredentials: TcpTlsCredentials | undefined;
    private tlsHandshakeTimeoutMillis = TLS_HANDSHAKE_TIMEOUT_MILLIS;
    // The TCP sockets of every connection to the TLS port, from when it is accepted until it closes,
    // so that destroySockets() can end those still in their handshake too.
    private readonly tlsPortSockets = new Set<net.Socket>();

    // When a client without TLS at each remote address was last warned about, and a failed TLS
    // handshake with it last logged.
    private readonly withoutTlsWarnedAt = new AddressThrottle();
    private readonly tlsFailureLoggedAt = new AddressThrottle();

    public constructor(private readonly callbacks: TlsPortCallbacks) {}

    // With credentials, the next start() turns TLS on.
    public configure(credentials: TcpTlsCredentials | undefined): void {
        this.tlsCredentials = credentials;
    }

    // A renewed certificate, for every connection from now on. Open ones keep the one they started
    // with: TLS has no way to change it under them.
    public useTlsCredentials(credentials: TcpTlsCredentials): void {
        this.tlsCredentials = credentials;
        if (!this.tlsServer) return;

        try {
            this.tlsServer.setSecureContext(secureContextOptions(credentials));
        } catch (err) {
            this.callbacks.logError(
                `Could not switch the TCP server to the renewed TLS certificate: ${errorMessage(err)}`,
                false
            );
        }
    }

    // True if TLS is on: the port then accepts only TLS connections, through handleTlsPortConnection.
    public start(): boolean {
        const credentials = this.tlsCredentials;
        if (!credentials) return false;

        this.tlsServer = this.createTlsServer(credentials);
        return true;
    }

    // Drops the TLS server, which never listens, so there is nothing to close. start() makes a new
    // one; the connections are ended by destroySockets().
    public stop(): void {
        this.tlsServer = undefined;
    }

    // Ends every connection to the port, also those still in their TLS handshake or yet to start it.
    public destroySockets(): void {
        for (const socket of [...this.tlsPortSockets]) {
            socket.destroy();
        }
        this.tlsPortSockets.clear();
    }

    // TLS wraps the same frames, unchanged: past the handshake, a TLS client is handled exactly like
    // an unencrypted one.
    private createTlsServer(credentials: TcpTlsCredentials): tls.Server {
        const server = tls.createServer({
            ...secureContextOptions(credentials),
            handshakeTimeout: this.tlsHandshakeTimeoutMillis,
        });
        server.on('secureConnection', (socket: tls.TLSSocket) => this.callbacks.handleConnection(socket));
        server.on('tlsClientError', (error: Error, socket: tls.TLSSocket) => this.handleTlsClientError(error, socket));
        return server;
    }

    // A connection to the TLS port. Its first bytes say whether it starts a TLS handshake: if so, it
    // is handed to tlsServer; if not, it is refused, and the warning can name it and the fix. Handed
    // to tlsServer straight away, it would only fail its handshake with OpenSSL's "wrong version
    // number", which names neither.
    public handleTlsPortConnection(socket: net.Socket, alreadyRead: Buffer): void {
        // Read now, which caches it for clientAddress.
        const address = this.callbacks.clientAddress(socket);
        // Set on the TCP socket: the TLS socket on top of it does not pass either one down.
        socket.setNoDelay(true);
        socket.setKeepAlive(true, KEEPALIVE_INITIAL_DELAY_MILLIS);
        this.tlsPortSockets.add(socket);

        let firstBytes: Buffer = Buffer.alloc(0);
        const silence = setTimeout(() => {
            this.callbacks.logDebug(`Disconnecting ${address}: it sent nothing within ${this.tlsHandshakeTimeoutMillis / 1000} s of connecting`);
            socket.destroy();
        }, this.tlsHandshakeTimeoutMillis);
        silence.unref();

        const onError = (error: Error) => {
            this.callbacks.logDebug(`Lost the connection to ${address} before it started TLS: ${error.message}`);
        };
        const onData = (chunk: Buffer) => {
            firstBytes = firstBytes.length === 0 ? chunk : Buffer.concat([firstBytes, chunk]);
            if (firstBytes.length < TLS_HANDSHAKE_PREFIX_LENGTH) return;

            clearTimeout(silence);
            socket.off('data', onData);
            socket.pause();

            if (!looksLikeTlsHandshake(firstBytes)) {
                this.refuseClientWithoutTls(socket, address, firstBytes);
                return;
            }
            if (!this.tlsServer) {
                socket.destroy();
                return;
            }

            // The TLS socket reads what was read here from the TCP socket's buffer first, and reports
            // the TCP socket's errors from now on, as tlsClientError until the handshake is done.
            socket.unshift(firstBytes);
            socket.off('error', onError);
            this.tlsServer.emit('connection', socket);
        };

        socket.on('data', onData);
        socket.on('error', onError);
        socket.on('close', () => {
            clearTimeout(silence);
            this.tlsPortSockets.delete(socket);
        });
        if (alreadyRead.length > 0) onData(alreadyRead);
    }

    // Nothing is sent to such a client: it speaks neither TLS nor, necessarily, this protocol. A
    // Unity app sees the connection closed, and this warning is the diagnostic.
    private refuseClientWithoutTls(socket: net.Socket, address: string, firstBytes: Buffer): void {
        let v1 = false;
        let who = '';
        try {
            const handshake = new FrameReader(MAX_FRAME_LENGTH).append(firstBytes).find(frame => frame.type === FrameType.Handshake);
            if (handshake) who = ` (Unity client '${handshake.name}', app '${handshake.app}')`;
        } catch (err) {
            v1 = err instanceof V1FramingError;
        }

        if (!this.withoutTlsWarnedAt.shouldWarn(address, performance.now())) {
            this.callbacks.logDebug(`Refusing a connection without TLS from ${address}${who} (warned about this address already)`);
        } else if (v1) {
            this.callbacks.logWarning(
                `Refusing a connection from ${address}: it looks like a Colibri 1.x client, which cannot use TLS, and this ` +
                    'server\'s TCP port accepts only TLS connections (TLS_CERT and TLS_KEY are set). Upgrade the Colibri Unity ' +
                    'package (de.uni.kn.colibri) in that app to 2.x, and tick \'Server supports SSL/TLS?\' in its Colibri ' +
                    'configuration. This is logged at most once a minute per address.'
            );
        } else {
            this.callbacks.logWarning(
                `Refusing a connection from ${address}${who}: it does not use TLS, and this server's TCP port accepts only TLS ` +
                    'connections (TLS_CERT and TLS_KEY are set). Tick \'Server supports SSL/TLS?\' in that Unity app\'s Colibri ' +
                    'configuration. This is logged at most once a minute per address.'
            );
        }

        endRefused(socket);
    }

    // At info, not as an error: a client that does not accept the certificate, or gives up on a slow
    // network, is no fault of this server.
    private handleTlsClientError(error: Error, socket: tls.TLSSocket): void {
        // tls.Server leaves a socket whose handshake timed out open.
        socket.destroy();

        const address = this.callbacks.clientAddress(socket, 'an unknown address');
        const text = `TLS handshake with ${address} failed: ${describeTlsFailure(error, this.tlsHandshakeTimeoutMillis)}`;
        if (this.tlsFailureLoggedAt.shouldWarn(address, performance.now())) {
            this.callbacks.logInfo(`${text} This is logged at most once a minute per address.`);
        } else {
            this.callbacks.logDebug(text);
        }
    }
}
