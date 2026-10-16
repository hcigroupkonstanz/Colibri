import * as net from 'net';

const IPV4_MAPPED_PREFIX = '::ffff:';

/**
 * `address` without the `::ffff:` of an IPv4-mapped IPv6 address. A dual-stack socket reports an
 * IPv4 client as `::ffff:192.0.2.1`, an IPv4 socket as `192.0.2.1`. Every client address the
 * server shows or compares goes through this, so an IPv4 client is always named by its IPv4
 * address, whichever kind of socket it came in on.
 */
export const normalizeAddress = function (address: string): string {
    if (address.length <= IPV4_MAPPED_PREFIX.length || address.slice(0, IPV4_MAPPED_PREFIX.length).toLowerCase() !== IPV4_MAPPED_PREFIX) {
        return address;
    }
    const ipv4 = address.slice(IPV4_MAPPED_PREFIX.length);
    return net.isIPv4(ipv4) ? ipv4 : address;
};

/** `host:port`, with an IPv6 host in brackets as in a URL: `[::]:9211`, not `:::9211`. */
export const hostPort = function (host: string, port: number | string): string {
    return `${net.isIPv6(host) ? `[${host}]` : host}:${port}`;
};
