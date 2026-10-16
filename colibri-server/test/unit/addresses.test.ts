import { describe, it, expect } from 'vitest';
import { hostPort, normalizeAddress } from '../../src/server/modules/networking/addresses.js';

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
