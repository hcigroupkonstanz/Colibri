import type { WritableSignal } from '@angular/core';
import { signal } from '@angular/core';
import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import type * as d3 from 'd3';
import type { ClientRow, ClientsSnapshot } from '../connection/admin.service';
import type { ColibriClient } from '../connection/client.service';
import { ClientService } from '../connection/client.service';
import type { Sample, StackRow } from './throughput-chart.component';
import { ThroughputChartComponent, addSample, edgeShown, historySamples, latestTotal, stackInput, withHistory } from './throughput-chart.component';
import type { ChartTestEnvironment } from '../../testing/use-chart-test-environment';
import { useChartTestEnvironment } from '../../testing/use-chart-test-environment';

const sample = (at: number, clients: Record<string, { app?: string; in: number | null; out: number | null }>): Sample => ({
    at,
    clients: new Map(Object.entries(clients).map(([ id, rate ]) => [ id, { app: 'demo', color: `#${id}`, ...rate } ]))
});

describe('addSample', () => {
    it('keeps the samples of the last 122 s', () => {
        const samples = [ sample(0, {}), sample(5_000, {}), sample(100_000, {}) ];
        expect(addSample(samples, sample(125_000, {})).map(s => s.at)).toEqual([ 5_000, 100_000, 125_000 ]);
    });
});

describe('the rate history of a first snapshot', () => {
    const row = (id: string, history: [number, number][] | undefined, rates: { in: number | null; out: number | null }): ClientRow => ({
        id, app: 'demo', name: id, transport: 'tcp', version: '2', tls: false, tlsAtProxy: false, address: '10.0.0.5', connectedAt: 0,
        latency: null, limit: null, held: 0, ...rates, ...(history ? { history } : {})
    });
    const snapshot = (clients: ClientRow[]): ClientsSnapshot => ({ request: 1, at: 5_000_000, clients, total: clients.length, adminPages: 1 });

    it('stands for one sample a second before the snapshot, with the clients each second had', () => {
        const samples = historySamples(snapshot([
            row('a', [ [ 1, 10 ], [ 2, 20 ], [ 3, 30 ] ], { in: 4, out: 40 }),
            row('b', [ [ 7, 70 ] ], { in: 8, out: 80 })
        ]), 200_000, id => `#${id}`);

        expect(samples.map(s => [ s.at, Object.fromEntries([ ...s.clients ].map(([ id, rate ]) => [ id, [ rate.in, rate.out, rate.color ] ])) ])).toEqual([
            [ 197_000, { a: [ 1, 10, '#a' ] } ],
            [ 198_000, { a: [ 2, 20, '#a' ] } ],
            [ 199_000, { a: [ 3, 30, '#a' ], b: [ 7, 70, '#b' ] } ]
        ]);
    });

    it('fills the window at once, and the live rates carry on from it, a missing one kept as before', () => {
        const first = snapshot([ row('a', Array.from({ length: 122 }, (_, i) => [ i, 2 * i ]), { in: 122, out: 244 }) ]);
        let samples = addSample(withHistory([], historySamples(first, 200_000, () => '#a')), sample(200_000, { a: { in: 122, out: 244 } }));
        samples = addSample(samples, sample(201_000, { a: { in: null, out: null } }));

        const { rows } = stackInput(samples, 'in', '');
        // the oldest dropped as the chart moved on a second
        expect(rows[0]).toEqual({ at: 79_000, gap: false, values: { a: 1 } });
        expect(rows).toHaveLength(123);
        expect(rows.some(r => r.gap)).toBe(false);
        expect(rows.slice(-3).map(r => r.values['a'])).toEqual([ 121, 122, 122 ]);
    });

    it('takes the place of the samples it covers, after a reconnect, and keeps those before it', () => {
        const before = [ sample(1_000, {}), sample(2_000, {}), sample(3_000, {}) ];
        const history = [ sample(2_500, {}), sample(3_500, {}) ];
        expect(withHistory(before, history).map(s => s.at)).toEqual([ 1_000, 2_000, 2_500, 3_500 ]);
        expect(withHistory(before, []).map(s => s.at)).toEqual([ 1_000, 2_000, 3_000 ]);
    });
});

describe('stackInput', () => {
    it('stacks the clients of one app in the order they first appear, 0 for a client not there', () => {
        const { rows, series } = stackInput([
            sample(1_000, { a: { in: 30, out: 60 }, x: { app: 'other', in: 900, out: 900 } }),
            sample(2_000, { a: { in: 31, out: 62 }, b: { in: 5, out: 7 } }),
            sample(3_000, { b: { in: 6, out: 8 } })
        ], 'in', 'demo');

        expect(series).toEqual([ { id: 'a', color: '#a' }, { id: 'b', color: '#b' } ]);
        expect(rows.map(row => row.values)).toEqual([ { a: 30 }, { a: 31, b: 5 }, { b: 6 } ]);
    });

    it('counts the messages sent to the clients for Out, and every app without a filter', () => {
        const { rows } = stackInput([ sample(1_000, { a: { in: 30, out: 60 }, x: { app: 'other', in: 1, out: 2 } }) ], 'out', '');
        expect(rows[0].values).toEqual({ a: 60, x: 2 });
    });

    it('keeps a client\'s last rate through a second the server had none, and 0 before its first', () => {
        const { rows } = stackInput([
            sample(1_000, { a: { in: null, out: null } }),
            sample(2_000, { a: { in: 20, out: 40 } }),
            sample(3_000, { a: { in: null, out: null } })
        ], 'in', '');
        expect(rows.map(row => row.values['a'])).toEqual([ 0, 20, 20 ]);
    });

    it('breaks the areas where the snapshots paused', () => {
        const { rows } = stackInput([ sample(1_000, { a: { in: 1, out: 1 } }), sample(2_000, { a: { in: 1, out: 1 } }), sample(9_000, { a: { in: 1, out: 1 } }) ], 'in', '');
        expect(rows.map(row => [ row.at, row.gap ])).toEqual([ [ 1_000, false ], [ 2_000, false ], [ 5_500, true ], [ 9_000, false ] ]);
    });
});

describe('stackInput colours', () => {
    it('gives a client its newest colour, in the place it first had', () => {
        const recolour = (at: number, colors: Record<string, string>): Sample => ({
            at, clients: new Map(Object.entries(colors).map(([ id, color ]) => [ id, { app: 'demo', color, in: 1, out: 1 } ]))
        });
        const { series } = stackInput([ recolour(1_000, { a: 'red', b: 'blue' }), recolour(2_000, { a: 'blue', b: 'red' }) ], 'in', '');
        expect(series).toEqual([ { id: 'a', color: 'blue' }, { id: 'b', color: 'red' } ]);
    });
});

describe('latestTotal', () => {
    it('sums the newest row, with the rates carried forward', () => {
        const { rows } = stackInput([ sample(1_000, { a: { in: 30, out: 1 }, b: { in: 12, out: 1 } }), sample(2_000, { a: { in: null, out: null }, b: { in: 10, out: 1 } }) ], 'in', '');
        expect(latestTotal(rows)).toBe(40);
        expect(latestTotal([])).toBeNull();
    });
});

describe('edgeShown', () => {
    const layer = (heights: number[], gapAt = -1) => heights.map((h, i) => Object.assign([ 5, 5 + h ], { data: { at: i, gap: i === gapAt, values: {} } })) as unknown as d3.Series<StackRow, string>;

    it('draws a layer\'s edge where it has height and one point either side, so a client joins and leaves', () => {
        expect(edgeShown(layer([ 0, 0, 0, 4, 4, 0, 0, 0 ]))).toEqual([ false, false, true, true, true, true, false, false ]);
    });

    it('draws no edge for a client sending nothing, or across a pause', () => {
        expect(edgeShown(layer([ 0, 0, 0 ]))).toEqual([ false, false, false ]);
        expect(edgeShown(layer([ 3, 3, 0, 3 ], 2))).toEqual([ true, true, false, true ]);
    });
});

describe('ThroughputChartComponent', () => {
    // 22:14:02.5 UTC: the time axis has ticks at 22:13 and 22:14, and every 15 s between.
    const NOW = 1_700_000_042_500;

    let environment: ChartTestEnvironment;
    let wall: number;
    let clients: WritableSignal<ReadonlyArray<ColibriClient>>;
    let resizeCallbacks: (() => void)[];
    let secondTimer: (() => void) | undefined;

    const connected = (id: string, slot: number): ColibriClient => ({ id, app: 'demo', name: id, version: '2', latency: [], slot });

    const row = (id: string, rates: { in: number | null; out: number | null }, history?: [number, number][], app = 'demo'): ClientRow => ({
        id, app, name: id, transport: 'tcp', version: '2', tls: false, tlsAtProxy: false, address: '10.0.0.5', connectedAt: 0,
        latency: null, limit: null, held: 0, ...rates, ...(history ? { history } : {})
    });

    const snapshot = (rows: ClientRow[]): ClientsSnapshot => ({ request: 1, at: 5_000_000, clients: rows, total: rows.length, adminPages: 1 });

    const markup = (fixture: ComponentFixture<ThroughputChartComponent>): string =>
        (fixture.nativeElement as HTMLElement).querySelector('svg')!.outerHTML
            .replace(/<(?!\/(?:path|line|rect|text)>)/g, '\n<').slice(1)
            // the id counts the charts made before
            .replace(/throughput-clip-\d+/g, 'throughput-clip-N');

    const open = async (first: ClientsSnapshot | null): Promise<ComponentFixture<ThroughputChartComponent>> => {
        const fixture = TestBed.createComponent(ThroughputChartComponent);
        fixture.componentRef.setInput('snapshot', first);
        fixture.detectChanges();
        TestBed.flushEffects();
        await environment.settle(fixture.nativeElement);
        return fixture;
    };

    // The snapshot of the page, `after` ms later.
    const receive = (fixture: ComponentFixture<ThroughputChartComponent>, after: number, rows: ClientRow[]) => {
        wall += after;
        fixture.componentRef.setInput('snapshot', snapshot(rows));
        fixture.detectChanges();
    };

    // The interval of ngAfterViewInit: the chart slides and redraws.
    const slide = async (fixture: ComponentFixture<ThroughputChartComponent>) => {
        secondTimer!();
        await environment.settle(fixture.nativeElement);
    };

    beforeEach(() => {
        environment = useChartTestEnvironment();
        wall = NOW;
        resizeCallbacks = [];
        secondTimer = undefined;
        clients = signal<ReadonlyArray<ColibriClient>>([ connected('a', 0), connected('b', 1), connected('x', 2) ]);

        vi.spyOn(Date, 'now').mockImplementation(() => wall);
        vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(800);
        vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(300);
        // The chart's own 1 s timer is held back; d3's and jsdom's frame timers must run.
        const setInterval = window.setInterval;
        vi.spyOn(window, 'setInterval').mockImplementation(((handler: () => void, delay?: number) => {
            if (delay === 1000 && !secondTimer) {
                secondTimer = handler;
                return 0;
            }
            return setInterval.call(window, handler, delay);
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

    it('stacks an area and an edge for each client, then the clients that come, pause and leave', async () => {
        const fixture = await open(snapshot([
            row('a', { in: 420, out: 90 }, [ [ 400, 80 ], [ 450, 85 ], [ 700, 95 ], [ 640, 70 ] ]),
            row('b', { in: 260, out: 40 }, [ [ 300, 30 ], [ 280, 45 ], [ 350, 60 ], [ 500, 55 ] ])
        ]));
        expect(secondTimer).toBeDefined();
        expect(fixture.componentInstance.total()).toBe(680);
        expect(markup(fixture)).toBe(`<svg width="800" height="300">
<clipPath id="throughput-clip-N">
<rect y="-2" width="744" height="262"></rect>
</clipPath>
<g transform="translate(44,12)" clip-path="url(#throughput-clip-N)">
<g transform="translate(-6.148760330578512, 0)">
<g class="layer">
<path class="area" fill-opacity="0.35" style="fill: #df8f48;" d="M719.405,173.333L725.554,162.5L731.702,108.333L737.851,121.333L744,169L744,260L737.851,260L731.702,260L725.554,260L719.405,260Z"></path>
<path class="edge" fill="none" stroke-width="1.5" style="stroke: #df8f48;" d="M719.405,173.333L725.554,162.5L731.702,108.333L737.851,121.333L744,169"></path>
</g>
<g class="layer">
<path class="area" fill-opacity="0.35" style="fill: #c595db;" d="M719.405,108.333L725.554,101.833L731.702,32.5L737.851,13L744,112.667L744,169L737.851,121.333L731.702,108.333L725.554,162.5L719.405,173.333Z"></path>
<path class="edge" fill="none" stroke-width="1.5" style="stroke: #c595db;" d="M719.405,108.333L725.554,101.833L731.702,32.5L737.851,13L744,112.667"></path>
</g>
</g>
</g>
<g class="axis" transform="translate(44, 272)" fill="none" font-size="10" font-family="sans-serif" text-anchor="middle">
<path class="domain" stroke="currentColor" d="M0.5,6V0.5H744.5V6"></path>
<g class="tick" opacity="1" transform="translate(83.50826446280992,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:15</text>
</g>
<g class="tick" opacity="1" transform="translate(175.7396694214876,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:30</text>
</g>
<g class="tick" opacity="1" transform="translate(267.9710743801653,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:45</text>
</g>
<g class="tick" opacity="1" transform="translate(360.202479338843,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">22:13</text>
</g>
<g class="tick" opacity="1" transform="translate(452.43388429752065,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:15</text>
</g>
<g class="tick" opacity="1" transform="translate(544.6652892561983,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:30</text>
</g>
<g class="tick" opacity="1" transform="translate(636.8966942148761,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:45</text>
</g>
<g class="tick" opacity="1" transform="translate(729.1280991735537,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">22:14</text>
</g>
</g>
<g class="axis" transform="translate(44, 12)" fill="none" font-size="10" font-family="sans-serif" text-anchor="end">
<path class="domain" stroke="currentColor" d="M-6,0.5H0.5V260.5H-6"></path>
<g class="tick" opacity="1" transform="translate(0,0.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">1.2k</text>
</g>
<g class="tick" opacity="1" transform="translate(0,43.83333333333332)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">1k</text>
</g>
<g class="tick" opacity="1" transform="translate(0,87.16666666666667)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">800</text>
</g>
<g class="tick" opacity="1" transform="translate(0,130.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">600</text>
</g>
<g class="tick" opacity="1" transform="translate(0,173.83333333333334)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">400</text>
</g>
<g class="tick" opacity="1" transform="translate(0,217.16666666666669)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">200</text>
</g>
<g class="tick" opacity="1" transform="translate(0,260.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">0</text>
</g>
</g>
</svg>`);

        // c joins, a client the page does not list, so it has no slot colour
        receive(fixture, 1000, [ row('a', { in: 430, out: 91 }), row('b', { in: 255, out: 41 }), row('c', { in: 90, out: 5 }) ]);
        expect(fixture.componentInstance.total()).toBe(775);
        expect(markup(fixture)).toBe(`<svg width="800" height="300">
<clipPath id="throughput-clip-N">
<rect y="-2" width="744" height="262"></rect>
</clipPath>
<g transform="translate(44,12)" clip-path="url(#throughput-clip-N)">
<g transform="translate(-6.148760330578512, 0)">
<g class="layer">
<path class="area" fill-opacity="0.35" style="fill: #df8f48;" d="M719.405,173.333L725.554,162.5L731.702,108.333L737.851,121.333L744,169L750.149,166.833L750.149,260L744,260L737.851,260L731.702,260L725.554,260L719.405,260Z"></path>
<path class="edge" fill="none" stroke-width="1.5" style="stroke: #df8f48;" d="M719.405,173.333L725.554,162.5L731.702,108.333L737.851,121.333L744,169L750.149,166.833"></path>
</g>
<g class="layer">
<path class="area" fill-opacity="0.35" style="fill: #c595db;" d="M719.405,108.333L725.554,101.833L731.702,32.5L737.851,13L744,112.667L750.149,111.583L750.149,166.833L744,169L737.851,121.333L731.702,108.333L725.554,162.5L719.405,173.333Z"></path>
<path class="edge" fill="none" stroke-width="1.5" style="stroke: #c595db;" d="M719.405,108.333L725.554,101.833L731.702,32.5L737.851,13L744,112.667L750.149,111.583"></path>
</g>
<g class="layer">
<path class="area" fill-opacity="0.35" style="fill: var(--text-muted);" d="M719.405,108.333L725.554,101.833L731.702,32.5L737.851,13L744,112.667L750.149,92.083L750.149,111.583L744,112.667L737.851,13L731.702,32.5L725.554,101.833L719.405,108.333Z"></path>
<path class="edge" fill="none" stroke-width="1.5" style="stroke: var(--text-muted);" d="M744,112.667L750.149,92.083"></path>
</g>
</g>
</g>
<g class="axis" transform="translate(44, 272)" fill="none" font-size="10" font-family="sans-serif" text-anchor="middle">
<path class="domain" stroke="currentColor" d="M0.5,6V0.5H744.5V6"></path>
<g class="tick" opacity="1" transform="translate(83.50826446280992,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:15</text>
</g>
<g class="tick" opacity="1" transform="translate(175.7396694214876,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:30</text>
</g>
<g class="tick" opacity="1" transform="translate(267.9710743801653,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:45</text>
</g>
<g class="tick" opacity="1" transform="translate(360.202479338843,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">22:13</text>
</g>
<g class="tick" opacity="1" transform="translate(452.43388429752065,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:15</text>
</g>
<g class="tick" opacity="1" transform="translate(544.6652892561983,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:30</text>
</g>
<g class="tick" opacity="1" transform="translate(636.8966942148761,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:45</text>
</g>
<g class="tick" opacity="1" transform="translate(729.1280991735537,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">22:14</text>
</g>
</g>
<g class="axis" transform="translate(44, 12)" fill="none" font-size="10" font-family="sans-serif" text-anchor="end">
<path class="domain" stroke="currentColor" d="M-6,0.5H0.5V260.5H-6"></path>
<g class="tick" opacity="1" transform="translate(0,0.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">1.2k</text>
</g>
<g class="tick" opacity="1" transform="translate(0,43.83333333333332)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">1k</text>
</g>
<g class="tick" opacity="1" transform="translate(0,87.16666666666667)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">800</text>
</g>
<g class="tick" opacity="1" transform="translate(0,130.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">600</text>
</g>
<g class="tick" opacity="1" transform="translate(0,173.83333333333334)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">400</text>
</g>
<g class="tick" opacity="1" transform="translate(0,217.16666666666669)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">200</text>
</g>
<g class="tick" opacity="1" transform="translate(0,260.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">0</text>
</g>
</g>
</svg>`);

        // 4 s without a snapshot breaks the areas, and b is not in the next one
        receive(fixture, 4000, [ row('a', { in: 500, out: 100 }), row('c', { in: 100, out: 6 }) ]);
        await slide(fixture);
        expect(markup(fixture)).toBe(`<svg width="800" height="300">
<clipPath id="throughput-clip-N">
<rect y="-2" width="744" height="262"></rect>
</clipPath>
<g transform="translate(44,12)" clip-path="url(#throughput-clip-N)">
<g transform="translate(-6.148760330578512, 0)">
<g class="layer">
<path class="area" fill-opacity="0.35" style="fill: #df8f48;" d="M688.661,173.333L694.81,162.5L700.959,108.333L707.107,121.333L713.256,169L719.405,166.833L719.405,260L713.256,260L707.107,260L700.959,260L694.81,260L688.661,260ZM744,151.667L744,260Z"></path>
<path class="edge" fill="none" stroke-width="1.5" style="stroke: #df8f48;" d="M688.661,173.333L694.81,162.5L700.959,108.333L707.107,121.333L713.256,169L719.405,166.833M744,151.667Z"></path>
</g>
<g class="layer">
<path class="area" fill-opacity="0.35" style="fill: #c595db;" d="M688.661,108.333L694.81,101.833L700.959,32.5L707.107,13L713.256,112.667L719.405,111.583L719.405,166.833L713.256,169L707.107,121.333L700.959,108.333L694.81,162.5L688.661,173.333ZM744,151.667L744,151.667Z"></path>
<path class="edge" fill="none" stroke-width="1.5" style="stroke: #c595db;" d="M688.661,108.333L694.81,101.833L700.959,32.5L707.107,13L713.256,112.667L719.405,111.583"></path>
</g>
<g class="layer">
<path class="area" fill-opacity="0.35" style="fill: var(--text-muted);" d="M688.661,108.333L694.81,101.833L700.959,32.5L707.107,13L713.256,112.667L719.405,92.083L719.405,111.583L713.256,112.667L707.107,13L700.959,32.5L694.81,101.833L688.661,108.333ZM744,130L744,151.667Z"></path>
<path class="edge" fill="none" stroke-width="1.5" style="stroke: var(--text-muted);" d="M713.256,112.667L719.405,92.083M744,130Z"></path>
</g>
</g>
</g>
<g class="axis" transform="translate(44, 272)" fill="none" font-size="10" font-family="sans-serif" text-anchor="middle">
<path class="domain" stroke="currentColor" d="M0.5,6V0.5H744.5V6"></path>
<g class="tick" opacity="1" transform="translate(52.764462809917354, 0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:15</text>
</g>
<g class="tick" opacity="1" transform="translate(144.99586776859505, 0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:30</text>
</g>
<g class="tick" opacity="1" transform="translate(237.22727272727272, 0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:45</text>
</g>
<g class="tick" opacity="1" transform="translate(329.4586776859504, 0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">22:13</text>
</g>
<g class="tick" opacity="1" transform="translate(421.6900826446281, 0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:15</text>
</g>
<g class="tick" opacity="1" transform="translate(513.9214876033058, 0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:30</text>
</g>
<g class="tick" opacity="1" transform="translate(606.1528925619834, 0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:45</text>
</g>
<g class="tick" opacity="1" transform="translate(698.3842975206611, 0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">22:14</text>
</g>
</g>
<g class="axis" transform="translate(44, 12)" fill="none" font-size="10" font-family="sans-serif" text-anchor="end">
<path class="domain" stroke="currentColor" d="M-6,0.5H0.5V260.5H-6"></path>
<g class="tick" opacity="1" transform="translate(0,0.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">1.2k</text>
</g>
<g class="tick" opacity="1" transform="translate(0,43.83333333333332)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">1k</text>
</g>
<g class="tick" opacity="1" transform="translate(0,87.16666666666667)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">800</text>
</g>
<g class="tick" opacity="1" transform="translate(0,130.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">600</text>
</g>
<g class="tick" opacity="1" transform="translate(0,173.83333333333334)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">400</text>
</g>
<g class="tick" opacity="1" transform="translate(0,217.16666666666669)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">200</text>
</g>
<g class="tick" opacity="1" transform="translate(0,260.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">0</text>
</g>
</g>
</svg>`);

        // two minutes on, b is out of the samples, so its layer goes
        receive(fixture, 118_000, [ row('a', { in: 520, out: 110 }), row('c', { in: 120, out: 7 }) ]);
        receive(fixture, 1000, [ row('a', { in: 530, out: 111 }), row('c', { in: 125, out: 8 }) ]);
        await slide(fixture);
        expect(markup(fixture)).toBe(`<svg width="800" height="300">
<clipPath id="throughput-clip-N">
<rect y="-2" width="744" height="262"></rect>
</clipPath>
<g transform="translate(44,12)" clip-path="url(#throughput-clip-N)">
<g transform="translate(-6.148760330578512, 0)">
<g class="layer">
<path class="area" fill-opacity="0.35" style="fill: #df8f48;" d="M12.298,74.286L12.298,260ZM737.851,66.857L744,63.143L744,260L737.851,260Z"></path>
<path class="edge" fill="none" stroke-width="1.5" style="stroke: #df8f48;" d="M12.298,74.286ZM737.851,66.857L744,63.143"></path>
</g>
<g class="layer">
<path class="area" fill-opacity="0.35" style="fill: var(--text-muted);" d="M12.298,37.143L12.298,74.286ZM737.851,22.286L744,16.714L744,63.143L737.851,66.857Z"></path>
<path class="edge" fill="none" stroke-width="1.5" style="stroke: var(--text-muted);" d="M12.298,37.143ZM737.851,22.286L744,16.714"></path>
</g>
</g>
</g>
<g class="axis" transform="translate(44, 272)" fill="none" font-size="10" font-family="sans-serif" text-anchor="middle">
<path class="domain" stroke="currentColor" d="M0.5,6V0.5H744.5V6"></path>
<g class="tick" opacity="1" transform="translate(58.913223140495866, 0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:15</text>
</g>
<g class="tick" opacity="1" transform="translate(151.14462809917356, 0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:30</text>
</g>
<g class="tick" opacity="1" transform="translate(243.37603305785126, 0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:45</text>
</g>
<g class="tick" opacity="1" transform="translate(335.60743801652893, 0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">22:15</text>
</g>
<g class="tick" opacity="1" transform="translate(427.8388429752066, 0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:15</text>
</g>
<g class="tick" opacity="1" transform="translate(520.0702479338843, 0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:30</text>
</g>
<g class="tick" opacity="1" transform="translate(612.3016528925621, 0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:45</text>
</g>
<g class="tick" opacity="1" transform="translate(704.5330578512396, 0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">22:16</text>
</g>
</g>
<g class="axis" transform="translate(44, 12)" fill="none" font-size="10" font-family="sans-serif" text-anchor="end">
<path class="domain" stroke="currentColor" d="M-6,0.5H0.5V260.5H-6"></path>
<g class="tick" opacity="1" transform="translate(0,0.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">700</text>
</g>
<g class="tick" opacity="1" transform="translate(0,37.64285714285715)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">600</text>
</g>
<g class="tick" opacity="1" transform="translate(0,74.78571428571428)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">500</text>
</g>
<g class="tick" opacity="1" transform="translate(0,111.92857142857143)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">400</text>
</g>
<g class="tick" opacity="1" transform="translate(0,149.07142857142856)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">300</text>
</g>
<g class="tick" opacity="1" transform="translate(0,186.21428571428572)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">200</text>
</g>
<g class="tick" opacity="1" transform="translate(0,223.35714285714286)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">100</text>
</g>
<g class="tick" opacity="1" transform="translate(0,260.5)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">0</text>
</g>
</g>
</svg>`);
    });

    it('stacks what is sent to the clients of one app', async () => {
        clients.set([ connected('a', 0), connected('b', 1) ]);
        const fixture = TestBed.createComponent(ThroughputChartComponent);
        fixture.componentRef.setInput('direction', 'out');
        fixture.componentRef.setInput('app', 'demo');
        fixture.componentRef.setInput('snapshot', snapshot([
            row('a', { in: 420, out: 90 }, [ [ 400, 80 ], [ 450, 85 ] ]),
            row('b', { in: 260, out: 40 }, [ [ 300, 30 ], [ 280, 45 ] ], 'other')
        ]));
        fixture.detectChanges();
        TestBed.flushEffects();
        await environment.settle(fixture.nativeElement);
        expect(fixture.componentInstance.total()).toBe(90);
        expect(markup(fixture)).toBe(`<svg width="800" height="300">
<clipPath id="throughput-clip-N">
<rect y="-2" width="744" height="262"></rect>
</clipPath>
<g transform="translate(44,12)" clip-path="url(#throughput-clip-N)">
<g transform="translate(-6.148760330578512, 0)">
<g class="layer">
<path class="area" fill-opacity="0.35" style="fill: #df8f48;" d="M731.702,28.889L737.851,14.444L744,0L744,260L737.851,260L731.702,260Z"></path>
<path class="edge" fill="none" stroke-width="1.5" style="stroke: #df8f48;" d="M731.702,28.889L737.851,14.444L744,0"></path>
</g>
</g>
</g>
<g class="axis" transform="translate(44, 272)" fill="none" font-size="10" font-family="sans-serif" text-anchor="middle">
<path class="domain" stroke="currentColor" d="M0.5,6V0.5H744.5V6"></path>
<g class="tick" opacity="1" transform="translate(83.50826446280992,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:15</text>
</g>
<g class="tick" opacity="1" transform="translate(175.7396694214876,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:30</text>
</g>
<g class="tick" opacity="1" transform="translate(267.9710743801653,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:45</text>
</g>
<g class="tick" opacity="1" transform="translate(360.202479338843,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">22:13</text>
</g>
<g class="tick" opacity="1" transform="translate(452.43388429752065,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:15</text>
</g>
<g class="tick" opacity="1" transform="translate(544.6652892561983,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:30</text>
</g>
<g class="tick" opacity="1" transform="translate(636.8966942148761,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:45</text>
</g>
<g class="tick" opacity="1" transform="translate(729.1280991735537,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">22:14</text>
</g>
</g>
<g class="axis" transform="translate(44, 12)" fill="none" font-size="10" font-family="sans-serif" text-anchor="end">
<path class="domain" stroke="currentColor" d="M-6,0.5H0.5V260.5H-6"></path>
<g class="tick" opacity="1" transform="translate(0,29.3888888888889)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">80</text>
</g>
<g class="tick" opacity="1" transform="translate(0,87.16666666666667)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">60</text>
</g>
<g class="tick" opacity="1" transform="translate(0,144.94444444444446)">
<line stroke="currentColor" x2="-6"></line>
<text fill="currentColor" x="-9" dy="0.32em">40</text>
</g>
<g class="tick" opacity="1" transform="translate(0,202.72222222222223)">
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

    it('draws only the axes before the first snapshot', async () => {
        const fixture = await open(null);
        expect(markup(fixture)).toBe(`<svg width="800" height="300">
<clipPath id="throughput-clip-N">
<rect y="-2" width="744" height="262"></rect>
</clipPath>
<g transform="translate(44,12)" clip-path="url(#throughput-clip-N)">
<g transform="translate(-6.148760330578512, 0)">
</g>
</g>
<g class="axis" transform="translate(44, 272)" fill="none" font-size="10" font-family="sans-serif" text-anchor="middle">
<path class="domain" stroke="currentColor" d="M0.5,6V0.5H744.5V6"></path>
<g class="tick" opacity="1" transform="translate(83.50826446280992,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:15</text>
</g>
<g class="tick" opacity="1" transform="translate(175.7396694214876,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:30</text>
</g>
<g class="tick" opacity="1" transform="translate(267.9710743801653,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:45</text>
</g>
<g class="tick" opacity="1" transform="translate(360.202479338843,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">22:13</text>
</g>
<g class="tick" opacity="1" transform="translate(452.43388429752065,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:15</text>
</g>
<g class="tick" opacity="1" transform="translate(544.6652892561983,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:30</text>
</g>
<g class="tick" opacity="1" transform="translate(636.8966942148761,0)">
<line stroke="currentColor" y2="6"></line>
<text fill="currentColor" y="9" dy="0.71em">:45</text>
</g>
<g class="tick" opacity="1" transform="translate(729.1280991735537,0)">
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
