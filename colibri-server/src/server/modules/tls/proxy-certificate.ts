import { isIP } from 'net';
import * as tls from 'tls';
import { Service } from '../core/service.js';
import type { CertificateInfo, Validity } from './tls-files.js';
import { describeCertificate, describeCertificateInfo, validityAt } from './tls-files.js';

/**
 * How often the server checks the certificates of PROXY_TLS_ADDRESSES again. A renewal at the proxy
 * shows within this, and so does an expiry the proxy did not renew.
 */
export const PROXY_CERTIFICATE_CHECK_MILLIS = 60 * 60 * 1000;
const CONNECT_TIMEOUT_MILLIS = 10_000;
const DEFAULT_PORT = 443;

export interface ProxyTlsAddress {
    readonly host: string;
    readonly port: number;
}

/** `host:port`, with an IPv6 host in brackets. */
export const formatProxyTlsAddress = function (address: ProxyTlsAddress): string {
    return `${isIP(address.host) === 6 ? `[${address.host}]` : address.host}:${address.port}`;
};

// A host name: letters, digits and hyphens in dot-separated labels.
const HOST_NAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/;

// One entry of PROXY_TLS_ADDRESSES; throws if it is none.
const parseProxyTlsEntry = function (entry: string): ProxyTlsAddress {
    const match = /^(?:\[([^\]]+)\]|([^:[\]]+))(?::(\d{1,5}))?$/.exec(entry);
    const host = match?.[1] ?? match?.[2];
    const port = match?.[3] === undefined ? DEFAULT_PORT : Number(match[3]);
    const validHost = host !== undefined && (match?.[1] !== undefined ? isIP(host) === 6 : isIP(host) === 4 || HOST_NAME.test(host));
    if (!validHost || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid PROXY_TLS_ADDRESSES: "${entry}" is not a host name or IP address with an optional port, `
            + 'e.g. colibri.example.org or colibri.example.org:9212 (an IPv6 address in brackets, e.g. [2001:db8::1]:443)');
    }
    // Without a trailing dot: SNI may not carry one, and Go's TLS servers (Traefik, Caddy) refuse it.
    return { host: host!.replace(/\.$/, ''), port };
};

/**
 * PROXY_TLS_ADDRESSES: `host[:port]` entries separated by commas, an IPv6 address in brackets, port
 * 443 if left out. Throws for the first entry that is none, naming it.
 */
export const parseProxyTlsAddresses = function (raw: string | undefined): ProxyTlsAddress[] {
    const addresses: ProxyTlsAddress[] = [];
    for (const entry of (raw ?? '').split(',').map(part => part.trim()).filter(part => part !== '')) {
        addresses.push(parseProxyTlsEntry(entry));
    }
    return addresses;
};

/** The certificate a proxy address presented, and whether it is trusted for that address. */
export interface ProxyCertificate extends CertificateInfo {
    // Signed by a certificate authority Node trusts (its own list, and NODE_EXTRA_CA_CERTS), and
    // valid for the address's host name.
    readonly trusted: boolean;
    // Why not, as OpenSSL or Node names it, e.g. DEPTH_ZERO_SELF_SIGNED_CERT or ERR_TLS_CERT_ALTNAME_INVALID.
    readonly trustError?: string;
}

/**
 * The outcome of the latest check: one entry per certificate, with every address that presented
 * it, and one per address that could not be checked.
 */
export interface ProxyCertificateResult {
    readonly addresses: string[];
    // Date.now() of the check.
    readonly checkedAt: number;
    readonly certificate?: ProxyCertificate;
    readonly error?: string;
}

type Probe = { certificate: ProxyCertificate } | { error: string };

// Node tries every address of a host name in turn (autoSelectFamily), and when all fail it gives an
// AggregateError with an empty message: the reasons are the errors inside it.
const describeError = function (err: unknown): string {
    if (err instanceof AggregateError && err.errors.length > 0) {
        return err.errors.map(inner => describeError(inner)).join('; ');
    }
    if (err instanceof Error) return err.message || (err as NodeJS.ErrnoException).code || err.name;
    return String(err);
};

export interface ProxyCertificateCheckOptions {
    /** See PROXY_CERTIFICATE_CHECK_MILLIS. */
    checkMillis?: number;
    connectTimeoutMillis?: number;
    /** Certificate authorities to trust instead of Node's own, for the tests. */
    ca?: string | Buffer | Array<string | Buffer>;
    /** The clock the certificates' validity is checked against. */
    now?: () => number;
}

/**
 * The certificates of the reverse proxy in front of this server, which the server cannot see
 * otherwise: TLS ends at the proxy, or the proxy starts TLS of its own towards this server, and
 * clients only ever see the proxy's certificate. The server connects to each of PROXY_TLS_ADDRESSES
 * as a client would, reads the certificate it is presented, and checks it as a client would.
 *
 * The addresses are a setting, never taken from a request: a request's Host header is the client's
 * to choose, and would let anyone have the server connect anywhere.
 */
export class ProxyCertificateCheck extends Service {
    public get serviceName(): string { return 'ProxyTLS'; }
    public get groupName(): string { return 'core'; }

    private latest: ProxyCertificateResult[] = [];
    // What was last logged per address, so that each change is logged once.
    private readonly reported = new Map<string, string>();
    private timer: NodeJS.Timeout | undefined;
    private checking: Promise<void> | undefined;
    private readonly checkMillis: number;
    private readonly connectTimeoutMillis: number;
    private readonly now: () => number;

    public constructor(
        private readonly addresses: ReadonlyArray<ProxyTlsAddress>,
        private readonly options: ProxyCertificateCheckOptions = {}
    ) {
        super();
        this.checkMillis = options.checkMillis ?? PROXY_CERTIFICATE_CHECK_MILLIS;
        this.connectTimeoutMillis = options.connectTimeoutMillis ?? CONNECT_TIMEOUT_MILLIS;
        this.now = options.now ?? Date.now;
    }

    /** The latest check's results; empty until the first check has finished. */
    public get results(): ReadonlyArray<ProxyCertificateResult> {
        return this.latest;
    }

    /** Checks every address now, and again every checkMillis. */
    public start(): void {
        void this.check();
        this.timer = setInterval(() => void this.check(), this.checkMillis);
        // Never the reason the process stays alive.
        this.timer.unref();
    }

    public stop(): void {
        clearInterval(this.timer);
        this.timer = undefined;
    }

    /** Checks every address, one check at a time. Never rejects. */
    public check(): Promise<void> {
        this.checking ??= this.checkAll().finally(() => {
            this.checking = undefined;
        });
        return this.checking;
    }

    private async checkAll(): Promise<void> {
        const probes = await Promise.all(this.addresses.map(address => this.probe(address)));
        const checkedAt = this.now();
        const results: ProxyCertificateResult[] = [];
        const byFingerprint = new Map<string, { addresses: string[]; certificate: ProxyCertificate }>();

        this.addresses.forEach((address, i) => {
            const name = formatProxyTlsAddress(address);
            const probe = probes[i]!;
            this.report(name, probe);
            if ('error' in probe) {
                results.push({ addresses: [ name ], checkedAt, error: probe.error });
                return;
            }
            // Grouped only when trusted alike: the same certificate can be valid for one host name
            // and not for another.
            const key = `${probe.certificate.fingerprint256} ${probe.certificate.trustError ?? ''}`;
            const group = byFingerprint.get(key);
            if (group) group.addresses.push(name);
            else byFingerprint.set(key, { addresses: [ name ], certificate: probe.certificate });
        });

        this.latest = [ ...Array.from(byFingerprint.values(), group => ({ ...group, checkedAt })), ...results ];
    }

    private probe(address: ProxyTlsAddress): Promise<Probe> {
        return new Promise<Probe>(resolve => {
            const socket = tls.connect({
                host: address.host,
                port: address.port,
                // SNI takes a host name only; for an IP address the certificate is checked against it.
                servername: isIP(address.host) === 0 ? address.host : undefined,
                // Read the certificate whatever it is; whether it is trusted is in `authorized`.
                rejectUnauthorized: false,
                ca: this.options.ca,
            });
            socket.setTimeout(this.connectTimeoutMillis, () => {
                socket.destroy(new Error(`no TLS handshake within ${this.connectTimeoutMillis / 1000} s`));
            });
            socket.once('secureConnect', () => {
                socket.setTimeout(0);
                const x509 = socket.getPeerX509Certificate();
                if (!x509) {
                    socket.destroy();
                    resolve({ error: 'no certificate presented' });
                    return;
                }
                const trustError = socket.authorizationError === null ? undefined : String(socket.authorizationError);
                resolve({ certificate: { ...describeCertificate(x509), trusted: socket.authorized, trustError } });
                socket.end();
            });
            // Kept, not once: a reset after the handshake must not become an uncaught 'error'. A
            // resolve after the first one is a no-op.
            socket.on('error', err => resolve({ error: describeError(err) }));
        });
    }

    // Logs what changed for one address since its previous check: its certificate, whether it is
    // trusted, its validity, or that it could not be reached.
    private report(name: string, probe: Probe): void {
        if ('error' in probe) {
            const state = `error ${probe.error}`;
            if (this.reported.get(name) === state) return;
            this.reported.set(name, state);
            this.logWarning(`Could not check the proxy's TLS certificate at ${name} (PROXY_TLS_ADDRESSES): ${probe.error}. `
                + `Checked again every ${this.checkMillis / 60_000} minutes.`);
            return;
        }

        const { certificate } = probe;
        const validity: Validity = validityAt(certificate, this.now());
        const state = `${certificate.fingerprint256} ${certificate.trustError ?? ''} ${validity}`;
        if (this.reported.get(name) === state) return;
        const previous = this.reported.get(name);
        this.reported.set(name, state);

        const description = `Proxy TLS certificate at ${name}: ${describeCertificateInfo(certificate)}`;
        const previousTrust = previous?.startsWith(`${certificate.fingerprint256} `) ? previous.split(' ')[1] : undefined;
        if (!certificate.trusted) {
            if (previousTrust !== (certificate.trustError ?? '')) {
                this.logWarning(`${description}. Clients that check certificates refuse it: ${certificate.trustError}.`);
            }
        } else if (previousTrust === undefined) {
            this.logInfo(`${description}.`);
        } else if (previousTrust !== '') {
            this.logInfo(`The proxy's TLS certificate at ${name} is trusted now (was refused: ${previousTrust}).`);
        }

        const renew = 'Renew it at the proxy.';
        switch (validity) {
            case 'expired':
                this.logWarning(`The proxy's TLS certificate at ${name} expired on ${certificate.validTo.toISOString()}, and clients `
                    + `that check certificates refuse it. ${renew}`);
                break;
            case 'expiring':
                this.logWarning(`The proxy's TLS certificate at ${name} expires on ${certificate.validTo.toISOString()}, and clients `
                    + `that check certificates will refuse it from then on. ${renew}`);
                break;
            case 'not-yet-valid':
                this.logWarning(`The proxy's TLS certificate at ${name} is not valid before ${certificate.validFrom.toISOString()}. `
                    + 'Is this computer\'s clock right?');
                break;
            case 'valid':
                break;
        }
    }
}
