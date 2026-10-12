import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, Injector, OnDestroy, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { ClientService, ColibriClient } from '../../services';
import * as d3 from 'd3';
import { BoxplotStats, boxplot, boxplotStats, boxplotSymbolDot } from './boxplot';

const margin = { top: 12, right: 12, bottom: 28, left: 44 };
/** What the Clients page's charts show: the server sends this much of the past when the page opens. */
export const TIME_RANGE_MILLIS = 120 * 1000;
const barWidth = 24;
const boxplotPadding = 5;
// A box narrower than this is not readable; fewer than this many pixels of chart get no boxes.
const minBand = 14;
const minBoxplotChartWidth = 600;

// Nord hues (https://www.nordtheme.com/docs/colors-and-palettes), made lighter or stronger: each at
// 3:1 or more on the card. No red or yellow, which mean errors and warnings. In this order, each
// is easy to tell from the next, and the first four from each other.
const colors = [
    '#df8f48', // orange
    '#c595db', // purple
    '#d8dee9', // snow
    '#62b7a1', // teal
    '#c8c8fb', // lavender
    '#89da9b', // green
    '#67aaed', // blue
    '#90e1ea', // cyan
];

/** The colour of a client's slot (ColibriClient.slot), in the chart and its table. */
export const clientColor = function (slot: number): string {
    return colors[slot % colors.length];
};

/**
 * The time axis at `now`: always the whole TIME_RANGE_MILLIS, and the second it slides left by until
 * the next update. It used to grow with the samples, from 10 s; the server now sends the window's
 * samples when the page opens.
 */
export const timeDomain = function (now: number): [number, number] {
    return [ now - TIME_RANGE_MILLIS - 1000, now ];
};

const timeLabel = function (value: Date | d3.NumberValue): string {
    const date = value instanceof Date ? value : new Date(Number(value));
    return d3.timeFormat(date.getSeconds() === 0 ? '%H:%M' : ':%S')(date);
};

/**
 * The median of each second of a client's samples, at their mean time. The 100 ms samples of a few
 * clients drew a solid band, with each client's colour lost in it.
 */
export const perSecond = function (samples: ReadonlyArray<[number, number]>): [number, number][] {
    const medians: [number, number][] = [];
    for (let i = 0; i < samples.length;) {
        const second = Math.floor(samples[i][0] / 1000);
        const times: number[] = [];
        const values: number[] = [];
        for (; i < samples.length && Math.floor(samples[i][0] / 1000) === second; i++) {
            times.push(samples[i][0]);
            values.push(samples[i][1]);
        }
        medians.push([ d3.mean(times) ?? second * 1000, d3.median(values) ?? 0 ]);
    }
    return medians;
};

/**
 * How wide each client's box is, or why there are none. The boxes take at most 40% of the plot.
 * They used to shrink with every client, to 4px, and on a phone left the lines a third of the
 * screen: below 600px there are none, and where a box each does not fit, none either. The table
 * lists each client's latency.
 */
export const boxLayout = function (chartWidth: number, plotWidth: number, clients: number): { band: number; hidden: 'narrow' | 'count' | null } {
    if (chartWidth < minBoxplotChartWidth) return { band: 0, hidden: 'narrow' };
    const band = Math.min(barWidth + boxplotPadding, (plotWidth * 0.4) / Math.max(1, clients));
    if (band < minBand) return { band: 0, hidden: 'count' };
    return { band, hidden: null };
};

// a clipPath id of its own for each chart on the page
let clipIds = 0;

interface Line {
    client: ColibriClient;
    color: string;
}

@Component({
    selector: 'app-latency-chart',
    templateUrl: './latency-chart.component.html',
    styleUrls: ['./latency-chart.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class LatencyChartComponent implements AfterViewInit, OnDestroy {
    private clientService = inject(ClientService);
    private injector = inject(Injector);

    private latencyChart = viewChild.required<ElementRef<HTMLDivElement>>('latencyChart');

    /** The app whose clients it shows, or '' for all. */
    app = input('');

    clients = computed(() => {
        const app = this.app();
        const clients = this.clientService.clients();
        return app ? clients.filter(client => client.app === app) : clients;
    });

    /** Why the boxes are missing, when there are clients that would have one. */
    boxesHidden = signal<'narrow' | 'count' | null>(null);

    /** What the chart says instead of an empty plot. */
    message = computed(() => {
        const clients = this.clients();
        if (clients.length === 0) return this.app() ? `No clients of ${this.app()} connected.` : 'No clients connected.';
        if (clients.every(client => client.latency.length === 0)) return 'Collecting latency samples…';
        return null;
    });

    private svg: d3.Selection<SVGSVGElement, unknown, null, undefined> | null = null;
    private lineChartSvg: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
    private boxplotSvg: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
    private lineClip: d3.Selection<SVGRectElement, unknown, null, undefined> | null = null;
    private axisLeft: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
    private axisBottom: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;

    private width = 0;
    private height = 0;
    private resizeObserver: ResizeObserver | undefined;
    private intervalTimer: number | null = null;

    private lineX: d3.ScaleTime<number, number, never> = d3.scaleTime();

    ngAfterViewInit(): void {
        this.initChart();
        this.measure();
        this.updateChart();

        effect(() => {
            this.clients();
            this.updateChart();
        }, { injector: this.injector });

        this.intervalTimer = window.setInterval(() => {
            this.animateChart();
            this.updateChart();
        }, 1000);

        this.animateChart();

        // the size of its box, not of the window: the card changes width without a window resize
        this.resizeObserver = new ResizeObserver(() => {
            this.measure();
            this.animateChart();
            this.updateChart();
        });
        this.resizeObserver.observe(this.latencyChart().nativeElement);
    }

    ngOnDestroy(): void {
        if (this.intervalTimer !== null) {
            window.clearInterval(this.intervalTimer);
        }
        this.resizeObserver?.disconnect();
    }

    private initChart(): void {
        this.svg = d3.select(this.latencyChart().nativeElement).append('svg');

        this.boxplotSvg = this.svg
            .append('g')
            .attr('transform', 'translate(' + margin.left + ',' + margin.top + ')');

        // A sample that arrives during the slide lies up to a second past the right end of the
        // time axis, and its segment was drawn over the first client's box until the next slide.
        const clipId = `latency-clip-${++clipIds}`;
        this.lineClip = this.svg.append('clipPath').attr('id', clipId).append('rect').attr('y', -2);

        this.lineChartSvg = this.svg
            .append('g')
            .attr('transform', 'translate(' + margin.left + ',' + margin.top + ')')
            .attr('clip-path', `url(#${clipId})`)
            // extra container for smooth animations
            .append('g');

        this.axisBottom = this.svg.append('g').attr('class', 'axis');
        this.axisLeft = this.svg
            .append('g')
            .attr('class', 'axis')
            .attr('transform', `translate(${margin.left}, ${margin.top})`);
    }

    private measure(): void {
        const el = this.latencyChart().nativeElement;
        this.width = el.clientWidth;
        this.height = el.clientHeight;
        this.svg?.attr('width', this.width).attr('height', this.height);
        // 2px over the top and bottom for the stroke of a line at either end of the scale
        this.lineClip?.attr('height', Math.max(0, this.height - margin.top - margin.bottom) + 4);
        this.axisBottom?.attr('transform', `translate(${margin.left}, ${this.height - margin.bottom})`);
    }

    // The boxplots on the right take at most 40% of the plot, the line chart the rest.
    private layout(): { plotWidth: number; band: number } {
        const plotWidth = Math.max(0, this.width - margin.left - margin.right);
        const { band, hidden } = boxLayout(this.width, plotWidth, this.clients().length);
        this.boxesHidden.set(hidden);
        return { plotWidth, band };
    }

    private animateChart(): void {
        const { plotWidth, band } = this.layout();
        const now = Date.now();
        const boxplotWidth = this.clients().length * band;
        const linechartWidth = Math.max(0, plotWidth - boxplotWidth);
        this.lineClip?.attr('width', linechartWidth);

        if (this.boxplotSvg) {
            this.boxplotSvg
                .attr('transform', `translate(${margin.left + linechartWidth}, ${margin.top})`);
        }

        const axis = d3.axisBottom(this.lineX)
            .ticks(Math.max(2, Math.floor(linechartWidth / 80)))
            .tickFormat(timeLabel);
        this.lineChartSvg?.interrupt().attr('transform', 'translate(0, 0)');
        this.axisBottom?.interrupt();

        this.lineX = d3.scaleTime()
            .domain(timeDomain(now))
            .range([0, linechartWidth]);

        // slides left until the next (expected) update
        this.lineChartSvg
            ?.transition()
            .ease(d3.easeLinear)
            .duration(1000)
            .attr('transform', `translate(${-this.lineX(now - TIME_RANGE_MILLIS)}, 0)`);

        this.axisBottom
            ?.transition()
            .duration(1000)
            .ease(d3.easeLinear)
            .call(axis.scale(this.lineX));
    }

    private updateChart(): void {
        if (this.width === 0 || this.height === 0) return;

        const clients = this.clients();
        const plotHeight = Math.max(0, this.height - margin.top - margin.bottom);
        const { band } = this.layout();
        const boxWidth = Math.max(4, band - boxplotPadding);

        // coloured by the client's slot, the same as in the table under the chart
        const lines: Line[] = clients
            .map(client => ({ client, color: clientColor(client.slot) }))
            .filter(line => line.client.latency.length > 0);

        const xScale = d3.scalePoint()
            .domain(clients.map(client => client.id))
            .range([0, clients.length * band])
            .padding(0.5);

        const maxLatency = d3.max(clients.flatMap(c => (c.latency || []).map(l => l[1]))) || 1;
        const yScale = d3.scaleLinear()
            .domain([Math.max(maxLatency, 10), 0])
            .range([0, plotHeight])
            .nice();

        if (this.boxplotSvg && band === 0) {
            this.boxplotSvg.selectAll('g.plot').remove();
        } else if (this.boxplotSvg) {
            const boxplotData = lines.map(line => ({
                ...boxplotStats(line.client.latency.map(l => l[1])),
                id: line.client.id,
                color: line.color
            }));

            const draw = boxplot(true, yScale, boxWidth, boxWidth, false, boxplotSymbolDot, 0.5, 0.5);
            this.boxplotSvg
                .selectAll<SVGGElement, BoxplotStats & { id: string; color: string }>('g.plot')
                .data(boxplotData, d => d.id)
                .join('g')
                .attr('transform', d => `translate(${(xScale(d.id) || 0) - boxWidth / 2}, 0)`)
                .attr('color', d => d.color)
                .attr('class', 'plot')
                // one plot at a time: boxplot() adds its groups only where none of the selection has
                // them yet, so a client joining later got an empty plot
                .each(function () {
                    d3.select(this).call(draw);
                });
        }

        if (this.lineChartSvg) {
            const line = d3.line<[number, number]>()
                .x(d => this.lineX(d[0]))
                .y(d => yScale(d[1]));

            this.lineChartSvg
                .selectAll<SVGPathElement, Line>('path.line')
                .data(lines, d => d.client.id)
                .join('path')
                .attr('class', 'line')
                .attr('fill', 'none')
                .attr('stroke', d => d.color)
                .attr('stroke-width', 1.5)
                .attr('d', d => line(perSecond(d.client.latency)));
        }

        if (this.axisLeft) {
            this.axisLeft.call(d3.axisLeft(yScale).ticks(Math.max(2, Math.floor(plotHeight / 40))));
        }
    }
}
