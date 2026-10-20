import * as net from 'net';
import proxyaddr from 'proxy-addr';

// A proxy in TRUSTED_PROXIES is believed about the client's address (X-Forwarded-For on the web port,
// a PROXY protocol header on the TCP port, see TCP_PROXY_PROTOCOL) and, on the web port, about TLS
// (X-Forwarded-Proto). Matching is proxy-addr's, as in Express's 'trust proxy', so an IPv4-mapped IPv6
// address matches as the IPv4 address it maps.

// Express's 'trust proxy' signature; `hop` (0 for the server's own peer) is ignored here.
export type TrustProxy = (address: string, hop: number) => boolean;

// Named ranges as proxy-addr defines them: loopback (127.0.0.0/8, ::1), linklocal (169.254.0.0/16,
// fe80::/10), uniquelocal (RFC 1918 ranges, fc00::/7).
export const TRUSTED_PROXY_RANGES: readonly string[] = ['loopback', 'linklocal', 'uniquelocal'];

export const trustNoProxy: TrustProxy = () => false;

// The reason `entry` is invalid, or undefined if it is valid.
const describeEntry = function (entry: string): string | undefined {
    if (TRUSTED_PROXY_RANGES.includes(entry)) return undefined;

    // proxy-addr reads 010.0.0.1 as octal, i.e. 8.0.0.1, more likely a typo; net.isIP rejects it.
    const slash = entry.lastIndexOf('/');
    if (net.isIP(slash === -1 ? entry : entry.slice(0, slash)) === 0) {
        return `"${entry}" is not an IP address, a CIDR range or one of ${TRUSTED_PROXY_RANGES.join(', ')}`;
    }
    try {
        proxyaddr.compile(entry);
    } catch {
        return `"${entry}" has an invalid prefix length or netmask (1 to 32 for IPv4, 1 to 128 for IPv6)`;
    }
    return undefined;
};

// Splits TRUSTED_PROXIES at commas: IP addresses, CIDR ranges (prefix length or netmask) and named
// ranges. Throws naming the first invalid entry.
export const parseTrustedProxies = function (raw: string | undefined): string[] {
    const entries = (raw ?? '').split(',').map(entry => entry.trim()).filter(entry => entry !== '');
    for (const entry of entries) {
        const problem = describeEntry(entry);
        if (problem) throw new Error(`Invalid TRUSTED_PROXIES: ${problem}`);
    }
    return entries;
};

export const compileTrustedProxies = function (entries: readonly string[]): TrustProxy {
    return entries.length === 0 ? trustNoProxy : proxyaddr.compile([...entries]);
};

// The client address of a web request: the right-most X-Forwarded-For entry that is not a trusted
// proxy (the left-most if all are), or the peer's own if the peer is not trusted. Entries left of
// that one are never believed, since a client can send any value and each proxy appends the address
// it received from. Same rule as Express's req.ip.
export const forwardedClientAddress = function (
    peer: string,
    forwardedFor: string | string[] | undefined,
    trust: TrustProxy
): string {
    // Node joins repeated headers into one string; the array case is only in the headers type.
    const header = Array.isArray(forwardedFor) ? forwardedFor.join(', ') : forwardedFor;
    return proxyaddr({ headers: { 'x-forwarded-for': header }, socket: { remoteAddress: peer } }, trust);
};

// Whether a trusted peer reports the request as TLS: the right-most X-Forwarded-Proto entry is https,
// or wss (Traefik, for WebSockets). Right-most because a proxy may append its own value, where
// Express's req.protocol takes the left-most, the client's. A proxy must replace the header (nginx:
// proxy_set_header X-Forwarded-Proto $scheme); one that passes it on unchanged forwards the client's
// value and this cannot tell.
export const forwardedTls = function (
    peer: string,
    forwardedProto: string | string[] | undefined,
    trust: TrustProxy
): boolean {
    if (!trust(peer, 0)) return false;

    const header = Array.isArray(forwardedProto) ? forwardedProto.join(',') : forwardedProto ?? '';
    const proto = header.slice(header.lastIndexOf(',') + 1).trim().toLowerCase();
    return proto === 'https' || proto === 'wss';
};
