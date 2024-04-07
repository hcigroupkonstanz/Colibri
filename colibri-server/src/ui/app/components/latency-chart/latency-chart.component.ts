import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, ViewChild } from '@angular/core';
import { ClientService, ColibriClient } from '../../services/client.service';
import * as d3 from 'd3';
import { CommonModule } from '@angular/common';
import { boxplot, boxplotStats, boxplotSymbolDot } from './boxplot';

const margin = { top: 20, right: 10, bottom: 50, left: 50 };
// we ping every 100ms and store the last 1000 values (and query every 1s = 1000ms)
const timeRange = 110 * 1000;
const totalHeight = 500;
const barWidth = 30;

// https://www.nordtheme.com/docs/colors-and-palettes
const colors = [
    '#5E81AC', // blue
    '#A3BE8C', // green
    '#B48EAD', // purple
    '#88C0D0', // cyan
    '#BF616A', // red
    '#4C566A', // gray
    '#D08770', // orange,
    '#EBCB8B', // yellow
    '#8FBCBB', // light cyan
    '#81A1C1', // light blue
];

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

    private lineChartSvg: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
    private boxplotSvg: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
    private axisLeft: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
    private axisBottom: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;


    private intervalTimer: number | null = null;

    private lineX: d3.ScaleTime<number, number, never> = d3.scaleTime();

    constructor(private clientService: ClientService) { }

    ngAfterViewInit(): void {
        this.initChart();

        this.clientService.clients$.subscribe(clients => {
            this.clients = clients;
            this.updateChart();
        });

        this.intervalTimer = window.setInterval(() => {
            this.animateChart();
            this.updateChart();
        }, 1000);
        this.animateChart();
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

    getColor(client: ColibriClient): string {
        return colors[this.clients.indexOf(client) % colors.length];
    }

    private initChart(): void {
        const totalWidth = this.latencyChart.nativeElement.clientWidth;

        const svg = d3.select(this.latencyChart.nativeElement).append('svg')
            .attr('width', totalWidth)
            .attr('height', totalHeight);

        this.boxplotSvg = svg
            .append('g')
            .attr('transform', 'translate(' + margin.left + ',' + margin.top + ')');

        this.lineChartSvg = svg
            .append('g')
            .attr('transform', 'translate(' + margin.left + ',' + margin.top + ')')
            // extra container for smooth animations
            .append('g');

        this.axisBottom = svg
            .append('g')
            .attr('transform', `translate(${margin.left}, ${totalHeight - margin.bottom})`);

        this.axisLeft = svg
            .append('g')
            .attr('transform', `translate(${margin.left}, ${margin.top})`);

    }

    private animateChart(): void {
        const totalWidth = this.latencyChart.nativeElement.clientWidth;
        const plotWidth = totalWidth - margin.left - margin.right;
        const now = Date.now();

        const boxplotPadding = 5;
        const boxplotWidth = this.clients.length * (barWidth + boxplotPadding);
        const linechartWidth = plotWidth - boxplotWidth;

        if (this.boxplotSvg) {
            this.boxplotSvg
                .attr('transform', `translate(${margin.left + linechartWidth}, ${margin.top})`);
        }

        this.lineX = d3.scaleTime()
            .domain([ now - timeRange - 1000, now ])
            .range([0, linechartWidth]);

        if (this.lineChartSvg) {
            // animate until next (expected) update
            this.lineChartSvg
                .interrupt()
                .attr('transform', 'translate(0, 0)');
            
            this.lineChartSvg
                .transition()
                .ease(d3.easeLinear)
                .duration(1000)
                .attr('transform', `translate(${-this.lineX(now - timeRange)}, 0)`);
        }


        if (this.axisBottom) {
            this.axisBottom
                .transition()
                .duration(1000)
                .ease(d3.easeLinear)
                .call(d3.axisBottom(this.lineX));
        }
    }

    @HostListener('window:resize')
    onResize() {
        const svg = d3.select(this.latencyChart.nativeElement).select('svg');
        const totalWidth = this.latencyChart.nativeElement.clientWidth;
        svg.attr('width', totalWidth);
        this.animateChart();
    }

    private updateChart(): void {
        const plotHeight = totalHeight - margin.top - margin.bottom;
        const boxplotPadding = 5;
        const boxplotWidth = this.clients.length * (barWidth + boxplotPadding);

        const boxplotData =  this.clients.map(client => boxplotStats((client.latency || []).map(l => l[1])));

        const xScale = d3.scalePoint()
            .domain(this.clients.map(client => client.id))
            .rangeRound([0, boxplotWidth])
            .padding(0.5);

        const maxLatency = d3.max(this.clients.flatMap(c => (c.latency || []).map(l => l[1]))) || 1;
        const yScale = d3.scaleLinear()
            .domain([Math.max(maxLatency, 10), 0])
            .range([0, plotHeight])
            .nice();

        if (this.boxplotSvg) {
            this.boxplotSvg
                .selectAll('g.plot')
                .data(boxplotData)
                .join('g')
                .attr('transform', (_, i: number) => `translate(${(xScale(this.clients[i].id) || 0) - barWidth / 2}, 0)`)
                .attr('color', (_, i) => colors[i % colors.length])
                .attr('class', 'plot')
                .call(boxplot(true, yScale, barWidth, barWidth, false, boxplotSymbolDot, 0.5, 0.5));
        }

        
        if (this.lineChartSvg) {
            const path = this.lineChartSvg
                .selectAll('path.line')
                .data(this.clients.map(c => c.latency));
            path.enter()
                    .append('path')
                    .attr('class', 'line')
                    .attr('fill', 'none')
                    .attr('stroke', (d, i) => colors[i % colors.length])
                    .attr('stroke-width', 1.5)
                .merge(this.lineChartSvg.selectAll('path.line'))
                    .attr('d', d3.line()
                        .x(d => this.lineX(d[0]))
                        .y(d => yScale(d[1]))
                    );
            path.exit()
                    .remove();
        }

        if (this.axisLeft) {
            this.axisLeft.call(d3.axisLeft(yScale));
        }
    }
}
