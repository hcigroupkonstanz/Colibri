import { AfterViewInit, Component, ElementRef, ViewChild } from '@angular/core';
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
export class LatencyChartComponent implements AfterViewInit {
    @ViewChild('latencyChart')
    latencyChart!: ElementRef<HTMLDivElement>;
    clients: ReadonlyArray<ColibriClient> = [];

    private margin = { top: 50, right: 10, bottom: 20, left: 50 };
    private chartSvg: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
    private axisLeft: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
    private axisBottom: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;


    constructor(private clientService: ClientService) { }

    ngAfterViewInit(): void {
        this.initChart();

        this.clientService.clients$.subscribe(clients => {
            this.drawChart(clients);
        });
    }

    getMedian(latencies: ReadonlyArray<[number, number]>): number {
        return d3.median(latencies.map(l => l[1])) || 0;
    }

    getStdDev(latencies: ReadonlyArray<[number, number]>): number {
        return d3.deviation(latencies.map(l => l[1])) || 0;
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

    private drawChart(clients: ReadonlyArray<ColibriClient>): void {
        this.clients = clients;

        const totalHeight = 500;
        const totalWidth = this.latencyChart.nativeElement.clientWidth;

        const barWidth = 30;

        const plotWidth = totalWidth - this.margin.left - this.margin.right;
        const plotHeight = totalHeight - this.margin.top - this.margin.bottom;

        const boxplotData =  clients.map(client => boxplotStats(client.latency.map(l => l[1])));
        const colors = d3.schemeCategory10;

        const xScale = d3.scalePoint()
            .domain(clients.map(client => client.id))
            .rangeRound([0, plotWidth])
            .padding(0.5);

        const lineXScale = d3.scaleLinear()
            .domain([
                d3.min(clients.flatMap(c => c.latency.map(l => l[0]))) || 0,
                d3.max(clients.flatMap(c => c.latency.map(l => l[0]))) || 1
            ])
            .range([0, plotWidth]);

        const max = d3.max(clients.flatMap(c => c.latency.map(l => l[1]))) || 1;
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

            // line chart
            this.chartSvg
                .selectAll('path.line')
                .data(clients.map(c => c.latency))
                .enter()
                .append('path')
                    .attr('class', 'line')
                    .attr('fill', 'none')
                    .attr('stroke', 'steelblue')
                    .attr('stroke-width', 1.5)
                .merge(this.chartSvg.selectAll('path.line'))
                    .attr('d', d3.line()
                        .x(d => lineXScale(d[0]))
                        .y(d => yScale(d[1]))
                    );
        }

        if (this.axisBottom) {
            this.axisBottom.call(d3.axisTop(xScale));
        }
    }
}
