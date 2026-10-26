import { describe, it, expect } from 'vitest';
import { fellBackToIPv4, hostPort, listenHost, normalizeAddress } from '../../src/server/modules/net/addresses.js';

describe('normalizeAddress', () => {
    it.each([
        [ '::ffff:192.0.2.1', '192.0.2.1' ],
        [ '::FFFF:192.0.2.1', '192.0.2.1' ],
        [ '192.0.2.1', '192.0.2.1' ],
        [ '::1', '::1' ],
        [ '2001:db8::1', '2001:db8::1' ],
        // Not an IPv4 address after the prefix.
        [ '::ffff:c000:201', '::ffff:c000:201' ],
        [ '::ffff:', '::ffff:' ],
        [ '', '' ],
    ])('turns "%s" into "%s"', (address, normalized) => {
        expect(normalizeAddress(address)).toBe(normalized);
    });
});

describe('hostPort', () => {
    it.each([
        [ '0.0.0.0', 9211, '0.0.0.0:9211' ],
        [ 'localhost', 9212, 'localhost:9212' ],
        [ '::', 9211, '[::]:9211' ],
        [ '2001:db8::1', '9213', '[2001:db8::1]:9213' ],
    ])('joins %s and %s as %s', (host, port, joined) => {
        expect(hostPort(host, port)).toBe(joined);
    });
});

describe('listenHost', () => {
    // No host has Node listen on :: with IPv4 as well, or on 0.0.0.0 without IPv6.
    it('hands no host to listen() for ::', () => {
        expect(listenHost('::')).toBeUndefined();
    });

    it.each([ '0.0.0.0', '::1', '127.0.0.1', 'localhost' ])('hands %s on as it is', (host) => {
        expect(listenHost(host)).toBe(host);
    });
});

describe('fellBackToIPv4', () => {
    it.each([
        [ '::', { address: '0.0.0.0', family: 'IPv4', port: 9211 }, true ],
        [ '::', { address: '::', family: 'IPv6', port: 9211 }, false ],
        [ '0.0.0.0', { address: '0.0.0.0', family: 'IPv4', port: 9211 }, false ],
        [ '::', null, false ],
    ] as const)('says whether %s that listens on %j fell back', (host, bound, fellBack) => {
        expect(fellBackToIPv4(host, bound)).toBe(fellBack);
    });
});
