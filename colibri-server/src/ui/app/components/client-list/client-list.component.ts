import { AfterViewInit, Component, ElementRef, ViewChild } from '@angular/core';
import { ClientService, ColibriClient } from '../../services/client.service';
import * as d3 from 'd3';
import { CommonModule } from '@angular/common';

@Component({
    selector: 'app-client-list',
    templateUrl: './client-list.component.html',
    styleUrls: ['./client-list.component.scss'],
    standalone: true,
    imports: [CommonModule]
})
export class ClientListComponent implements AfterViewInit {
    @ViewChild('latencyChart')
    latencyChart!: ElementRef<HTMLDivElement>;

    constructor(private clientService: ClientService) { }

    ngAfterViewInit(): void {
        this.drawChart([]);
        this.clientService.clients$.subscribe(clients => {
            this.drawChart(clients);
        });
    }

    private drawChart(clients: ReadonlyArray<ColibriClient>): void {
        const boxQuartiles = (d: any) => {
            return [
                d3.quantile(d, .25),
                d3.quantile(d, .5),
                d3.quantile(d, .75)
            ];
        };

        // Perform a numeric sort on an array
        const sortNumber = (a: number, b: number) => {
            return a - b;
        };


        let width = 900;
        let height = 1800;
        const barWidth = 30;

        const margin = { top: 20, right: 10, bottom: 20, left: 10 };

        width = width - margin.left - margin.right;
        height = height - margin.top - margin.bottom;

        const totalWidth = width + margin.left + margin.right;
        const totalheight = height + margin.top + margin.bottom;

        // Generate five 100 count, normal distributions with random means
        const groupCounts: { [key: string]: number[] } = {};
        const globalCounts = [];

        for (const client of clients) {
            const key = client.id;
            groupCounts[key] = client.latency;
            globalCounts.push(...client.latency);
        }

        // Sort group counts so quantile methods work
        for (const key in groupCounts) {
            const groupCount = groupCounts[key];
            groupCounts[key] = groupCount.sort(sortNumber);
        }

        // Setup a color scale for filling each box
        const colorScale = d3.scaleOrdinal(d3.schemeCategory10)
            .domain(Object.keys(groupCounts));

        // Prepare the data for the box plots
        const boxPlotData: any[] = [];
        for (const [key, groupCount] of Object.entries(groupCounts)) {

            const record: any = {};
            const localMin = d3.min(groupCount);
            const localMax = d3.max(groupCount);

            const stats = this.boxplotStats(groupCount);

            record['key'] = key;
            record['counts'] = groupCount;
            record['quartile'] = boxQuartiles(groupCount);
            record['whiskers'] = [ stats.whiskers[0].start, stats.whiskers[1].start ];
            record['color'] = colorScale(key);

            boxPlotData.push(record);
        }

        // Compute an ordinal xScale for the keys in boxPlotData
        const xScale = d3.scalePoint()
            .domain(Object.keys(groupCounts))
            .rangeRound([0, width])
            .padding(0.5);

        // Compute a global y scale based on the global counts
        const max = d3.max(globalCounts) || 1;
        const yScale = d3.scaleLinear()
            .domain([0, max])
            .range([margin.left, height]);

        // Setup the svg and group we will draw the box plot in
        const svg = d3.select(this.latencyChart.nativeElement).html('').append('svg')
            .attr('width', totalheight)
            .attr('height', totalWidth)
            .append('g')
            .attr('transform', 'translate(' + margin.left + ',' + margin.top + ')');

        // Move the left axis over 25 pixels, and the top axis over 35 pixels
        const axisG = svg.append('g').attr('transform', 'translate(25,0)');
        const axisTopG = svg.append('g').attr('transform', 'translate(35,0)');

        // Setup the group the box plot elements will render in
        const g = svg.append('g')
            .attr('transform', 'translate(20,5)');

        // Draw the box plot vertical lines
        const verticalLines = g.selectAll('.verticalLines')
            .data(boxPlotData)
            .enter()
            .append('line')
            .attr('y1', (datum) => {
                return (xScale(datum.key) || 0) + barWidth / 2;
            }
            )
            .attr('x1', function (datum) {
                const whisker = datum.whiskers[0];
                return yScale(whisker);
            }
            )
            .attr('y2', function (datum) {
                return (xScale(datum.key) || 0) + barWidth / 2;
            }
            )
            .attr('x2', function (datum) {
                const whisker = datum.whiskers[1];
                return yScale(whisker);
            }
            )
            .attr('stroke', '#000')
            .attr('stroke-width', 1)
            .attr('fill', 'none');

        const dots = g.selectAll('.dot')
            .data(globalCounts)
            .enter()
            .append('circle')
            .attr('r', 1)
            .attr('cx', (d) => yScale(d))
            .attr('cy', (d) => (xScale(boxPlotData[0].key) || 0) + Math.random() * 10 - 20)
            .attr('fill', '#88C0D0');


        // Draw the boxes of the box plot, filled in white and on top of vertical lines
        const rects = g.selectAll('rect')
            .data(boxPlotData)
            .enter()
            .append('rect')
            .attr('height', barWidth)
            .attr('width', function (datum) {
                const quartiles = datum.quartile;
                const height = yScale(quartiles[2]) - yScale(quartiles[0]);
                return height;
            }
            )
            .attr('y', (datum: any) => {
                return xScale(datum.key) || 0;
            }
            )
            .attr('x', function (datum) {
                return yScale(datum.quartile[0]);
            }
            )
            .attr('fill', function (datum) {
                return datum.color;
            }
            )
            .attr('stroke', '#000')
            .attr('stroke-width', 1);

        // Now render all the horizontal lines at once - the whiskers and the median
        const horizontalLineConfigs = [
            // Top whisker
            {
                x1: (datum: any) => xScale(datum.key),
                y1: (datum: any) => yScale(datum.whiskers[0]),
                x2: (datum: any) => (xScale(datum.key) || 0) + barWidth,
                y2: (datum: any) => yScale(datum.whiskers[0])
            },
            // Median line
            {
                x1: (datum: any) => xScale(datum.key),
                y1: (datum: any) => yScale(datum.quartile[1]),
                x2: (datum: any) => (xScale(datum.key) || 0) + barWidth,
                y2: (datum: any) => yScale(datum.quartile[1])
            },
            // Bottom whisker
            {
                x1: (datum: any) => xScale(datum.key),
                y1: (datum: any) => yScale(datum.whiskers[1]),
                x2: (datum: any) => (xScale(datum.key) || 0) + barWidth,
                y2: (datum: any) => yScale(datum.whiskers[1])
            }
        ];

        for (let i = 0; i < horizontalLineConfigs.length; i++) {
            const lineConfig = horizontalLineConfigs[i];

            // Draw the whiskers at the min for this series
            const horizontalLine = g.selectAll('.whiskers')
                .data(boxPlotData)
                .enter()
                .append('line')
                .attr('y1', d => lineConfig.x1(d) || 0)
                .attr('x1', lineConfig.y1)
                .attr('y2', lineConfig.x2)
                .attr('x2', lineConfig.y2)
                .attr('stroke', '#000')
                .attr('stroke-width', 1)
                .attr('fill', 'none');
        }

        // Setup a scale on the left
        const axisLeft = d3.axisTop(yScale);
        axisG.append('g')
            .call(axisLeft);

        // Setup a series axis on the top
        const axisTop = d3.axisLeft(xScale);
        axisTopG.append('g')
            .call(axisTop);
    }

    // Adapted from https://github.com/akngs/d3-boxplot/blob/main/src/boxplot.js
    private boxplotStats(values: number[]) {
        const fiveNums = [0.0, 0.25, 0.5, 0.75, 1.0].map((d) => d3.quantile(values, d)) as number[];
        const iqr = fiveNums[3] - fiveNums[1];
        const step = iqr * 1.5;
        const fences = [
            { start: fiveNums[1] - step - step, end: fiveNums[1] - step },
            { start: fiveNums[1] - step, end: fiveNums[1] },
            { start: fiveNums[1], end: fiveNums[3] },
            { start: fiveNums[3], end: fiveNums[3] + step },
            { start: fiveNums[3] + step, end: fiveNums[3] + step + step },
        ];
        const boxes = [
            { start: fiveNums[1], end: fiveNums[2] },
            { start: fiveNums[2], end: fiveNums[3] },
        ];
        const whiskers = [
            { start: d3.min(values.filter((d) => fences[1].start <= d)), end: fiveNums[1] },
            { start: d3.max(values.filter((d) => fences[3].end >= d)), end: fiveNums[3] },
        ];
        const points = values.map((d, i) => ({
            value: d,
            datum: values[i],
            outlier: d < fences[1].start || fences[3].end < d,
            farout: d < fences[0].start || fences[4].end < d,
        }));
        return { fiveNums, iqr, step, fences, boxes, whiskers, points };
    }
}
