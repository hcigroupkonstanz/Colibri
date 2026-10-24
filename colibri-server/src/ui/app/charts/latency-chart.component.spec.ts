import { TIME_RANGE_MILLIS, boxLayout, perSecond, timeDomain } from './latency-chart.component';

describe('timeDomain', () => {
    it('spans the whole 120 s window, and the second it slides, however few samples there are', () => {
        expect(TIME_RANGE_MILLIS).toBe(120_000);
        expect(timeDomain(1_700_000_000_000)).toEqual([ 1_700_000_000_000 - 121_000, 1_700_000_000_000 ]);
    });
});

describe('perSecond', () => {
    it('draws a client as the median of each second, at the samples\' mean time', () => {
        expect(perSecond([ [ 1000, 5 ], [ 1100, 1 ], [ 1200, 9 ], [ 2050, 4 ], [ 2150, 6 ] ])).toEqual([ [ 1100, 5 ], [ 2100, 5 ] ]);
        expect(perSecond([])).toEqual([]);
    });
});

describe('boxLayout', () => {
    it('gives each client a box of up to 29px within 40% of the plot', () => {
        expect(boxLayout(1200, 1144, 6)).toEqual({ band: 29, hidden: null });
        expect(boxLayout(1200, 1144, 20)).toEqual({ band: 1144 * 0.4 / 20, hidden: null });
    });

    it('draws no boxes on a narrow chart, or when a box each would be under 14px', () => {
        expect(boxLayout(599, 543, 2)).toEqual({ band: 0, hidden: 'narrow' });
        expect(boxLayout(1200, 1144, 32)).toEqual({ band: 1144 * 0.4 / 32, hidden: null });
        expect(boxLayout(1200, 1144, 33)).toEqual({ band: 0, hidden: 'count' });
    });
});
