import type * as net from 'net';

// What the log suggests when a client may not have accepted the certificate. The two settings are
// colibri-unity's, in its Colibri configuration.
const CERTIFICATE_HINT =
    'If it is a Unity app and the certificate is self-signed, tick \'Allow self-signed certificate\' in its Colibri ' +
    'configuration, or enter the certificate\'s SHA-256 fingerprint (logged at startup) as its \'Server certificate SHA-256\'. ' +
    'Otherwise check that the certificate has not expired and names the address the client connects to.';

// OpenSSL's alerts for a certificate the peer did not accept.
const CERTIFICATE_REFUSED_ALERT = /alert (bad certificate|unknown ca|certificate unknown|certificate expired|certificate revoked|unsupported certificate|access denied)/i;

// Socket error codes that say only that the peer is gone: it reset the connection (an app that
// was killed or crashed, a headset put to sleep), a write found it closed, or the network lost it
// (keepalive gave up, no route to it any more). On Wi-Fi these are part of normal operation, and
// the disconnect itself is logged anyway, so they are not errors of this server.
export const PEER_GONE_ERRORS: ReadonlySet<string> = new Set([
    'ECONNRESET',
    'EPIPE',
    'ETIMEDOUT',
    'ECONNABORTED',
    'EHOSTUNREACH',
    'ENETUNREACH',
]);

// What a write still queued for a socket fails with once the socket is destroyed - one callback
// per queued write, and a client whose connection stalled can have thousands queued.
export const WRITE_CANCELLED_ERRORS: ReadonlySet<string> = new Set(['ECANCELED', 'ERR_STREAM_DESTROYED']);

export const errorCode = function (error: Error): string | undefined {
    const code = (error as NodeJS.ErrnoException).code;
    return typeof code === 'string' ? code : undefined;
};

// Why a TLS handshake failed, as a sentence for the log.
export const describeTlsFailure = function (error: Error, timeoutMillis: number): string {
    const code = errorCode(error);
    if (code === 'ERR_TLS_HANDSHAKE_TIMEOUT') {
        return `it did not complete within ${timeoutMillis / 1000} s.`;
    }
    // A Node.js or .NET client that refuses the certificate closes the connection without a word.
    if (code === 'ECONNRESET' || code === 'EPIPE') {
        return `the client closed the connection during the handshake (${error.message}), as a client that does not ` +
            `accept this server's certificate does. ${CERTIFICATE_HINT}`;
    }
    if (CERTIFICATE_REFUSED_ALERT.test(error.message)) {
        return `the client refused this server's certificate (${error.message}). ${CERTIFICATE_HINT}`;
    }
    return `${error.message}.`;
};

// The TCP socket a connection came in on: for a TLS socket, the one underneath it, which Node.js
// keeps as TLSSocket._parent.
export const tcpSocketOf = function (socket: net.Socket): net.Socket {
    return (socket as net.Socket & { _parent?: net.Socket | null })._parent ?? socket;
};
