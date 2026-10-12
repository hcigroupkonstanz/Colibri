import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, Injector, OnDestroy, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import * as d3 from 'd3';
import { ClientService, ClientsSnapshot } from '../../services';
import { TIME_RANGE_MILLIS, clientColor, timeDomain } from '../latency-chart/latency-chart.component';

const margin = { top: 12, right: 12, bottom: 28, left: 44 };
// A second more than the chart shows, so the oldest area reaches its left edge.
const keepFor = TIME_RANGE_MILLIS + 2000;
// Snapshots come every second; a longer pause (a reconnect, a hidden tab) breaks the areas.
const maxGap = 2500;

export type Direction = 'in' | 'out';

/** A client in one snapshot: its app, its colour then, and its messages per second. */
export interface ClientRate {
    app: string;
    color: string;
    in: number | null;
    out: number | null;
}

/** One clients snapshot as the chart keeps it, by the browser's clock when it arrived. */
export interface Sample {
    at: number;
    clients: ReadonlyMap<string, ClientRate>;
}

/** The samples with one more, without those older than the chart shows. */
export const addSample = function (samples: ReadonlyArray<Sample>, sample: Sample): Sample[] {
    return [ ...samples.filter(s => s.at >= sample.at - keepFor && s.at < sample.at), sample ];
};

/**
 * What a snapshot's rate history stands for: the samples of the snapshots a page would have had in
 * each second before it, which arrived at `at`. Each client keeps its colour now.
 */
export const historySamples = function (snapshot: ClientsSnapshot, at: number, color: (id: string) => string): Sample[] {
    const seconds = snapshot.clients.reduce((most, client) => Math.max(most, client.history?.length ?? 0), 0);
    const samples: Sample[] = [];
    for (let ago = seconds; ago >= 1; ago--) {
        const clients = new Map<string, ClientRate>();
        for (const client of snapshot.clients) {
            const rates = client.history?.[client.history.length - ago];
            if (rates) clients.set(client.id, { app: client.app, color: color(client.id), in: rates[0], out: rates[1] });
        }
        samples.push({ at: at - ago * 1000, clients });
    }
    return samples;
};

/** The samples with the history in place of those it covers. */
export const withHistory = function (samples: ReadonlyArray<Sample>, history: ReadonlyArray<Sample>): Sample[] {
    const from = history[0]?.at;
    return from === undefined ? [ ...samples ] : [ ...samples.filter(s => s.at < from), ...history ];
};

export interface StackRow {
    at: number;
    /** A pause in the snapshots: the areas stop here and start again after it. */
    gap: boolean;
    values: Record<string, number>;
}

export interface Series {
    id: string;
    color: string;
}

/**
 * The rows d3.stack takes, one per snapshot, and the clients in them, the first seen at the bottom,
 * each in its newest colour: the table's colours change when the page reconnects.
 * A rate the server did not have (a client's first second, a TCP worker slow to answer) keeps the
 * client's last one: as 0 it drew a dip in the total just when the server is busiest.
 */
export const stackInput = function (samples: ReadonlyArray<Sample>, direction: Direction, app: string): { rows: StackRow[]; series: Series[] } {
    const series = new Map<string, Series>();
    const last = new Map<string, number>();
    const rows: StackRow[] = [];
    let previous: number | undefined;
    for (const sample of samples) {
        if (previous !== undefined && sample.at - previous > maxGap) {
            rows.push({ at: (previous + sample.at) / 2, gap: true, values: {} });
        }
        previous = sample.at;

        const values: Record<string, number> = {};
        for (const [ id, client ] of sample.clients) {
            if (app && client.app !== app) continue;
            // a Map keeps the place of the first set, so the order of the layers stays
            series.set(id, { id, color: client.color });
            const rate = client[direction] ?? last.get(id) ?? 0;
            last.set(id, rate);
            values[id] = rate;
        }
        rows.push({ at: sample.at, gap: false, values });
    }
    return { rows, series: [ ...series.values() ] };
};

/** The sum of the newest row, or null before the first. */
export const latestTotal = function (rows: ReadonlyArray<StackRow>): number | null {
    const row = rows.at(-1);
    return row ? Object.values(row.values).reduce((sum, rate) => sum + rate, 0) : null;
};

/**
 * Which points of a layer's top edge to draw: where it has some height, and next to those, so it
 * rises and falls with a client that joins or leaves. Along a client not there, or sending
 * nothing, its edge lay on the layers below, and being drawn later, it took their colour.
 */
export const edgeShown = function (layer: ReadonlyArray<d3.SeriesPoint<StackRow>>): boolean[] {
    const tall = layer.map(point => !point.data.gap && point[1] > point[0]);
    return layer.map((point, i) => !point.data.gap && (tall[i] || tall[i - 1] === true || tall[i + 1] === true));
};

const timeLabel = function (value: Date | d3.NumberValue): string {
    const date = value instanceof Date ? value : new Date(Number(value));
    return d3.timeFormat(date.getSeconds() === 0 ? '%H:%M' : ':%S')(date);
};

// 1.2k from 1000 up; below, as it is (the SI format wrote 0.5 as 500m)
const rateLabel = function (value: d3.NumberValue): string {
    const n = Number(value);
    return n >= 1000 ? d3.format('.2~s')(n) : d3.format('~')(n);
};

type Layer = d3.Series<StackRow, string> & { color: string };

// a clipPath id of its own for each chart on the page
let clipIds = 0;

@Component({
    selector: 'app-throughput-chart',
    templateUrl: './throughput-chart.component.html',
    styleUrls: ['./throughput-chart.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class ThroughputChartComponent implements AfterViewInit, OnDestroy {
    private clientService = inject(ClientService);
    private injector = inject(Injector);

    private chart = viewChild.required<ElementRef<HTMLDivElement>>('throughputChart');

    /** The latest clients snapshot of the page. */
    snapshot = input<ClientsSnapshot | null>(null);
    /** The app whose clients it shows, or '' for all. */
    app = input('');
    direction = input<Direction>('in');

    private samples = signal<ReadonlyArray<Sample>>([]);

    private stack = computed(() => stackInput(this.samples(), this.direction(), this.app()));

    /** The messages per second of the clients shown, now: the top of the chart's right edge. */
    total = computed(() => latestTotal(this.stack().rows));

    /** What the chart says instead of an empty plot. */
    message = computed(() => {
        const snapshot = this.snapshot();
        const app = this.app();
        if (snapshot && !snapshot.clients.some(client => !app || client.app === app)) {
            return app ? `No clients of ${app} connected.` : 'No clients connected.';
        }
        if (this.stack().rows.length < 2) return 'Collecting message rates…';
        return null;
    });

    label = computed(() => this.direction() === 'in'
        ? 'Messages per second each connected client sent, stacked, over the last 120 seconds'
        : 'Messages per second sent to each connected client, stacked, over the last 120 seconds');

    private svg: d3.Selection<SVGSVGElement, unknown, null, undefined> | null = null;
    private clipRect: d3.Selection<SVGRectElement, unknown, null, undefined> | null = null;
    private areaSvg: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
    private axisLeft: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
    private axisBottom: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;

    private width = 0;
    private height = 0;
    private resizeObserver: ResizeObserver | undefined;
    private intervalTimer: number | null = null;

    private x: d3.ScaleTime<number, number, never> = d3.scaleTime();

    constructor() {
        // Each snapshot once, with each client's colour as it was then: a client that left keeps it.
        // The first of a subscription, after the page opens or reconnects, brings the rates of the
        // seconds before it.
        effect(() => {
            const snapshot = this.snapshot();
            if (!snapshot) return;
            untracked(() => {
                const now = Date.now();
                const slots = new Map(this.clientService.clients().map(client => [ client.id, client.slot ]));
                const color = (id: string) => {
                    const slot = slots.get(id);
                    return slot === undefined ? 'var(--text-muted)' : clientColor(slot);
                };
                const clients = new Map<string, ClientRate>();
                for (const client of snapshot.clients) {
                    clients.set(client.id, { app: client.app, color: color(client.id), in: client.in, out: client.out });
                }

                const samples = snapshot.clients.some(client => client.history)
                    ? withHistory(this.samples(), historySamples(snapshot, now, color))
                    : this.samples();
                this.samples.set(addSample(samples, { at: now, clients }));
            });
        });
    }

    ngAfterViewInit(): void {
        this.initChart();
        this.measure();
        this.updateChart();

        effect(() => {
            this.stack();
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
        this.resizeObserver.observe(this.chart().nativeElement);
    }

    ngOnDestroy(): void {
        if (this.intervalTimer !== null) {
            window.clearInterval(this.intervalTimer);
        }
        this.resizeObserver?.disconnect();
    }

    private initChart(): void {
        this.svg = d3.select(this.chart().nativeElement).append('svg');

        // The areas reach a second or two left of the axis: the samples start before the time
        // axis does, so that they fill it to its left edge.
        const clipId = `throughput-clip-${++clipIds}`;
        this.clipRect = this.svg.append('clipPath').attr('id', clipId).append('rect').attr('y', -2);

        this.areaSvg = this.svg
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
        const el = this.chart().nativeElement;
        this.width = el.clientWidth;
        this.height = el.clientHeight;
        this.svg?.attr('width', this.width).attr('height', this.height);
        // 2px over the top for the edge of the highest layer
        this.clipRect
            ?.attr('width', Math.max(0, this.width - margin.left - margin.right))
            .attr('height', Math.max(0, this.height - margin.top - margin.bottom) + 2);
        this.axisBottom?.attr('transform', `translate(${margin.left}, ${this.height - margin.bottom})`);
    }

    // The time axis as in the latency chart: the whole window, sliding left each second.
    private animateChart(): void {
        const plotWidth = Math.max(0, this.width - margin.left - margin.right);
        const now = Date.now();

        const axis = d3.axisBottom(this.x)
            .ticks(Math.max(2, Math.floor(plotWidth / 80)))
            .tickFormat(timeLabel);
        this.areaSvg?.interrupt().attr('transform', 'translate(0, 0)');
        this.axisBottom?.interrupt();

        this.x = d3.scaleTime()
            .domain(timeDomain(now))
            .range([0, plotWidth]);

        // slides left until the next (expected) update
        this.areaSvg
            ?.transition()
            .ease(d3.easeLinear)
            .duration(1000)
            .attr('transform', `translate(${-this.x(now - TIME_RANGE_MILLIS)}, 0)`);

        this.axisBottom
            ?.transition()
            .duration(1000)
            .ease(d3.easeLinear)
            .call(axis.scale(this.x));
    }

    private updateChart(): void {
        if (this.width === 0 || this.height === 0) return;

        const { rows, series } = this.stack();
        const plotHeight = Math.max(0, this.height - margin.top - margin.bottom);
        const colors = new Map(series.map(s => [ s.id, s.color ]));

        const layers: Layer[] = d3.stack<StackRow, string>()
            .keys(series.map(s => s.id))
            .value((row, id) => row.values[id] ?? 0)(rows)
            .map(layer => Object.assign(layer, { color: colors.get(layer.key) ?? 'var(--text-muted)' }));

        const top = d3.max(layers.at(-1) ?? [], point => point[1]) ?? 0;
        const y = d3.scaleLinear()
            .domain([Math.max(top, 10), 0])
            .range([0, plotHeight])
            .nice();

        if (this.areaSvg) {
            const area = d3.area<d3.SeriesPoint<StackRow>>()
                .defined(point => !point.data.gap)
                .x(point => this.x(point.data.at))
                .y0(point => y(point[0]))
                .y1(point => y(point[1]));
            const edge = (layer: Layer) => {
                const shown = edgeShown(layer);
                return d3.line<d3.SeriesPoint<StackRow>>()
                    .defined((_, i) => shown[i])
                    .x(point => this.x(point.data.at))
                    .y(point => y(point[1]))(layer);
            };

            this.areaSvg
                .selectAll<SVGGElement, Layer>('g.layer')
                .data(layers, layer => layer.key)
                .join(enter => {
                    const g = enter.append('g').attr('class', 'layer');
                    g.append('path').attr('class', 'area').attr('fill-opacity', 0.35);
                    g.append('path').attr('class', 'edge').attr('fill', 'none').attr('stroke-width', 1.5);
                    return g;
                })
                .each(function (layer) {
                    const g = d3.select(this);
                    // a style, not an attribute: the colour of a client without a slot is a CSS variable
                    g.select('path.area').style('fill', layer.color).attr('d', area(layer));
                    g.select('path.edge').style('stroke', layer.color).attr('d', edge(layer));
                });
        }

        if (this.axisLeft) {
            this.axisLeft.call(d3.axisLeft(y).ticks(Math.max(2, Math.floor(plotHeight / 40))).tickFormat(rateLabel));
        }
    }
}
