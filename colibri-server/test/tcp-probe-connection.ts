// The connection of the scripts under test/ that talk to a server over raw TCP, the way a Unity
// client does, and the command line options they share:
//
//   --tls          connect with TLS, as a Unity app with 'Server supports SSL/TLS?' ticked
//   --insecure     with --tls: accept a certificate that is not trusted here (self-signed, for
//                  another name, expired). The connection is still encrypted.
//   --host <name>  the server's address (default 127.0.0.1), and with --tls the name its
//                  certificate has to be for
//
// The port is TCP_PORT, from the environment or a .env, as the server reads it.
import * as net from 'net';
import * as tls from 'tls';

export interface ProbeOptions {
    host: string;
    tls: boolean;
    insecure: boolean;
    // Everything else on the command line, in order.
    args: string[];
}

// defaultHost is --host's value when it is not on the command line.
export const parseProbeArgs = function (argv: readonly string[], defaultHost = '127.0.0.1'): ProbeOptions {
    const options: ProbeOptions = { host: defaultHost, tls: false, insecure: false, args: [] };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg === '--tls') {
            options.tls = true;
        } else if (arg === '--insecure') {
            options.insecure = true;
        } else if (arg === '--host') {
            const host = argv[++i];
            if (!host) throw new Error('--host needs the server\'s address');
            options.host = host;
        } else {
            options.args.push(arg);
        }
    }
    if (options.insecure && !options.tls) throw new Error('--insecure only applies with --tls');
    return options;
};

// Connects, and calls onReady once frames can be sent: at once without TLS, after the handshake with
// it. With TLS it first prints the certificate the server sent, and whether it is trusted here.
export const connectProbe = function (options: ProbeOptions, port: number, onReady: () => void): net.Socket {
    if (!options.tls) {
        return net.connect(port, options.host, () => {
            console.log(`Connected to ${options.host}:${port}`);
            onReady();
        });
    }

    const socket = tls.connect({
        host: options.host,
        port,
        // SNI takes a name, never an address.
        servername: net.isIP(options.host) ? undefined : options.host,
        rejectUnauthorized: !options.insecure,
    }, () => {
        const cert = socket.getPeerX509Certificate();
        console.log(
            `Connected to ${options.host}:${port} over ${socket.getProtocol() ?? 'TLS'}; the certificate is for ` +
                `${cert?.subjectAltName ?? cert?.subject ?? '?'}, SHA-256 fingerprint ${cert?.fingerprint256 ?? '?'}`
        );
        if (!socket.authorized) {
            console.log(`  It is not trusted here (${String(socket.authorizationError)}); --insecure accepts it all the same.`);
        }
        onReady();
    });
    return socket;
};

// Errors that mean the certificate was checked here and refused.
const CERTIFICATE_ERRORS: ReadonlySet<string> = new Set([
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'CERT_HAS_EXPIRED',
    'CERT_NOT_YET_VALID',
    'ERR_TLS_CERT_ALTNAME_INVALID',
]);

// What to try next, for an error that ended the connection before it was ready; undefined if there
// is nothing more to say than the error itself.
export const probeErrorHint = function (options: ProbeOptions, error: Error): string | undefined {
    if (!options.tls) return undefined;

    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (CERTIFICATE_ERRORS.has(code)) {
        return `The server's certificate is not trusted here (${code}). For a self-signed certificate, add --insecure; for ` +
            'one for another name, connect with --host and that name.';
    }
    if (code === 'ECONNRESET' || /before secure TLS connection|wrong version number|packet length too long/i.test(error.message)) {
        return 'The server did not complete a TLS handshake: it probably does not use TLS on this port (TLS_CERT and ' +
            'TLS_KEY are not set there). Try without --tls.';
    }
    return undefined;
};

// What to try next when a connection without TLS was closed before the server sent anything.
export const PLAIN_PROBE_CLOSED_HINT =
    'The server closed the connection without sending anything. If it uses TLS on this port, add --tls (and --insecure ' +
    'for a self-signed certificate); its log says why it refused the connection.';
