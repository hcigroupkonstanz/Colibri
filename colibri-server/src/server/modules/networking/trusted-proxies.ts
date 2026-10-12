import * as net from 'net';
import proxyaddr from 'proxy-addr';

// Behind a reverse proxy every client comes from the proxy's address. A proxy in TRUSTED_PROXIES is
// believed about the client's own: in X-Forwarded-For on the web port, in a PROXY protocol header on
// the TCP port (see TCP_PROXY_PROTOCOL). On the web port it is also believed about whether the client
// reached it over TLS, in X-Forwarded-Proto. Matching is proxy-addr's, the same as Express's
// 'trust proxy': an IPv4-mapped IPv6 address matches as the IPv4 address it maps.

// Whether the peer at `address` is a trusted proxy. `hop` counts the proxies between it and the
// server, 0 for the server's own peer; it is part of Express's signature, and ignored here.
export type TrustProxy = (address: string, hop: number) => boolean;

// The named ranges TRUSTED_PROXIES takes, as proxy-addr defines them: loopback is 127.0.0.0/8 and
// ::1, linklocal 169.254.0.0/16 and fe80::/10, uniquelocal 10.0.0.0/8, 172.16.0.0/12,
// 192.168.0.0/16 and fc00::/7.
export const TRUSTED_PROXY_RANGES: readonly string[] = ['loopback', 'linklocal', 'uniquelocal'];

// TRUSTED_PROXIES left empty: today's behaviour, every client at the address it comes from.
export const trustNoProxy: TrustProxy = () => false;

const describeEntry = function (entry: string): string | undefined {
    if (TRUSTED_PROXY_RANGES.includes(entry)) return undefined;

    // Checked here first: proxy-addr also takes IPv4 shorthands, so that 172.20 would mean
    // 172.0.0.20 and 010.0.0.1 would mean 8.0.0.1. Either is likelier a typo than meant.
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

// TRUSTED_PROXIES: IP addresses, CIDR ranges (10.0.0.0/8, fc00::/7, or with a netmask,
// 10.0.0.0/255.0.0.0) and the named ranges, separated by commas. Throws for the first entry that is
// none of these, naming it.
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

// The address of the client a web request is for: from a trusted peer, the right-most
// X-Forwarded-For entry that is not a trusted proxy itself, else the peer's own. A client can write
// anything into the header it sends, and each proxy appends the address it got the request from,
// so the entries left of the first untrusted one from the right are never believed. Express's
// req.ip follows the same rule.
export const forwardedClientAddress = function (
    peer: string,
    forwardedFor: string | string[] | undefined,
    trust: TrustProxy
): string {
    // Node.js joins repeated X-Forwarded-For lines into one, so an array comes only from elsewhere.
    const header = Array.isArray(forwardedFor) ? forwardedFor.join(', ') : forwardedFor;
    return proxyaddr({ headers: { 'x-forwarded-for': header }, socket: { remoteAddress: peer } }, trust);
};

// Whether a web request came to a trusted peer over TLS, as the peer reports it in
// X-Forwarded-Proto: its right-most entry is https, or wss as Traefik sends for a WebSocket, in any
// case. Never from a peer that is not trusted, as with X-Forwarded-For: a client can send the header
// itself. What stops a client's own value is the proxy replacing the header (nginx: proxy_set_header
// X-Forwarded-Proto $scheme). A proxy that passes it on unchanged forwards the client's value as if
// it were its own, and nothing here can tell. The right-most entry covers a proxy that appends its
// own value, where Express's req.protocol would take the left-most one, the client's.
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
