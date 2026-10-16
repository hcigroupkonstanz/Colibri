import { describe, it, expect } from 'vitest';
import { normalizeAddress } from '../../src/server/modules/networking/addresses.js';

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
