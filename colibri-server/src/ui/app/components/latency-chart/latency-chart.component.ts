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

    constructor(private clientService: ClientService) { }

    ngAfterViewInit(): void {
        this.clientService.clients$.subscribe(clients => {
            this.drawChart(clients);
        });
    }

    getMedian(latencies: ReadonlyArray<number>): number {
        return d3.median(latencies) || 0;
    }

    getStdDev(latencies: ReadonlyArray<number>): number {
        return d3.deviation(latencies) || 0;
    }

    private drawChart(clients: ReadonlyArray<ColibriClient>): void {
        this.clients = clients;

        const barHeight = 30;
        const margin = { top: 50, right: 10, bottom: 20, left: 10 };
        const totalHeight = margin.top + margin.bottom + (clients.length + 1) * (barHeight + 10);
        const totalWidth = this.latencyChart.nativeElement.clientWidth;

        const plotWidth = totalWidth - margin.left - margin.right;
        const plotHeight = totalHeight - margin.top - margin.bottom;

        const boxplotData =  clients.map(client => boxplotStats(client.latency));
        const colors = d3.schemeCategory10;

        const yScale = d3.scalePoint()
            .domain(clients.map(client => client.id))
            .rangeRound([0, plotHeight])
            .padding(0.5);

        const max = d3.max(clients.flatMap(c => c.latency)) || 1;
        const xScale = d3.scaleLinear()
            .domain([0, Math.max(max, 10)])
            .range([0, plotWidth]);

        const svg = d3.select(this.latencyChart.nativeElement).html('').append('svg')
            .attr('width', totalWidth)
            .attr('height', totalHeight);

        svg
            .append('g')
            .attr('transform', 'translate(' + margin.left + ',' + margin.top + ')')
            .selectAll('g.plot')
            .data(boxplotData)
            .join('g')
            .attr('transform', (_, i: number) => `translate(0, ${yScale(clients[i].id)})`)
            .attr('color', (_, i) => colors[i % colors.length])
            .call(boxplot(false, xScale, barHeight, barHeight, false, boxplotSymbolDot, 0.5, 0.5));

        const axis = svg
            .append('g')
            .attr('transform', `translate(${margin.left}, ${margin.top})`);

        axis.append('g')
            .call(d3.axisTop(xScale));
    }
}
