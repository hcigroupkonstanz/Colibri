import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import type { WritableSignal } from '@angular/core';
import { signal } from '@angular/core';
import type { ColibriClient } from '../connection/client.service';
import { ClientService } from '../connection/client.service';
import { LatencyChartComponent, TIME_RANGE_MILLIS, boxLayout, perSecond, timeDomain } from './latency-chart.component';
import type { ChartTestEnvironment } from '../../testing/use-chart-test-environment';
import { useChartTestEnvironment } from '../../testing/use-chart-test-environment';

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

describe('LatencyChartComponent', () => {
    // 22:14:02.5 UTC: the time axis has ticks at 22:13 and 22:14, and every 15 s between.
    const NOW = 1_700_000_042_500;

    let environment: ChartTestEnvironment;
    let wall: number;
    let size: { width: number; height: number };
    let clients: WritableSignal<ReadonlyArray<ColibriClient>>;
    let resizeCallbacks: (() => void)[];
    let secondTimer: (() => void) | undefined;

    // One sample every 500 ms, ending 500 ms before `end`, from a repeating pattern.
    const samples = (end: number, count: number, base: number, spread: number): [number, number][] =>
        Array.from({ length: count }, (_, i): [number, number] => [ end - (count - i) * 500, base + (i * 37) % spread ]);

    const client = (id: string, slot: number, latency: [number, number][]): ColibriClient =>
        ({ id, app: 'demo', name: id, version: '2', latency, slot });

    const withSpike = (latency: [number, number][], index: number, value: number): [number, number][] =>
        latency.map((sample, i): [number, number] => i === index ? [ sample[0], value ] : sample);

    const markup = (fixture: ComponentFixture<LatencyChartComponent>): string =>
        (fixture.nativeElement as HTMLElement).querySelector('svg')!.outerHTML
            .replace(/<(?!\/(?:path|line|circle|rect|text)>)/g, '\n<').slice(1)
            // the id counts the charts made before
            .replace(/latency-clip-\d+/g, 'latency-clip-N');

    const open = async (): Promise<ComponentFixture<LatencyChartComponent>> => {
        const fixture = TestBed.createComponent(LatencyChartComponent);
        fixture.detectChanges();
        TestBed.flushEffects();
        await environment.settle(fixture.nativeElement as HTMLElement);
        return fixture;
    };

    // The interval of ngAfterViewInit: a second on, the chart slides and redraws.
    const nextSecond = async (fixture: ComponentFixture<LatencyChartComponent>) => {
        wall += 1000;
        secondTimer!();
        await environment.settle(fixture.nativeElement as HTMLElement);
    };

    beforeEach(() => {
        environment = useChartTestEnvironment();
        wall = NOW;
        size = { width: 800, height: 300 };
        resizeCallbacks = [];
        secondTimer = undefined;
        clients = signal<ReadonlyArray<ColibriClient>>([]);

        vi.spyOn(Date, 'now').mockImplementation(() => wall);
        vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(() => size.width);
        vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(() => size.height);
        // The chart's own 1 s timer is held back; d3's and jsdom's frame timers must run.
        const setInterval = window.setInterval.bind(window);
        vi.spyOn(window, 'setInterval').mockImplementation(((handler: () => void, delay?: number) => {
            if (delay === 1000 && !secondTimer) {
                secondTimer = handler;
                return 0;
            }
            return setInterval(handler, delay);
        }) as typeof window.setInterval);
        vi.stubGlobal('ResizeObserver', class {
            public readonly observe = vi.fn();
            public readonly disconnect = vi.fn();

            public constructor(callback: () => void) {
                resizeCallbacks.push(callback);
            }
        });
        TestBed.configureTestingModule({ providers: [ { provide: ClientService, useValue: { clients } } ] });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        environment.restore();
    });

    it('draws a line and a box of each client with samples, then the clients that come and go', async () => {
        clients.set([
            client('a', 0, withSpike(samples(NOW, 24, 20, 17), 9, 95)),
            client('b', 1, samples(NOW, 24, 45, 23)),
            client('c', 2, [])
        ]);
        const fixture = await open();
        expect(secondTimer).toBeDefined();
        expect(markup(fixture)).toBe(`<svg width="800" height="300">
<g transform="translate(701, 12)">
<g transform="translate(2.5, 0)" color="#df8f48" class="plot">
<g class="whisker" transform="translate(12,0)">
<path fill="none" stroke="currentColor" opacity="0.5" d="M-12,208 l24,0 m-12,0 L0,200.20000000000002"></path>
<path fill="none" stroke="currentColor" opacity="0.5" d="M-12,166.4 l24,0 m-12,0 L0,176.15"></path>
</g>
<g class="box" transform="translate(12,0)">
<line stroke="currentColor" stroke-width="24" opacity="0.5" y1="200.20000000000002" y2="188" x1="0" x2="0" width="24"></line>
<line stroke="currentColor" stroke-width="24" opacity="0.5" y1="189" y2="176.15" x1="0" x2="0" width="24"></line>
</g>
<g class="point" transform="translate(12,0)">
<circle class="point outlier farout" fill="currentColor" stroke="none" opacity="0.5" r="3.674234614174767" cy="13.00000000000001" cx="0"></circle>
</g>
</g>
<g transform="translate(31.5, 0)" color="#c595db" class="plot">
<g class="whisker" transform="translate(12,0)">
<path fill="none" stroke="currentColor" opacity="0.5" d="M-12,143 l24,0 m-12,0 L0,130.64999999999998"></path>
<path fill="none" stroke="currentColor" opacity="0.5" d="M-12,85.79999999999998 l24,0 m-12,0 L0,100.74999999999999"></path>
</g>
<g class="box" transform="translate(12,0)">
<line stroke="currentColor" stroke-width="24" opacity="0.5" y1="130.64999999999998" y2="115.19999999999999" x1="0" x2="0" width="24"></line>
<line stroke="currentColor" stroke-width="24" opacity="0.5" y1="116.19999999999999" y2="100.74999999999999" x1="0" x2="0" width="24"></line>
</g>
<g class="point" transform="translate(12,0)">
</g>
</g>
</g>
<clipPath id="latency-clip-N">
<rect y="-2" height="264" width="657"></rect>
</clipPath>
<g transform="translate(44,12)" clip-path="url(#latency-clip-N)">
<g transform="translate(-5.429752066115703, 0)">
<path class="line" fill="none" stroke="#df8f48" stroke-width="1.5" d="M591.843,208L595.915,196.3L601.345,180.7L606.775,187.2L612.205,193.7L617.634,93.6L623.064,184.6L628.494,191.1L633.924,175.5L639.353,204.1L644.783,188.5L650.213,172.9L654.285,205.4"></path>
<path class="line" fill="none" stroke="#c595db" stroke-width="1.5" d="M591.843,143L595.915,118.3L601.345,105.3L606.775,122.2L612.205,109.2L617.634,126.1L623.064,113.1L628.494,100.1L633.924,117L639.353,104L644.783,120.9L650.213,107.9L654.285,143"></path>
</g>
</g>
<g class="axis" transform="translate(44, 272)" fill="none" font-size="10" font-family="sans-serif" text-anchor="middle">
<path class="domain" stroke="currentColor" d="M0.5,6V0.5H657.5V6"></path>
<g class="tick" opacity="1" transform="translate(73.80165289256199,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:15</text>
</g>
<g class="tick" opacity="1" transform="translate(155.2479338842975,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:30</text>
</g>
<g class="tick" opacity="1" transform="translate(236.69421487603307,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:45</text>
</g>
<g class="tick" opacity="1" transform="translate(318.1404958677686,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">22:13</text>
</g>
<g class="tick" opacity="1" transform="translate(399.58677685950414,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:15</text>
</g>
<g class="tick" opacity="1" transform="translate(481.0330578512397,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:30</text>
</g>
<g class="tick" opacity="1" transform="translate(562.4793388429753,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:45</text>
</g>
<g class="tick" opacity="1" transform="translate(643.9256198347107,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">22:14</text>
</g>
</g>
<g class="axis" transform="translate(44, 12)" fill="none" font-size="10" font-family="sans-serif" text-anchor="end">
<path class="domain" stroke="currentColor" d="M-6,0.5H0.5V260.5H-6"></path>
<g class="tick" opacity="1" transform="translate(0,0.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">100</text>
</g>
<g class="tick" opacity="1" transform="translate(0,52.499999999999986)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">80</text>
</g>
<g class="tick" opacity="1" transform="translate(0,104.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">60</text>
</g>
<g class="tick" opacity="1" transform="translate(0,156.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">40</text>
</g>
<g class="tick" opacity="1" transform="translate(0,208.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">20</text>
</g>
<g class="tick" opacity="1" transform="translate(0,260.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">0</text>
</g>
</g>
</svg>`);

        // b leaves, c has its first samples, d connects: the g.plot and path.line of a join in place
        clients.set([
            client('a', 0, withSpike(samples(NOW + 1000, 26, 20, 17), 9, 95)),
            client('c', 2, samples(NOW + 1000, 4, 30, 9)),
            client('d', 3, samples(NOW + 1000, 6, 60, 31))
        ]);
        TestBed.flushEffects();
        expect(markup(fixture)).toBe(`<svg width="800" height="300">
<g transform="translate(701, 12)">
<g transform="translate(2.5, 0)" color="#df8f48" class="plot">
<g class="whisker" transform="translate(12,0)">
<path fill="none" stroke="currentColor" opacity="0.5" d="M-12,208 l24,0 m-12,0 L0,199.54999999999998"></path>
<path fill="none" stroke="currentColor" opacity="0.5" d="M-12,166.4 l24,0 m-12,0 L0,176.79999999999998"></path>
</g>
<g class="box" transform="translate(12,0)">
<line stroke="currentColor" stroke-width="24" opacity="0.5" y1="199.54999999999998" y2="189.29999999999998" x1="0" x2="0" width="24"></line>
<line stroke="currentColor" stroke-width="24" opacity="0.5" y1="190.29999999999998" y2="176.79999999999998" x1="0" x2="0" width="24"></line>
</g>
<g class="point" transform="translate(12,0)">
<circle class="point outlier farout" fill="currentColor" stroke="none" opacity="0.5" r="3.674234614174767" cy="13.00000000000001" cx="0"></circle>
</g>
</g>
<g transform="translate(31.5, 0)" color="#d8dee9" class="plot">
<g class="whisker" transform="translate(12,0)">
<path fill="none" stroke="currentColor" opacity="0.5" d="M-12,182 l24,0 m-12,0 L0,180.05"></path>
<path fill="none" stroke="currentColor" opacity="0.5" d="M-12,174.2 l24,0 m-12,0 L0,176.15"></path>
</g>
<g class="box" transform="translate(12,0)">
<line stroke="currentColor" stroke-width="24" opacity="0.5" y1="180.05" y2="177.60000000000002" x1="0" x2="0" width="24"></line>
<line stroke="currentColor" stroke-width="24" opacity="0.5" y1="178.60000000000002" y2="176.15" x1="0" x2="0" width="24"></line>
</g>
<g class="point" transform="translate(12,0)">
</g>
</g>
<g transform="translate(60.5, 0)" color="#62b7a1" class="plot">
<g class="whisker" transform="translate(12,0)">
<path fill="none" stroke="currentColor" opacity="0.5" d="M-12,104 l24,0 m-12,0 L0,84.49999999999999"></path>
<path fill="none" stroke="currentColor" opacity="0.5" d="M-12,25.999999999999993 l24,0 m-12,0 L0,45.500000000000014"></path>
</g>
<g class="box" transform="translate(12,0)">
<line stroke="currentColor" stroke-width="24" opacity="0.5" y1="84.49999999999999" y2="64.5" x1="0" x2="0" width="24"></line>
<line stroke="currentColor" stroke-width="24" opacity="0.5" y1="65.5" y2="45.500000000000014" x1="0" x2="0" width="24"></line>
</g>
<g class="point" transform="translate(12,0)">
</g>
</g>
</g>
<clipPath id="latency-clip-N">
<rect y="-2" height="264" width="657"></rect>
</clipPath>
<g transform="translate(44,12)" clip-path="url(#latency-clip-N)">
<g transform="translate(-5.429752066115703, 0)">
<path class="line" fill="none" stroke="#df8f48" stroke-width="1.5" d="M591.843,208L595.915,196.3L601.345,180.7L606.775,187.2L612.205,193.7L617.634,93.6L623.064,184.6L628.494,191.1L633.924,175.5L639.353,204.1L644.783,188.5L650.213,172.9L655.643,201.5L659.715,189.8"></path>
<path class="line" fill="none" stroke="#d8dee9" stroke-width="1.5" d="M651.57,182L655.643,178.1L659.715,174.2"></path>
<path class="line" fill="none" stroke="#62b7a1" stroke-width="1.5" d="M646.14,104L650.213,80.6L655.643,49.4L659.715,26"></path>
</g>
</g>
<g class="axis" transform="translate(44, 272)" fill="none" font-size="10" font-family="sans-serif" text-anchor="middle">
<path class="domain" stroke="currentColor" d="M0.5,6V0.5H657.5V6"></path>
<g class="tick" opacity="1" transform="translate(73.80165289256199,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:15</text>
</g>
<g class="tick" opacity="1" transform="translate(155.2479338842975,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:30</text>
</g>
<g class="tick" opacity="1" transform="translate(236.69421487603307,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:45</text>
</g>
<g class="tick" opacity="1" transform="translate(318.1404958677686,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">22:13</text>
</g>
<g class="tick" opacity="1" transform="translate(399.58677685950414,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:15</text>
</g>
<g class="tick" opacity="1" transform="translate(481.0330578512397,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:30</text>
</g>
<g class="tick" opacity="1" transform="translate(562.4793388429753,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:45</text>
</g>
<g class="tick" opacity="1" transform="translate(643.9256198347107,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">22:14</text>
</g>
</g>
<g class="axis" transform="translate(44, 12)" fill="none" font-size="10" font-family="sans-serif" text-anchor="end">
<path class="domain" stroke="currentColor" d="M-6,0.5H0.5V260.5H-6"></path>
<g class="tick" opacity="1" transform="translate(0,0.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">100</text>
</g>
<g class="tick" opacity="1" transform="translate(0,52.499999999999986)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">80</text>
</g>
<g class="tick" opacity="1" transform="translate(0,104.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">60</text>
</g>
<g class="tick" opacity="1" transform="translate(0,156.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">40</text>
</g>
<g class="tick" opacity="1" transform="translate(0,208.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">20</text>
</g>
<g class="tick" opacity="1" transform="translate(0,260.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">0</text>
</g>
</g>
</svg>`);

        await nextSecond(fixture);
        expect(markup(fixture)).toBe(`<svg width="800" height="300">
<g transform="translate(701, 12)">
<g transform="translate(2.5, 0)" color="#df8f48" class="plot">
<g class="whisker" transform="translate(12,0)">
<path fill="none" stroke="currentColor" opacity="0.5" d="M-12,208 l24,0 m-12,0 L0,199.54999999999998"></path>
<path fill="none" stroke="currentColor" opacity="0.5" d="M-12,166.4 l24,0 m-12,0 L0,176.79999999999998"></path>
</g>
<g class="box" transform="translate(12,0)">
<line stroke="currentColor" stroke-width="24" opacity="0.5" y1="199.54999999999998" y2="189.29999999999998" x1="0" x2="0" width="24"></line>
<line stroke="currentColor" stroke-width="24" opacity="0.5" y1="190.29999999999998" y2="176.79999999999998" x1="0" x2="0" width="24"></line>
</g>
<g class="point" transform="translate(12,0)">
<circle class="point outlier farout" fill="currentColor" stroke="none" opacity="0.5" r="3.674234614174767" cy="13.00000000000001" cx="0"></circle>
</g>
</g>
<g transform="translate(31.5, 0)" color="#d8dee9" class="plot">
<g class="whisker" transform="translate(12,0)">
<path fill="none" stroke="currentColor" opacity="0.5" d="M-12,182 l24,0 m-12,0 L0,180.05"></path>
<path fill="none" stroke="currentColor" opacity="0.5" d="M-12,174.2 l24,0 m-12,0 L0,176.15"></path>
</g>
<g class="box" transform="translate(12,0)">
<line stroke="currentColor" stroke-width="24" opacity="0.5" y1="180.05" y2="177.60000000000002" x1="0" x2="0" width="24"></line>
<line stroke="currentColor" stroke-width="24" opacity="0.5" y1="178.60000000000002" y2="176.15" x1="0" x2="0" width="24"></line>
</g>
<g class="point" transform="translate(12,0)">
</g>
</g>
<g transform="translate(60.5, 0)" color="#62b7a1" class="plot">
<g class="whisker" transform="translate(12,0)">
<path fill="none" stroke="currentColor" opacity="0.5" d="M-12,104 l24,0 m-12,0 L0,84.49999999999999"></path>
<path fill="none" stroke="currentColor" opacity="0.5" d="M-12,25.999999999999993 l24,0 m-12,0 L0,45.500000000000014"></path>
</g>
<g class="box" transform="translate(12,0)">
<line stroke="currentColor" stroke-width="24" opacity="0.5" y1="84.49999999999999" y2="64.5" x1="0" x2="0" width="24"></line>
<line stroke="currentColor" stroke-width="24" opacity="0.5" y1="65.5" y2="45.500000000000014" x1="0" x2="0" width="24"></line>
</g>
<g class="point" transform="translate(12,0)">
</g>
</g>
</g>
<clipPath id="latency-clip-N">
<rect y="-2" height="264" width="657"></rect>
</clipPath>
<g transform="translate(44,12)" clip-path="url(#latency-clip-N)">
<g transform="translate(-5.429752066115703, 0)">
<path class="line" fill="none" stroke="#df8f48" stroke-width="1.5" d="M586.413,208L590.486,196.3L595.915,180.7L601.345,187.2L606.775,193.7L612.205,93.6L617.634,184.6L623.064,191.1L628.494,175.5L633.924,204.1L639.353,188.5L644.783,172.9L650.213,201.5L654.285,189.8"></path>
<path class="line" fill="none" stroke="#d8dee9" stroke-width="1.5" d="M646.14,182L650.213,178.1L654.285,174.2"></path>
<path class="line" fill="none" stroke="#62b7a1" stroke-width="1.5" d="M640.711,104L644.783,80.6L650.213,49.4L654.285,26"></path>
</g>
</g>
<g class="axis" transform="translate(44, 272)" fill="none" font-size="10" font-family="sans-serif" text-anchor="middle">
<path class="domain" stroke="currentColor" d="M0.5,6V0.5H657.5V6"></path>
<g class="tick" opacity="1" transform="translate(68.37190082644628, 0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:15</text>
</g>
<g class="tick" opacity="1" transform="translate(149.8181818181818, 0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:30</text>
</g>
<g class="tick" opacity="1" transform="translate(231.26446280991735, 0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:45</text>
</g>
<g class="tick" opacity="1" transform="translate(312.71074380165294, 0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">22:13</text>
</g>
<g class="tick" opacity="1" transform="translate(394.1570247933884, 0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:15</text>
</g>
<g class="tick" opacity="1" transform="translate(475.603305785124, 0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:30</text>
</g>
<g class="tick" opacity="1" transform="translate(557.0495867768594, 0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:45</text>
</g>
<g class="tick" opacity="1" transform="translate(638.4958677685951, 0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">22:14</text>
</g>
</g>
<g class="axis" transform="translate(44, 12)" fill="none" font-size="10" font-family="sans-serif" text-anchor="end">
<path class="domain" stroke="currentColor" d="M-6,0.5H0.5V260.5H-6"></path>
<g class="tick" opacity="1" transform="translate(0,0.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">100</text>
</g>
<g class="tick" opacity="1" transform="translate(0,52.499999999999986)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">80</text>
</g>
<g class="tick" opacity="1" transform="translate(0,104.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">60</text>
</g>
<g class="tick" opacity="1" transform="translate(0,156.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">40</text>
</g>
<g class="tick" opacity="1" transform="translate(0,208.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">20</text>
</g>
<g class="tick" opacity="1" transform="translate(0,260.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">0</text>
</g>
</g>
</svg>`);
    });

    it('draws the lines and no boxes once the chart is under 600px wide', async () => {
        clients.set([ client('a', 0, samples(NOW, 12, 20, 17)), client('b', 1, samples(NOW, 12, 45, 23)) ]);
        const fixture = await open();
        expect(fixture.componentInstance.boxesHidden()).toBeNull();

        size.width = 500;
        resizeCallbacks[0]();
        await environment.settle(fixture.nativeElement as HTMLElement);
        expect(fixture.componentInstance.boxesHidden()).toBe('narrow');
        expect(markup(fixture)).toBe(`<svg width="500" height="300">
<g transform="translate(488, 12)">
</g>
<clipPath id="latency-clip-N">
<rect y="-2" height="264" width="444"></rect>
</clipPath>
<g transform="translate(44,12)" clip-path="url(#latency-clip-N)">
<g transform="translate(-3.669421487603306, 0)">
<path class="line" fill="none" stroke="#df8f48" stroke-width="1.5" d="M421.983,180L424.736,162L428.405,138L432.074,148L435.744,158L439.413,134L442.165,116"></path>
<path class="line" fill="none" stroke="#c595db" stroke-width="1.5" d="M421.983,80L424.736,42L428.405,22L432.074,48L435.744,28L439.413,54L442.165,16"></path>
</g>
</g>
<g class="axis" transform="translate(44, 272)" fill="none" font-size="10" font-family="sans-serif" text-anchor="middle">
<path class="domain" stroke="currentColor" d="M0.5,6V0.5H444.5V6"></path>
<g class="tick" opacity="1" transform="translate(105.07851239669421, 0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:30</text>
</g>
<g class="tick" opacity="1" transform="translate(215.1611570247934, 0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">22:13</text>
</g>
<g class="tick" opacity="1" transform="translate(325.24380165289256, 0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:30</text>
</g>
<g class="tick" opacity="1" transform="translate(435.3264462809917, 0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">22:14</text>
</g>
</g>
<g class="axis" transform="translate(44, 12)" fill="none" font-size="10" font-family="sans-serif" text-anchor="end">
<path class="domain" stroke="currentColor" d="M-6,0.5H0.5V260.5H-6"></path>
<g class="tick" opacity="1" transform="translate(0,20.499999999999986)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">60</text>
</g>
<g class="tick" opacity="1" transform="translate(0,60.499999999999986)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">50</text>
</g>
<g class="tick" opacity="1" transform="translate(0,100.49999999999999)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">40</text>
</g>
<g class="tick" opacity="1" transform="translate(0,140.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">30</text>
</g>
<g class="tick" opacity="1" transform="translate(0,180.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">20</text>
</g>
<g class="tick" opacity="1" transform="translate(0,220.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">10</text>
</g>
<g class="tick" opacity="1" transform="translate(0,260.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">0</text>
</g>
</g>
</svg>`);
    });

    it('draws only the axes while no client has samples', async () => {
        clients.set([ client('a', 0, []) ]);
        const fixture = await open();
        expect(markup(fixture)).toBe(`<svg width="800" height="300">
<g transform="translate(759, 12)">
</g>
<clipPath id="latency-clip-N">
<rect y="-2" height="264" width="715"></rect>
</clipPath>
<g transform="translate(44,12)" clip-path="url(#latency-clip-N)">
<g transform="translate(-5.909090909090909, 0)">
</g>
</g>
<g class="axis" transform="translate(44, 272)" fill="none" font-size="10" font-family="sans-serif" text-anchor="middle">
<path class="domain" stroke="currentColor" d="M0.5,6V0.5H715.5V6"></path>
<g class="tick" opacity="1" transform="translate(80.27272727272728,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:15</text>
</g>
<g class="tick" opacity="1" transform="translate(168.9090909090909,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:30</text>
</g>
<g class="tick" opacity="1" transform="translate(257.54545454545456,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:45</text>
</g>
<g class="tick" opacity="1" transform="translate(346.1818181818182,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">22:13</text>
</g>
<g class="tick" opacity="1" transform="translate(434.8181818181818,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:15</text>
</g>
<g class="tick" opacity="1" transform="translate(523.4545454545455,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:30</text>
</g>
<g class="tick" opacity="1" transform="translate(612.0909090909091,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:45</text>
</g>
<g class="tick" opacity="1" transform="translate(700.7272727272727,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">22:14</text>
</g>
</g>
<g class="axis" transform="translate(44, 12)" fill="none" font-size="10" font-family="sans-serif" text-anchor="end">
<path class="domain" stroke="currentColor" d="M-6,0.5H0.5V260.5H-6"></path>
<g class="tick" opacity="1" transform="translate(0,0.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">10</text>
</g>
<g class="tick" opacity="1" transform="translate(0,52.499999999999986)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">8</text>
</g>
<g class="tick" opacity="1" transform="translate(0,104.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">6</text>
</g>
<g class="tick" opacity="1" transform="translate(0,156.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">4</text>
</g>
<g class="tick" opacity="1" transform="translate(0,208.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">2</text>
</g>
<g class="tick" opacity="1" transform="translate(0,260.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">0</text>
</g>
</g>
</svg>`);
    });
});
