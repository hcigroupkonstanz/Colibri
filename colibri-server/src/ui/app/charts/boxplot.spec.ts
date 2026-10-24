import * as d3 from 'd3';
import type { BoxplotStats } from './boxplot';
import { boxplot, boxplotStats, boxplotSymbolDot, boxplotSymbolTick } from './boxplot';
import type { ChartTestEnvironment } from '../../testing/use-chart-test-environment';
import { useChartTestEnvironment } from '../../testing/use-chart-test-environment';

type Svg = d3.Selection<SVGSVGElement, undefined, null, undefined>;
type Plot = BoxplotStats & { id: string };

// One element a line, so a failing test shows which one changed. Only the end tags of elements with
// no children stay on their line.
const markup = (svg: Svg): string => svg.node()!.outerHTML.replace(/<(?!\/(?:path|line|circle)>)/g, '\n<').slice(1);

describe('boxplotStats', () => {
    it('gives the five numbers, the fences, the boxes and whiskers, and flags the outliers', () => {
        const point = (value: number, outlier = false, farout = false) => ({ value, datum: value, outlier, farout });

        expect(boxplotStats([ 12, 14, 15, 15, 16, 18, 19, 22, 32, 60 ])).toEqual({
            fiveNums: [ 12, 15, 17, 21.25, 60 ],
            iqr: 6.25,
            step: 9.375,
            fences: [ { start: -3.75, end: 5.625 }, { start: 5.625, end: 15 }, { start: 15, end: 21.25 }, { start: 21.25, end: 30.625 }, { start: 30.625, end: 40 } ],
            boxes: [ { start: 15, end: 17 }, { start: 17, end: 21.25 } ],
            whiskers: [ { start: 12, end: 15 }, { start: 22, end: 21.25 } ],
            points: [ point(12), point(14), point(15), point(15), point(16), point(18), point(19), point(22), point(32, true), point(60, true, true) ]
        });
    });
});

describe('boxplot', () => {
    let environment: ChartTestEnvironment;

    beforeEach(() => {
        environment = useChartTestEnvironment();
    });

    afterEach(() => {
        environment.restore();
    });

    describe('as the latency chart draws it', () => {
        const plotHeight = 260;
        const band = 29;
        const boxWidth = band - 5;

        // The calls of LatencyChartComponent.updateChart: a scale for the largest sample, one g.plot a
        // client, vertical, without the inner dots.
        const draw = (svg: Svg, latencies: Record<string, number[]>) => {
            const ids = Object.keys(latencies);
            const xScale = d3.scalePoint().domain(ids).range([ 0, ids.length * band ]).padding(0.5);
            const maxLatency = d3.max(Object.values(latencies).flat()) || 1;
            const yScale = d3.scaleLinear().domain([ Math.max(maxLatency, 10), 0 ]).range([ 0, plotHeight ]).nice();
            const plots: Plot[] = ids.map(id => ({ ...boxplotStats(latencies[id]), id }));

            const render = boxplot({ vertical: true, scale: yScale, bandwidth: boxWidth, boxwidth: boxWidth, showInnerDots: false, symbol: boxplotSymbolDot, opacity: 0.5, jitter: 0.5 });
            svg.selectAll<SVGGElement, Plot>('g.plot')
                .data(plots, d => d.id)
                .join('g')
                .attr('transform', d => `translate(${(xScale(d.id) || 0) - boxWidth / 2}, 0)`)
                .attr('class', 'plot')
                .each(function () {
                    d3.select(this).call(render);
                });
        };

        it('draws a whisker, two boxes and the outliers of each client, then redraws them for new samples', () => {
            const svg = d3.create('svg');
            draw(svg, {
                a: [ 12, 14, 15, 15, 16, 18, 19, 22, 32, 60 ],
                b: [ 30, 31, 31, 32, 33, 34, 36, 38, 90 ],
                c: [ 10, 10, 10, 10 ]
            });
            expect(markup(svg)).toBe(`<svg>
<g transform="translate(2.5, 0)" class="plot">
<g class="whisker" transform="translate(12,0)">
<path fill="none" stroke="currentColor" opacity="0.5" d="M-12,225.33333333333334 l24,0 m-12,0 L0,216.66666666666669"></path>
<path fill="none" stroke="currentColor" opacity="0.5" d="M-12,196.44444444444443 l24,0 m-12,0 L0,198.6111111111111"></path>
</g>
<g class="box" transform="translate(12,0)">
<line stroke="currentColor" stroke-width="24" opacity="0.5" y1="216.66666666666669" y2="210.38888888888889" x1="0" x2="0" width="24"></line>
<line stroke="currentColor" stroke-width="24" opacity="0.5" y1="211.38888888888889" y2="198.6111111111111" x1="0" x2="0" width="24"></line>
</g>
<g class="point" transform="translate(12,0)">
<circle class="point outlier" fill="currentColor" stroke="none" opacity="0.5" r="2.449489742783178" cy="167.55555555555554" cx="-2.73114474324012"></circle>
<circle class="point outlier farout" fill="currentColor" stroke="none" opacity="0.5" r="3.674234614174767" cy="86.66666666666667" cx="0"></circle>
</g>
</g>
<g transform="translate(31.5, 0)" class="plot">
<g class="whisker" transform="translate(12,0)">
<path fill="none" stroke="currentColor" opacity="0.5" d="M-12,173.33333333333334 l24,0 m-12,0 L0,170.44444444444446"></path>
<path fill="none" stroke="currentColor" opacity="0.5" d="M-12,150.2222222222222 l24,0 m-12,0 L0,156"></path>
</g>
<g class="box" transform="translate(12,0)">
<line stroke="currentColor" stroke-width="24" opacity="0.5" y1="170.44444444444446" y2="164.16666666666666" x1="0" x2="0" width="24"></line>
<line stroke="currentColor" stroke-width="24" opacity="0.5" y1="165.16666666666666" y2="156" x1="0" x2="0" width="24"></line>
</g>
<g class="point" transform="translate(12,0)">
<circle class="point outlier farout" fill="currentColor" stroke="none" opacity="0.5" r="3.674234614174767" cy="0" cx="0"></circle>
</g>
</g>
<g transform="translate(60.5, 0)" class="plot">
<g class="whisker" transform="translate(12,0)">
<path fill="none" stroke="currentColor" opacity="0.5" d="M-12,231.1111111111111 l24,0 m-12,0 L0,231.1111111111111"></path>
<path fill="none" stroke="currentColor" opacity="0.5" d="M-12,231.1111111111111 l24,0 m-12,0 L0,231.1111111111111"></path>
</g>
<g class="box" transform="translate(12,0)">
<line stroke="currentColor" stroke-width="24" opacity="0.5" y1="231.1111111111111" y2="230.6111111111111" x1="0" x2="0" width="24"></line>
<line stroke="currentColor" stroke-width="24" opacity="0.5" y1="231.6111111111111" y2="231.1111111111111" x1="0" x2="0" width="24"></line>
</g>
<g class="point" transform="translate(12,0)">
</g>
</g>
</svg>`);

            draw(svg, {
                a: [ 12, 14, 15, 15, 16, 18, 19, 22 ],
                b: [ 30, 31, 31, 32, 33, 34, 36, 38, 90, 120 ],
                d: [ 5, 7, 9 ]
            });
            expect(markup(svg)).toBe(`<svg>
<g transform="translate(2.5, 0)" class="plot">
<g class="whisker" transform="translate(12,0)">
<path fill="none" stroke="currentColor" opacity="0.5" d="M-12,234 l24,0 m-12,0 L0,228.04166666666666"></path>
<path fill="none" stroke="currentColor" opacity="0.5" d="M-12,212.33333333333334 l24,0 m-12,0 L0,220.45833333333334"></path>
</g>
<g class="box" transform="translate(12,0)">
<line stroke="currentColor" stroke-width="24" opacity="0.5" y1="228.04166666666666" y2="225.91666666666666" x1="0" x2="0" width="24"></line>
<line stroke="currentColor" stroke-width="24" opacity="0.5" y1="226.91666666666666" y2="220.45833333333334" x1="0" x2="0" width="24"></line>
</g>
<g class="point" transform="translate(12,0)">
</g>
</g>
<g transform="translate(31.5, 0)" class="plot">
<g class="whisker" transform="translate(12,0)">
<path fill="none" stroke="currentColor" opacity="0.5" d="M-12,195 l24,0 m-12,0 L0,192.29166666666666"></path>
<path fill="none" stroke="currentColor" opacity="0.5" d="M-12,177.66666666666666 l24,0 m-12,0 L0,178.75"></path>
</g>
<g class="box" transform="translate(12,0)">
<line stroke="currentColor" stroke-width="24" opacity="0.5" y1="192.29166666666666" y2="186.91666666666666" x1="0" x2="0" width="24"></line>
<line stroke="currentColor" stroke-width="24" opacity="0.5" y1="187.91666666666666" y2="178.75" x1="0" x2="0" width="24"></line>
</g>
<g class="point" transform="translate(12,0)">
<circle class="point outlier farout" fill="currentColor" stroke="none" opacity="0.5" r="3.674234614174767" cy="65" cx="0"></circle>
<circle class="point outlier farout" fill="currentColor" stroke="none" opacity="0.5" r="3.674234614174767" cy="0" cx="0"></circle>
</g>
</g>
<g transform="translate(60.5, 0)" class="plot">
<g class="whisker" transform="translate(12,0)">
<path fill="none" stroke="currentColor" opacity="0.5" d="M-12,249.16666666666669 l24,0 m-12,0 L0,247"></path>
<path fill="none" stroke="currentColor" opacity="0.5" d="M-12,240.5 l24,0 m-12,0 L0,242.66666666666666"></path>
</g>
<g class="box" transform="translate(12,0)">
<line stroke="currentColor" stroke-width="24" opacity="0.5" y1="247" y2="244.33333333333334" x1="0" x2="0" width="24"></line>
<line stroke="currentColor" stroke-width="24" opacity="0.5" y1="245.33333333333334" y2="242.66666666666666" x1="0" x2="0" width="24"></line>
</g>
<g class="point" transform="translate(12,0)">
</g>
</g>
</svg>`);
        });
    });

    describe('with other options', () => {
        const stats = boxplotStats([ 12, 14, 15, 15, 16, 18, 19, 22, 32, 60 ]);
        const changed = boxplotStats([ 20, 22, 25, 25, 26, 28, 29, 32, 41, 90 ]);
        const scale = () => d3.scaleLinear().domain([ 0, 100 ]).range([ 0, 300 ]);

        const group = (svg: Svg) => svg.append('g').datum(stats);

        it('draws horizontally, all points as dots, by default', () => {
            const svg = d3.create('svg');
            group(svg).call(boxplot({ scale: scale() }));
            expect(markup(svg)).toBe(`<svg>
<g>
<g class="whisker" transform="translate(0,10)">
<path fill="none" stroke="currentColor" opacity="0.8" d="M36,-10 l0,20 m0,-10 L45,0"></path>
<path fill="none" stroke="currentColor" opacity="0.8" d="M66,-10 l0,20 m0,-10 L63.75,0"></path>
</g>
<g class="box" transform="translate(0,10)">
<line stroke="currentColor" stroke-width="20" opacity="0.8" x1="45" x2="50.50000000000001" y1="0" y2="0" height="20"></line>
<line stroke="currentColor" stroke-width="20" opacity="0.8" x1="51.50000000000001" x2="63.75" y1="0" y2="0" height="20"></line>
</g>
<g class="point" transform="translate(0,10)">
<circle class="point" fill="currentColor" stroke="none" opacity="0.8" r="2.23606797749979" cx="36" cy="-0.8320633000930621"></circle>
<circle class="point" fill="currentColor" stroke="none" opacity="0.8" r="2.23606797749979" cx="42.00000000000001" cy="1.0219974284925355"></circle>
<circle class="point" fill="currentColor" stroke="none" opacity="0.8" r="2.23606797749979" cx="45" cy="1.142222702096361"></circle>
<circle class="point" fill="currentColor" stroke="none" opacity="0.8" r="2.23606797749979" cx="45" cy="-1.2001830192859502"></circle>
<circle class="point" fill="currentColor" stroke="none" opacity="0.8" r="2.23606797749979" cx="48" cy="-1.3114286311269403"></circle>
<circle class="point" fill="currentColor" stroke="none" opacity="0.8" r="2.23606797749979" cx="54" cy="1.4655588191028832"></circle>
<circle class="point" fill="currentColor" stroke="none" opacity="0.8" r="2.23606797749979" cx="57" cy="1.5590541279110537"></circle>
<circle class="point" fill="currentColor" stroke="none" opacity="0.8" r="2.23606797749979" cx="66" cy="1.7216983313237153"></circle>
<circle class="point outlier" fill="currentColor" stroke="none" opacity="0.8" r="2.23606797749979" cx="96" cy="-0.9901405464041473"></circle>
<circle class="point outlier farout" fill="currentColor" stroke="none" opacity="0.8" r="3.3541019662496847" cx="180" cy="0"></circle>
</g>
</g>
</svg>`);
        });

        it('draws ticks instead of dots, and redraws them with the new points', () => {
            const svg = d3.create('svg');
            const g = group(svg);
            const render = boxplot({ scale: scale(), symbol: boxplotSymbolTick, jitter: 0 });
            g.call(render);
            expect(markup(svg)).toBe(`<svg>
<g>
<g class="whisker" transform="translate(0,10)">
<path fill="none" stroke="currentColor" opacity="0.8" d="M36,-10 l0,20 m0,-10 L45,0"></path>
<path fill="none" stroke="currentColor" opacity="0.8" d="M66,-10 l0,20 m0,-10 L63.75,0"></path>
</g>
<g class="box" transform="translate(0,10)">
<line stroke="currentColor" stroke-width="20" opacity="0.8" x1="45" x2="50.50000000000001" y1="0" y2="0" height="20"></line>
<line stroke="currentColor" stroke-width="20" opacity="0.8" x1="51.50000000000001" x2="63.75" y1="0" y2="0" height="20"></line>
</g>
<g class="point" transform="translate(0,10)">
<line class="point" stroke="currentColor" opacity="0.8" x1="36" x2="36" y1="-5" y2="5"></line>
<line class="point" stroke="currentColor" opacity="0.8" x1="42.00000000000001" x2="42.00000000000001" y1="-5" y2="5"></line>
<line class="point" stroke="currentColor" opacity="0.8" x1="45" x2="45" y1="-5" y2="5"></line>
<line class="point" stroke="currentColor" opacity="0.8" x1="45" x2="45" y1="-5" y2="5"></line>
<line class="point" stroke="currentColor" opacity="0.8" x1="48" x2="48" y1="-5" y2="5"></line>
<line class="point" stroke="currentColor" opacity="0.8" x1="54" x2="54" y1="-5" y2="5"></line>
<line class="point" stroke="currentColor" opacity="0.8" x1="57" x2="57" y1="-5" y2="5"></line>
<line class="point" stroke="currentColor" opacity="0.8" x1="66" x2="66" y1="-5" y2="5"></line>
<line class="point outlier" stroke="currentColor" opacity="0.8" x1="96" x2="96" y1="-5" y2="5"></line>
<line class="point outlier farout" stroke="currentColor" opacity="0.8" x1="180" x2="180" y1="-5" y2="5"></line>
</g>
</g>
</svg>`);

            g.datum(changed).call(render);
            expect(markup(svg)).toBe(`<svg>
<g>
<g class="whisker" transform="translate(0,10)">
<path fill="none" stroke="currentColor" opacity="0.8" d="M60,-10 l0,20 m0,-10 L75,0"></path>
<path fill="none" stroke="currentColor" opacity="0.8" d="M96,-10 l0,20 m0,-10 L93.75,0"></path>
</g>
<g class="box" transform="translate(0,10)">
<line stroke="currentColor" stroke-width="20" opacity="0.8" x1="75" x2="80.5" y1="0" y2="0" height="20"></line>
<line stroke="currentColor" stroke-width="20" opacity="0.8" x1="81.5" x2="93.75" y1="0" y2="0" height="20"></line>
</g>
<g class="point" transform="translate(0,10)">
<line class="point" stroke="currentColor" opacity="0.8" x1="60" x2="60" y1="-5" y2="5"></line>
<line class="point" stroke="currentColor" opacity="0.8" x1="66" x2="66" y1="-5" y2="5"></line>
<line class="point" stroke="currentColor" opacity="0.8" x1="75" x2="75" y1="-5" y2="5"></line>
<line class="point" stroke="currentColor" opacity="0.8" x1="75" x2="75" y1="-5" y2="5"></line>
<line class="point" stroke="currentColor" opacity="0.8" x1="78" x2="78" y1="-5" y2="5"></line>
<line class="point" stroke="currentColor" opacity="0.8" x1="84.00000000000001" x2="84.00000000000001" y1="-5" y2="5"></line>
<line class="point" stroke="currentColor" opacity="0.8" x1="87" x2="87" y1="-5" y2="5"></line>
<line class="point" stroke="currentColor" opacity="0.8" x1="96" x2="96" y1="-5" y2="5"></line>
<line class="point outlier" stroke="currentColor" opacity="0.8" x1="122.99999999999999" x2="122.99999999999999" y1="-5" y2="5"></line>
<line class="point outlier farout" stroke="currentColor" opacity="0.8" x1="270" x2="270" y1="-5" y2="5"></line>
</g>
</g>
</svg>`);
        });

        it('draws dots without jitter, and on a scale that runs backwards', () => {
            const svg = d3.create('svg');
            const backwards = d3.scaleLinear().domain([ 0, 100 ]).range([ 260, 0 ]);
            group(svg).call(boxplot({ vertical: true, scale: backwards, bandwidth: 24, boxwidth: 24, opacity: 0.5, jitter: 0 }));
            expect(markup(svg)).toBe(`<svg>
<g>
<g class="whisker" transform="translate(12,0)">
<path fill="none" stroke="currentColor" opacity="0.5" d="M-12,228.8 l24,0 m-12,0 L0,221"></path>
<path fill="none" stroke="currentColor" opacity="0.5" d="M-12,202.8 l24,0 m-12,0 L0,204.75"></path>
</g>
<g class="box" transform="translate(12,0)">
<line stroke="currentColor" stroke-width="24" opacity="0.5" y1="221" y2="216.29999999999998" x1="0" x2="0" width="24"></line>
<line stroke="currentColor" stroke-width="24" opacity="0.5" y1="215.29999999999998" y2="204.75" x1="0" x2="0" width="24"></line>
</g>
<g class="point" transform="translate(12,0)">
<circle class="point" fill="currentColor" stroke="none" opacity="0.5" r="2.449489742783178" cy="228.8" cx="0"></circle>
<circle class="point" fill="currentColor" stroke="none" opacity="0.5" r="2.449489742783178" cy="223.6" cx="0"></circle>
<circle class="point" fill="currentColor" stroke="none" opacity="0.5" r="2.449489742783178" cy="221" cx="0"></circle>
<circle class="point" fill="currentColor" stroke="none" opacity="0.5" r="2.449489742783178" cy="221" cx="0"></circle>
<circle class="point" fill="currentColor" stroke="none" opacity="0.5" r="2.449489742783178" cy="218.4" cx="0"></circle>
<circle class="point" fill="currentColor" stroke="none" opacity="0.5" r="2.449489742783178" cy="213.20000000000002" cx="0"></circle>
<circle class="point" fill="currentColor" stroke="none" opacity="0.5" r="2.449489742783178" cy="210.60000000000002" cx="0"></circle>
<circle class="point" fill="currentColor" stroke="none" opacity="0.5" r="2.449489742783178" cy="202.8" cx="0"></circle>
<circle class="point outlier" fill="currentColor" stroke="none" opacity="0.5" r="2.449489742783178" cy="176.79999999999998" cx="0"></circle>
<circle class="point outlier farout" fill="currentColor" stroke="none" opacity="0.5" r="3.674234614174767" cy="104" cx="0"></circle>
</g>
</g>
</svg>`);
        });

        it('moves to the new points over a transition', async () => {
            const svg = d3.create('svg');
            const render = boxplot({ scale: scale() });
            const g = group(svg);
            g.transition().duration(1000).call(render);
            await environment.settle(svg.node()!);
            expect(markup(svg)).toBe(`<svg>
<g>
<g class="whisker" transform="translate(0,10)">
<path fill="none" stroke="currentColor" opacity="0.8" d="M36,-10 l0,20 m0,-10 L45,0"></path>
<path fill="none" stroke="currentColor" opacity="0.8" d="M66,-10 l0,20 m0,-10 L63.75,0"></path>
</g>
<g class="box" transform="translate(0,10)">
<line stroke="currentColor" stroke-width="20" opacity="0.8" x1="45" x2="50.50000000000001" y1="0" y2="0" height="20"></line>
<line stroke="currentColor" stroke-width="20" opacity="0.8" x1="51.50000000000001" x2="63.75" y1="0" y2="0" height="20"></line>
</g>
<g class="point" transform="translate(0,10)">
<circle class="point" fill="currentColor" stroke="none" opacity="0.8" r="2.23606797749979" cx="36" cy="-0.8320633000930621"></circle>
<circle class="point" fill="currentColor" stroke="none" opacity="0.8" r="2.23606797749979" cx="42.00000000000001" cy="1.0219974284925355"></circle>
<circle class="point" fill="currentColor" stroke="none" opacity="0.8" r="2.23606797749979" cx="45" cy="1.142222702096361"></circle>
<circle class="point" fill="currentColor" stroke="none" opacity="0.8" r="2.23606797749979" cx="45" cy="-1.2001830192859502"></circle>
<circle class="point" fill="currentColor" stroke="none" opacity="0.8" r="2.23606797749979" cx="48" cy="-1.3114286311269403"></circle>
<circle class="point" fill="currentColor" stroke="none" opacity="0.8" r="2.23606797749979" cx="54" cy="1.4655588191028832"></circle>
<circle class="point" fill="currentColor" stroke="none" opacity="0.8" r="2.23606797749979" cx="57" cy="1.5590541279110537"></circle>
<circle class="point" fill="currentColor" stroke="none" opacity="0.8" r="2.23606797749979" cx="66" cy="1.7216983313237153"></circle>
<circle class="point outlier" fill="currentColor" stroke="none" opacity="0.8" r="2.23606797749979" cx="96" cy="-0.9901405464041473"></circle>
<circle class="point outlier farout" fill="currentColor" stroke="none" opacity="0.8" r="3.3541019662496847" cx="180" cy="0"></circle>
</g>
</g>
</svg>`);

            g.datum(changed).transition().duration(1000).call(render);
            await environment.settle(svg.node()!);
            expect(markup(svg)).toBe(`<svg>
<g>
<g class="whisker" transform="translate(0,10)">
<path fill="none" stroke="currentColor" opacity="0.8" d="M60,-10 l0,20 m0,-10 L75,0"></path>
<path fill="none" stroke="currentColor" opacity="0.8" d="M96,-10 l0,20 m0,-10 L93.75,0"></path>
</g>
<g class="box" transform="translate(0,10)">
<line stroke="currentColor" stroke-width="20" opacity="0.8" x1="75" x2="80.5" y1="0" y2="0" height="20"></line>
<line stroke="currentColor" stroke-width="20" opacity="0.8" x1="81.5" x2="93.75" y1="0" y2="0" height="20"></line>
</g>
<g class="point" transform="translate(0,10)">
<circle class="point" fill="currentColor" stroke="none" opacity="0.8" r="2.23606797749979" cx="60" cy="-1.3114286311269403"></circle>
<circle class="point" fill="currentColor" stroke="none" opacity="0.8" r="2.23606797749979" cx="66" cy="1.4655588191028832"></circle>
<circle class="point" fill="currentColor" stroke="none" opacity="0.8" r="2.23606797749979" cx="75" cy="1.6445796982164331"></circle>
<circle class="point" fill="currentColor" stroke="none" opacity="0.8" r="2.23606797749979" cx="75" cy="-1.6842155528238862"></circle>
<circle class="point" fill="currentColor" stroke="none" opacity="0.8" r="2.23606797749979" cx="78" cy="-1.756980116289496"></circle>
<circle class="point" fill="currentColor" stroke="none" opacity="0.8" r="2.23606797749979" cx="84.00000000000001" cy="1.8491828837679067"></circle>
<circle class="point" fill="currentColor" stroke="none" opacity="0.8" r="2.23606797749979" cx="87" cy="1.8988971140274868"></circle>
<circle class="point" fill="currentColor" stroke="none" opacity="0.8" r="2.23606797749979" cx="96" cy="1.9690001093173937"></circle>
<circle class="point outlier" fill="currentColor" stroke="none" opacity="0.8" r="2.23606797749979" cx="122.99999999999999" cy="0.9836158758542056"></circle>
<circle class="point outlier farout" fill="currentColor" stroke="none" opacity="0.8" r="3.3541019662496847" cx="270" cy="0"></circle>
</g>
</g>
</svg>`);
        });
    });
});
