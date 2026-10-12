import { describe, it, expect } from 'vitest';
import { AddressThrottle } from '../../src/server/modules/networking/address-throttle.js';

describe('AddressThrottle', () => {
    it('lets a warning about an address through once per interval', () => {
        const throttle = new AddressThrottle(60_000);

        expect(throttle.shouldWarn('10.0.0.1', 0)).toBe(true);
        expect(throttle.shouldWarn('10.0.0.1', 1_000)).toBe(false);
        expect(throttle.shouldWarn('10.0.0.1', 59_999)).toBe(false);
        expect(throttle.shouldWarn('10.0.0.1', 60_000)).toBe(true);
    });

    it('counts each address on its own', () => {
        const throttle = new AddressThrottle(60_000);

        expect(throttle.shouldWarn('10.0.0.1', 0)).toBe(true);
        expect(throttle.shouldWarn('10.0.0.2', 1)).toBe(true);
        expect(throttle.shouldWarn('10.0.0.1', 2)).toBe(false);
    });

    it('forgets the address warned about longest ago once it remembers the maximum', () => {
        const throttle = new AddressThrottle(60_000, 3);
        for (const [i, address] of [ 'a', 'b', 'c' ].entries()) throttle.shouldWarn(address, i);

        expect(throttle.shouldWarn('d', 10)).toBe(true);

        expect(throttle.size).toBe(3);
        // 'a' was forgotten, so it is warned about again; 'c' was not.
        expect(throttle.shouldWarn('c', 11)).toBe(false);
        expect(throttle.shouldWarn('a', 12)).toBe(true);
    });

    it('drops addresses whose interval has passed', () => {
        const throttle = new AddressThrottle(1_000);
        for (let i = 0; i < 100; i++) throttle.shouldWarn(`10.0.0.${i}`, i);

        throttle.shouldWarn('10.0.1.1', 5_000);

        expect(throttle.size).toBe(1);
    });
});
