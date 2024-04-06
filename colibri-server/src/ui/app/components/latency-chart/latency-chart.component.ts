import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild } from '@angular/core';
import { ClientService, ColibriClient } from '../../services/client.service';
import * as d3 from 'd3';
import { CommonModule } from '@angular/common';
import { boxplot, boxplotStats, boxplotSymbolDot } from './boxplot';

@Component({
    selector: 'app-latency-chart',
    templateUrl: './latency-chart.component.html',
    styleUrls: ['./latency-chart.component.scss'],
    standalone: true,
    imports: [CommonModule]
})
export class LatencyChartComponent implements AfterViewInit, OnDestroy {
    @ViewChild('latencyChart')
    latencyChart!: ElementRef<HTMLDivElement>;
    clients: ReadonlyArray<ColibriClient> = [];

    private margin = { top: 50, right: 10, bottom: 20, left: 50 };
    private chartSvg: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
    private axisLeft: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
    private axisBottom: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;

    private intervalTimer: number | null = null;

    constructor(private clientService: ClientService) { }

    ngAfterViewInit(): void {
        this.initChart();

        let c: ReadonlyArray<ColibriClient> = [];
        this.clientService.clients$.subscribe(clients => {
            this.updateBoxPlot(clients);
            c = clients;
        });

        this.intervalTimer = window.setInterval(() => {
            this.updateLineChart(c);
        }, 20);
    }

    ngOnDestroy(): void {
        if (this.intervalTimer !== null) {
            window.clearInterval(this.intervalTimer);
        }
    }

    getMedian(latencies: ReadonlyArray<[number, number]>): number {
        return d3.median((latencies || []).map(l => l[1]) || []) || 0;
    }

    getStdDev(latencies: ReadonlyArray<[number, number]>): number {
        return d3.deviation((latencies || []).map(l => l[1]) || []) || 0;
    }

    private initChart(): void {
        const totalHeight = 500;
        const totalWidth = this.latencyChart.nativeElement.clientWidth;

        const svg = d3.select(this.latencyChart.nativeElement).html('').append('svg')
            .attr('width', totalWidth)
            .attr('height', totalHeight);

        this.chartSvg =  svg
            .append('g')
            .attr('transform', 'translate(' + this.margin.left + ',' + this.margin.top + ')');

        this.axisBottom = svg
            .append('g')
            .attr('transform', `translate(${this.margin.left}, ${this.margin.top})`);


    }

    private updateLineChart(clients: ReadonlyArray<ColibriClient>): void {

        const totalHeight = 500;
        const totalWidth = this.latencyChart.nativeElement.clientWidth;

        const plotWidth = totalWidth - this.margin.left - this.margin.right;
        const plotHeight = totalHeight - this.margin.top - this.margin.bottom;

        const maxLatency = d3.max(clients.flatMap(c => (c.latency || []).map(l => l[1]))) || 1;
        const yScale = d3.scaleLinear()
            .domain([Math.max(maxLatency, 10), 0])
            .range([0, plotHeight]);

        const now = Date.now();
        // we ping every 100ms and store the last 1000 values (and query every 1s = 1000ms)

        const lineXScale = d3.scaleTime()
            .domain([ now - (100 * 1000) - 1000, now ])
            .range([0, plotWidth]);


        if (this.chartSvg) {
            this.chartSvg
                .selectAll('path.line')
                .data(clients.map(c => c.latency))
                .enter()
                .append('path')
                    .attr('class', 'line')
                    .attr('fill', 'none')
                    .attr('stroke', (d, i) => d3.schemeCategory10[i % d3.schemeCategory10.length])
                    .attr('stroke-width', 1.5)
                .merge(this.chartSvg.selectAll('path.line'))
                    .attr('d', d3.line()
                        .x(d => lineXScale(d[0]))
                        .y(d => yScale(d[1]))
                    );
                }
    }

    private updateBoxPlot(clients: ReadonlyArray<ColibriClient>): void {
        this.clients = clients;

        const totalHeight = 500;
        const totalWidth = this.latencyChart.nativeElement.clientWidth;

        const barWidth = 30;

        const plotWidth = totalWidth - this.margin.left - this.margin.right;
        const plotHeight = totalHeight - this.margin.top - this.margin.bottom;

        const boxplotData =  clients.map(client => boxplotStats((client.latency || []).map(l => l[1])));
        const colors = d3.schemeCategory10;

        const xScale = d3.scalePoint()
            .domain(clients.map(client => client.id))
            .rangeRound([0, plotWidth])
            .padding(0.5);

        const max = d3.max(clients.flatMap(c => (c.latency || []).map(l => l[1]))) || 1;
        const yScale = d3.scaleLinear()
            .domain([Math.max(max, 10), 0])
            .range([0, plotHeight]);

        if (this.chartSvg) {
            this.chartSvg
                .selectAll('g.plot')
                .data(boxplotData)
                .join('g')
                .attr('transform', (_, i: number) => `translate(${(xScale(clients[i].id) || 0) - barWidth / 2}, 0)`)
                .attr('color', (_, i) => colors[i % colors.length])
                .attr('class', 'plot')
                .call(boxplot(true, yScale, barWidth, barWidth, false, boxplotSymbolDot, 0.5, 0.5));
        }

        // if (this.axisBottom) {
        //     this.axisBottom.call(d3.axisTop(xScale));
        // }
    }
}
