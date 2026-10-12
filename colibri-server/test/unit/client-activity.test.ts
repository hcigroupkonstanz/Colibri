import { describe, it, expect } from 'vitest';
import { RATE_HISTORY_LENGTH, RATE_WINDOW_MILLIS, TrafficMeter } from '../../src/server/modules/networking/client-activity.js';

describe('TrafficMeter', () => {
    it('turns counts into rates once a window has passed', () => {
        const meter = new TrafficMeter(0);
        meter.received = 50;
        meter.sent = 10;
        meter.sample(RATE_WINDOW_MILLIS / 2);
        expect(meter.receivedPerSecond).toBeNull();

        meter.sample(2 * RATE_WINDOW_MILLIS);
        expect(meter.receivedPerSecond).toBe(25);
        expect(meter.sentPerSecond).toBe(5);

        meter.received += 30;
        meter.sample(3 * RATE_WINDOW_MILLIS, 40);
        expect(meter.receivedPerSecond).toBe(30);
        expect(meter.sentPerSecond).toBe(30);
    });

    it('keeps its last RATE_HISTORY_LENGTH rates, each at the Date.now() of its sample', () => {
        const meter = new TrafficMeter(0);
        meter.sample(500);
        expect(meter.history(500, 10_000)).toEqual([]);

        for (let second = 1; second <= RATE_HISTORY_LENGTH + 5; second++) {
            meter.received += second;
            meter.sent += 2 * second;
            meter.sample(second * RATE_WINDOW_MILLIS);
        }

        // performance.now() 130_000 is Date.now() 1_700_000_000_000
        const history = meter.history(130_000, 1_700_000_000_000);
        expect(history).toHaveLength(RATE_HISTORY_LENGTH);
        expect(history[0]).toEqual([ 1_700_000_000_000 - 124_000, 6, 12 ]);
        expect(history.at(-1)).toEqual([ 1_700_000_000_000, 130, 260 ]);
    });
});
