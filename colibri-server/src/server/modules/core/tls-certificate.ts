import { Observable, Subject } from 'rxjs';
import { Service } from './service.js';
import {
    CertificateInfo,
    TlsCredentials,
    checkTlsCredentials,
    describeCertificateInfo,
    readTlsFiles,
    readTlsFilesAsync,
} from './tls-files.js';

/**
 * How often the server reads TLS_CERT and TLS_KEY again, to take up a renewed certificate. New
 * contents are taken up once two reads in a row have found them, so within twice this.
 *
 * Read rather than watched: a renewal often swaps a symbolic link (Let's Encrypt's live/
 * directory) or a whole directory (a Kubernetes secret) instead of writing to the file, and a file
 * watcher sees neither through a Docker bind mount on every platform. Reading two small files every
 * few seconds costs nothing and sees every kind of change.
 */
export const TLS_FILE_CHECK_MILLIS = 10_000;

// How long before a certificate expires the server warns about it, at most. certbot renews a
// 90-day certificate 30 days ahead, so one that gets this close was not renewed. A short-lived
// certificate (Let's Encrypt also issues 6-day ones) is warned about only in the last fifth of its
// lifetime, so that it is not warned about all the time.
const EXPIRY_WARNING_MILLIS = 7 * 24 * 60 * 60 * 1000;
const EXPIRY_WARNING_SHARE = 0.2;

type Validity = 'valid' | 'expiring' | 'expired' | 'not-yet-valid';

const validityAt = function (info: CertificateInfo, now: number): Validity {
    if (now < info.validFrom.getTime()) return 'not-yet-valid';
    if (now >= info.validTo.getTime()) return 'expired';

    const lifetime = info.validTo.getTime() - info.validFrom.getTime();
    const warnFrom = info.validTo.getTime() - Math.min(EXPIRY_WARNING_MILLIS, lifetime * EXPIRY_WARNING_SHARE);
    return now >= warnFrom ? 'expiring' : 'valid';
};

const sameCredentials = (a: TlsCredentials, b: TlsCredentials): boolean => a.cert.equals(b.cert) && a.key.equals(b.key);

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The certificate and key a TLS server uses now, and each one it should switch to. */
export interface TlsCredentialSource {
    readonly credentials: TlsCredentials;
    /** A renewed certificate and key, already checked to work together. */
    readonly changes$: Observable<TlsCredentials>;
}

export interface TlsCertificateOptions {
    /** See TLS_FILE_CHECK_MILLIS. */
    checkMillis?: number;
    /** The clock the certificate's validity is checked against. */
    now?: () => number;
}

/**
 * The certificate and key from TLS_CERT and TLS_KEY, which the TCP port and the web port both serve
 * TLS with. Logs the certificate's SHA-256 fingerprint at startup, which is what a Unity app can be
 * told to accept as the only certificate; takes up a renewed certificate without a restart; and
 * warns about one that is about to expire, or has.
 */
export class TlsCertificate extends Service implements TlsCredentialSource {
    public get serviceName(): string { return 'TLS'; }
    public get groupName(): string { return 'core'; }

    private current: { credentials: TlsCredentials; info: CertificateInfo };
    private readonly changes = new Subject<TlsCredentials>();

    // New contents one read has found, taken up if the next one finds them too: until then the
    // file may still be being written, or the other of the two still be the old one.
    private candidate: TlsCredentials | undefined;
    // New contents that cannot be used and have been warned about, so that they are not warned
    // about again every few seconds.
    private refused: TlsCredentials | undefined;
    // Why the files could not be read, once that has been warned about.
    private unreadable: string | undefined;
    private validity: Validity = 'valid';

    private timer: NodeJS.Timeout | undefined;
    private checking: Promise<void> | undefined;
    private readonly checkMillis: number;
    private readonly now: () => number;

    /** Reads and checks both files; throws TlsFileError, saying what is wrong, if they cannot be used. */
    public constructor(
        private readonly certPath: string,
        private readonly keyPath: string,
        options: TlsCertificateOptions = {}
    ) {
        super();
        this.current = readTlsFiles(certPath, keyPath);
        this.checkMillis = options.checkMillis ?? TLS_FILE_CHECK_MILLIS;
        this.now = options.now ?? Date.now;
    }

    public get credentials(): TlsCredentials {
        return this.current.credentials;
    }

    public get info(): CertificateInfo {
        return this.current.info;
    }

    public get changes$(): Observable<TlsCredentials> {
        return this.changes.asObservable();
    }

    /** Says which certificate is served, and starts looking for a renewed one. */
    public start(): void {
        const { info } = this.current;
        this.logInfo(
            `TLS is on, with the certificate in ${this.certPath} and the key in ${this.keyPath}: ${describeCertificateInfo(info)}.` +
                (info.selfSigned
                    ? ' A Unity app accepts this self-signed certificate with \'Allow self-signed certificate\' ticked in its Colibri ' +
                      'configuration, or only this one with the fingerprint above as its \'Server certificate SHA-256\'. A browser ' +
                      'has to be told once to trust it.'
                    : '')
        );
        this.checkValidity();

        this.timer = setInterval(() => void this.check(), this.checkMillis);
        // Never the reason the process stays alive.
        this.timer.unref();
    }

    public stop(): void {
        clearInterval(this.timer);
        this.timer = undefined;
    }

    /** Reads both files again and takes up new contents, as start() does every few seconds. */
    public check(): Promise<void> {
        // One at a time: a read that takes longer than the interval, on a network file system say,
        // is not overtaken by the next.
        this.checking ??= this.readAgain().finally(() => {
            this.checking = undefined;
        });
        return this.checking;
    }

    private async readAgain(): Promise<void> {
        let found: TlsCredentials;
        try {
            found = await readTlsFilesAsync(this.certPath, this.keyPath);
        } catch (err) {
            const reason = errorMessage(err);
            if (reason !== this.unreadable) {
                this.unreadable = reason;
                this.logWarning(`${reason} Still serving the certificate with SHA-256 fingerprint ${this.current.info.fingerprint256}.`);
            }
            return;
        }

        if (this.unreadable !== undefined) {
            this.unreadable = undefined;
            this.logInfo(`TLS_CERT (${this.certPath}) and TLS_KEY (${this.keyPath}) can be read again.`);
        }

        if (sameCredentials(found, this.current.credentials)) {
            this.candidate = undefined;
            this.refused = undefined;
            this.checkValidity();
            return;
        }

        if (!this.candidate || !sameCredentials(found, this.candidate)) {
            this.candidate = found;
            return;
        }

        if (this.refused && sameCredentials(found, this.refused)) return;

        let info: CertificateInfo;
        try {
            info = checkTlsCredentials(found, this.certPath, this.keyPath);
        } catch (err) {
            this.refused = found;
            this.logWarning(
                `TLS_CERT or TLS_KEY has changed, but cannot be used: ${errorMessage(err)} Still serving the certificate with ` +
                    `SHA-256 fingerprint ${this.current.info.fingerprint256}.`
            );
            return;
        }

        const previous = this.current.info;
        this.current = { credentials: found, info };
        this.candidate = undefined;
        this.refused = undefined;
        this.validity = 'valid';
        this.logInfo(
            `Reloaded the TLS certificate from ${this.certPath}: ${describeCertificateInfo(info)} (was ${previous.fingerprint256}). ` +
                'New connections use it; open ones keep the one they started with.'
        );
        this.checkValidity();
        this.changes.next(found);
    }

    // Warns once each time the certificate's validity changes for the worse.
    private checkValidity(): void {
        const { info } = this.current;
        const validity = validityAt(info, this.now());
        if (validity === this.validity) return;
        this.validity = validity;

        const renew = 'Renew it: the server takes up a renewed certificate from the same files without a restart.';
        switch (validity) {
            case 'expired':
                this.logWarning(
                    `The TLS certificate ${info.fingerprint256} expired on ${info.validTo.toISOString()}, and clients that check ` +
                        `certificates refuse it. ${renew}`
                );
                break;
            case 'expiring':
                this.logWarning(
                    `The TLS certificate ${info.fingerprint256} expires on ${info.validTo.toISOString()}, and clients that check ` +
                        `certificates will refuse it from then on. ${renew}`
                );
                break;
            case 'not-yet-valid':
                this.logWarning(
                    `The TLS certificate ${info.fingerprint256} is not valid before ${info.validFrom.toISOString()}, and clients ` +
                        'that check certificates refuse it until then. Is this computer\'s clock right?'
                );
                break;
            case 'valid':
                break;
        }
    }
}
