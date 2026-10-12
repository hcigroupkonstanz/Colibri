import { readFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { KeyObject, X509Certificate, createPrivateKey } from 'crypto';
import * as tls from 'tls';

/**
 * A certificate and its private key, both PEM, as read from TLS_CERT and TLS_KEY. The certificate
 * file may hold the certificate's chain after it (Let's Encrypt's fullchain.pem does).
 */
export interface TlsCredentials {
    readonly cert: Buffer;
    readonly key: Buffer;
}

/** What the log says about a certificate. */
export interface CertificateInfo {
    /**
     * SHA-256 of the certificate's DER encoding, as colon-separated upper-case hex. What a Unity
     * client can be given as the one certificate it accepts.
     */
    readonly fingerprint256: string;
    /** The names it is valid for: its subject alternative names, or its subject if it has none. */
    readonly names: string;
    readonly issuer: string;
    readonly validFrom: Date;
    readonly validTo: Date;
    /** Issued and signed by itself, rather than by a certificate authority. */
    readonly selfSigned: boolean;
}

/** TLS_CERT or TLS_KEY cannot be used; the message says which, why, and what to do about it. */
export class TlsFileError extends Error {}

const errorCode = function (error: unknown): string | undefined {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return typeof code === 'string' ? code : undefined;
};

const errorMessage = function (error: unknown): string {
    return error instanceof Error ? error.message : String(error);
};

// PKCS #8 ("BEGIN ENCRYPTED PRIVATE KEY") or a traditional PEM header ("Proc-Type: 4,ENCRYPTED").
const isEncryptedPem = function (pem: Buffer): boolean {
    const text = pem.toString('latin1');
    return text.includes('-----BEGIN ENCRYPTED PRIVATE KEY-----') || /^Proc-Type:\s*4,\s*ENCRYPTED/m.test(text);
};

// X509Certificate gives a distinguished name one attribute per line.
const oneLine = (name: string): string => name.split('\n').filter(part => part !== '').join(', ');

/** Throws TlsFileError when `credentials` cannot serve TLS. The paths are only for the message. */
export const checkTlsCredentials = function (credentials: TlsCredentials, certPath: string, keyPath: string): CertificateInfo {
    let info: CertificateInfo;
    try {
        info = describeCertificate(credentials.cert);
    } catch (err) {
        throw new TlsFileError(
            `TLS_CERT (${certPath}) holds no certificate the server can use (${errorMessage(err)}). It has to be a PEM ` +
                'certificate ("-----BEGIN CERTIFICATE-----"), followed by its chain if it has one (Let\'s Encrypt: fullchain.pem).'
        );
    }

    // Checked by its PEM header: OpenSSL's own error for it is "interrupted or cancelled".
    if (isEncryptedPem(credentials.key)) {
        throw new TlsFileError(
            `TLS_KEY (${keyPath}) is protected by a passphrase, which the server has no way to enter. Store the key ` +
                'without one, for example with: openssl pkey -in <protected key> -out <key>'
        );
    }

    let privateKey: KeyObject;
    try {
        privateKey = createPrivateKey(credentials.key);
    } catch (err) {
        throw new TlsFileError(
            `TLS_KEY (${keyPath}) holds no private key the server can use (${errorMessage(err)}). It has to be the ` +
                'certificate\'s private key in PEM ("-----BEGIN PRIVATE KEY-----" or similar; Let\'s Encrypt: privkey.pem).'
        );
    }

    // Checked here rather than left to createSecureContext: OpenSSL keeps an RSA and an EC key in
    // separate slots, so it takes an RSA certificate with an EC key, or the other way round, without
    // a word, and then fails every handshake.
    if (!new X509Certificate(credentials.cert).checkPrivateKey(privateKey)) {
        throw new TlsFileError(
            `TLS_KEY (${keyPath}) is not the private key of the certificate in TLS_CERT (${certPath}). Both have to ` +
                'come from the same certificate (Let\'s Encrypt: fullchain.pem and privkey.pem from the same directory).'
        );
    }

    try {
        tls.createSecureContext({ cert: credentials.cert, key: credentials.key });
    } catch (err) {
        throw new TlsFileError(`TLS_CERT (${certPath}) and TLS_KEY (${keyPath}) cannot serve TLS together: ${errorMessage(err)}`);
    }

    return info;
};

/** Describes the first certificate in a PEM file: the server's own, ahead of its chain. */
export const describeCertificate = function (cert: Buffer): CertificateInfo {
    const x509 = new X509Certificate(cert);
    return {
        fingerprint256: x509.fingerprint256,
        names: x509.subjectAltName ?? oneLine(x509.subject),
        issuer: oneLine(x509.issuer),
        validFrom: x509.validFromDate,
        validTo: x509.validToDate,
        // Its own name as issuer, and signed with its own key. Not checkIssued(itself), which also
        // asks whether it may sign certificates, and so says no for a self-signed certificate
        // marked as a server's only (PowerShell's New-SelfSignedCertificate makes them like that).
        selfSigned: x509.subject === x509.issuer && x509.verify(x509.publicKey),
    };
};

/** One line for the log: what the certificate is for, who issued it, until when, and its fingerprint. */
export const describeCertificateInfo = function (info: CertificateInfo): string {
    const issuer = info.selfSigned ? 'self-signed' : `issued by ${info.issuer}`;
    return `for ${info.names}, ${issuer}, valid until ${info.validTo.toISOString()}; SHA-256 fingerprint ${info.fingerprint256}`;
};

const describeReadError = function (variable: string, filePath: string, error: unknown): string {
    const base = `Cannot read ${variable} (${filePath}): ${errorMessage(error)}.`;
    switch (errorCode(error)) {
        case 'ENOENT':
            return `${base} It has to name an existing PEM file.`;
        case 'EISDIR':
            return `${base} It has to name the PEM file itself, not the directory it is in.`;
        case 'EACCES':
        case 'EPERM': {
            const uid = process.getuid?.();
            return (
                `${base} The server${uid === undefined ? '' : ` runs as uid ${uid} and`} has to be able to read it. ` +
                'Let\'s Encrypt keeps its private keys readable for root only: copy fullchain.pem and privkey.pem to where ' +
                'the server can read them, for example from a certbot deploy hook, which runs again after every renewal.'
            );
        }
        default:
            return base;
    }
};

const readTlsFile = function (variable: string, filePath: string): Buffer {
    try {
        return readFileSync(filePath);
    } catch (err) {
        throw new TlsFileError(describeReadError(variable, filePath, err));
    }
};

/**
 * Reads TLS_CERT and TLS_KEY and checks that they can serve TLS together. Throws TlsFileError,
 * naming the variable, the file and the fix, when they cannot.
 */
export const readTlsFiles = function (certPath: string, keyPath: string): { credentials: TlsCredentials; info: CertificateInfo } {
    const credentials = { cert: readTlsFile('TLS_CERT', certPath), key: readTlsFile('TLS_KEY', keyPath) };
    return { credentials, info: checkTlsCredentials(credentials, certPath, keyPath) };
};

/** Reads TLS_CERT and TLS_KEY without blocking the thread, and without checking them. */
export const readTlsFilesAsync = async function (certPath: string, keyPath: string): Promise<TlsCredentials> {
    const read = async (variable: string, filePath: string): Promise<Buffer> => {
        try {
            return await readFile(filePath);
        } catch (err) {
            throw new TlsFileError(describeReadError(variable, filePath, err));
        }
    };
    const [cert, key] = await Promise.all([read('TLS_CERT', certPath), read('TLS_KEY', keyPath)]);
    return { cert, key };
};
