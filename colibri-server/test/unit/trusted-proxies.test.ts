import { describe, it, expect } from 'vitest';
import {
    compileTrustedProxies,
    forwardedClientAddress,
    forwardedTls,
    parseTrustedProxies,
} from '../../src/server/modules/networking/trusted-proxies.js';

const trusting = (setting: string) => compileTrustedProxies(parseTrustedProxies(setting));

describe('parseTrustedProxies', () => {
    it('takes nothing for unset, empty or blank', () => {
        expect(parseTrustedProxies(undefined)).toEqual([]);
        expect(parseTrustedProxies('')).toEqual([]);
        expect(parseTrustedProxies('  ')).toEqual([]);
    });

    it('takes addresses, CIDR ranges and named ranges, separated by commas', () => {
        expect(parseTrustedProxies(' loopback, uniquelocal,linklocal ,203.0.113.7, 2001:db8::1, 172.20.0.0/16, fc00::/7, 10.0.0.0/255.0.0.0,'))
            .toEqual(['loopback', 'uniquelocal', 'linklocal', '203.0.113.7', '2001:db8::1', '172.20.0.0/16', 'fc00::/7', '10.0.0.0/255.0.0.0']);
    });

    it.each([
        ['proxy.example.org'],
        ['Loopback'],
        // IPv4 shorthands, which proxy-addr would take as 172.0.0.20 and 8.0.0.1
        ['172.20'],
        ['010.0.0.1'],
        ['10.0.0.0/8/8'],
    ])('refuses "%s", naming it', (entry) => {
        expect(() => parseTrustedProxies(`loopback, ${entry}`))
            .toThrow(`Invalid TRUSTED_PROXIES: "${entry}" is not an IP address, a CIDR range or one of loopback, linklocal, uniquelocal`);
    });

    it.each([['10.0.0.0/33'], ['fc00::/129'], ['0.0.0.0/0'], ['10.0.0.0/x'], ['10.0.0.0/255.0.255.0']])('refuses the range "%s", naming it', (entry) => {
        expect(() => parseTrustedProxies(entry))
            .toThrow(`Invalid TRUSTED_PROXIES: "${entry}" has an invalid prefix length or netmask`);
    });
});

describe('compileTrustedProxies', () => {
    it('trusts nobody when empty', () => {
        const trust = compileTrustedProxies([]);

        for (const address of ['127.0.0.1', '::1', '10.0.0.1', '172.20.0.1']) {
            expect(trust(address, 0)).toBe(false);
        }
    });

    it('matches single addresses exactly', () => {
        const trust = trusting('203.0.113.7, 2001:db8::1');

        expect(trust('203.0.113.7', 0)).toBe(true);
        expect(trust('2001:db8::1', 0)).toBe(true);
        expect(trust('2001:0db8:0:0:0:0:0:1', 0)).toBe(true);
        expect(trust('203.0.113.8', 0)).toBe(false);
        expect(trust('2001:db8::2', 0)).toBe(false);
    });

    it('matches IPv4 CIDR ranges and netmasks', () => {
        const trust = trusting('172.20.0.0/16, 198.51.100.0/255.255.255.0');

        expect(trust('172.20.0.1', 0)).toBe(true);
        expect(trust('172.20.255.254', 0)).toBe(true);
        expect(trust('172.21.0.1', 0)).toBe(false);
        expect(trust('198.51.100.99', 0)).toBe(true);
        expect(trust('198.51.101.1', 0)).toBe(false);
    });

    it('matches IPv6 CIDR ranges', () => {
        const trust = trusting('2001:db8::/32');

        expect(trust('2001:db8:1::5', 0)).toBe(true);
        expect(trust('2001:db9::1', 0)).toBe(false);
        expect(trust('203.0.113.7', 0)).toBe(false);
    });

    it('matches an IPv4-mapped IPv6 address as the IPv4 address it maps, both ways', () => {
        expect(trusting('10.0.0.0/8')('::ffff:10.1.2.3', 0)).toBe(true);
        expect(trusting('10.0.0.0/8')('::ffff:11.1.2.3', 0)).toBe(false);
        expect(trusting('loopback')('::ffff:127.0.0.1', 0)).toBe(true);
        expect(trusting('::ffff:192.0.2.1')('192.0.2.1', 0)).toBe(true);
    });

    it('knows the named ranges', () => {
        const loopback = trusting('loopback');
        expect(['127.0.0.1', '127.255.255.254', '::1'].map(a => loopback(a, 0))).toEqual([true, true, true]);
        expect(['128.0.0.1', '::2', '10.0.0.1'].map(a => loopback(a, 0))).toEqual([false, false, false]);

        const linklocal = trusting('linklocal');
        expect(['169.254.1.1', 'fe80::1'].map(a => linklocal(a, 0))).toEqual([true, true]);
        expect(['169.255.0.1', 'fec0::1'].map(a => linklocal(a, 0))).toEqual([false, false]);

        const uniquelocal = trusting('uniquelocal');
        expect(['10.1.2.3', '172.16.0.1', '172.20.0.1', '172.31.255.255', '192.168.1.1', 'fc00::1', 'fd12:3456::1']
            .map(a => uniquelocal(a, 0))).toEqual([true, true, true, true, true, true, true]);
        expect(['172.32.0.1', '172.15.255.255', '192.169.0.1', '8.8.8.8', '127.0.0.1', 'fe80::1']
            .map(a => uniquelocal(a, 0))).toEqual([false, false, false, false, false, false]);
    });

    it('never trusts what is not an address', () => {
        const trust = trusting('loopback, uniquelocal');

        expect(trust('unknown', 0)).toBe(false);
        expect(trust('', 0)).toBe(false);
        expect(trust('127.0.0.1:443', 0)).toBe(false);
    });
});

describe('forwardedClientAddress', () => {
    const trust = trusting('loopback, uniquelocal');

    it('ignores X-Forwarded-For from a peer that is not trusted', () => {
        expect(forwardedClientAddress('203.0.113.7', '198.51.100.1', trust)).toBe('203.0.113.7');
        expect(forwardedClientAddress('203.0.113.7', '198.51.100.1', compileTrustedProxies([]))).toBe('203.0.113.7');
        expect(forwardedClientAddress('127.0.0.1', '198.51.100.1', compileTrustedProxies([]))).toBe('127.0.0.1');
    });

    it('keeps a trusted peer\'s own address when it sends no X-Forwarded-For', () => {
        expect(forwardedClientAddress('172.20.0.1', undefined, trust)).toBe('172.20.0.1');
        expect(forwardedClientAddress('172.20.0.1', '', trust)).toBe('172.20.0.1');
    });

    it('takes the client from a trusted peer\'s X-Forwarded-For', () => {
        expect(forwardedClientAddress('172.20.0.1', '198.51.100.1', trust)).toBe('198.51.100.1');
        expect(forwardedClientAddress('::ffff:127.0.0.1', '2001:db8::7', trust)).toBe('2001:db8::7');
    });

    // nginx's $proxy_add_x_forwarded_for appends the address it got the request from to whatever
    // the client sent.
    it('takes the right-most untrusted entry, so a client cannot choose its address by sending the header itself', () => {
        expect(forwardedClientAddress('172.20.0.1', '6.6.6.6, 198.51.100.1', trust)).toBe('198.51.100.1');
        expect(forwardedClientAddress('172.20.0.1', '6.6.6.6,7.7.7.7 , 198.51.100.1', trust)).toBe('198.51.100.1');
        expect(forwardedClientAddress('172.20.0.1', 'not-an-address, 198.51.100.1', trust)).toBe('198.51.100.1');
    });

    it('passes over trusted proxies in the chain', () => {
        expect(forwardedClientAddress('172.20.0.1', '6.6.6.6, 198.51.100.1, 10.0.0.5', trust)).toBe('198.51.100.1');
    });

    it('takes the left-most entry when every entry is trusted', () => {
        expect(forwardedClientAddress('172.20.0.1', '10.0.0.9, 10.0.0.5', trust)).toBe('10.0.0.9');
        expect(forwardedClientAddress('127.0.0.1', '192.168.1.20', trust)).toBe('192.168.1.20');
    });

    it('reads repeated header lines as one', () => {
        expect(forwardedClientAddress('172.20.0.1', ['6.6.6.6', '198.51.100.1'], trust)).toBe('198.51.100.1');
    });
});

describe('forwardedTls', () => {
    const trust = trusting('loopback, uniquelocal');

    it('takes https from a trusted peer\'s X-Forwarded-Proto', () => {
        expect(forwardedTls('172.20.0.1', 'https', trust)).toBe(true);
        expect(forwardedTls('::ffff:127.0.0.1', 'https', trust)).toBe(true);
        expect(forwardedTls('172.20.0.1', 'http', trust)).toBe(false);
    });

    it('takes wss, as Traefik sends for a WebSocket', () => {
        expect(forwardedTls('172.20.0.1', 'wss', trust)).toBe(true);
        expect(forwardedTls('172.20.0.1', 'ws', trust)).toBe(false);
    });

    it('reads the scheme in any case and with spaces around it', () => {
        expect(forwardedTls('172.20.0.1', 'HTTPS', trust)).toBe(true);
        expect(forwardedTls('172.20.0.1', ' Https ', trust)).toBe(true);
        expect(forwardedTls('172.20.0.1', 'WSS', trust)).toBe(true);
    });

    it('ignores X-Forwarded-Proto from a peer that is not trusted', () => {
        expect(forwardedTls('203.0.113.7', 'https', trust)).toBe(false);
        expect(forwardedTls('127.0.0.1', 'https', compileTrustedProxies([]))).toBe(false);
    });

    it('is false without the header, or with anything but a scheme in it', () => {
        expect(forwardedTls('172.20.0.1', undefined, trust)).toBe(false);
        expect(forwardedTls('172.20.0.1', '', trust)).toBe(false);
        expect(forwardedTls('172.20.0.1', 'https:', trust)).toBe(false);
        expect(forwardedTls('172.20.0.1', 'https,', trust)).toBe(false);
    });

    // A proxy that appends, as X-Forwarded-For is appended to, puts its own value last. A client's
    // own value is kept out only by a proxy that appends or replaces the header, not one that passes
    // it on unchanged.
    it('takes the right-most entry, the one a proxy that appends added itself', () => {
        expect(forwardedTls('172.20.0.1', 'https, http', trust)).toBe(false);
        expect(forwardedTls('172.20.0.1', 'http,https', trust)).toBe(true);
        expect(forwardedTls('172.20.0.1', 'http, http , HTTPS', trust)).toBe(true);
    });

    it('reads repeated header lines as one', () => {
        expect(forwardedTls('172.20.0.1', ['https', 'http'], trust)).toBe(false);
        expect(forwardedTls('172.20.0.1', ['http', 'https'], trust)).toBe(true);
    });
});
