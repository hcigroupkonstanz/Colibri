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
        let height = 400;
        const barWidth = 30;

        const margin = { top: 20, right: 10, bottom: 20, left: 10 };

        width = width - margin.left - margin.right;
        height = height - margin.top - margin.bottom;

        const totalWidth = width + margin.left + margin.right;
        const totalheight = height + margin.top + margin.bottom;

        // Generate five 100 count, normal distributions with random means
        const groupCounts: { [key: string]: number[] } = {};
        const globalCounts = [];
        const meanGenerator = d3.randomUniform(10);
        for (let i = 0; i < 7; i++) {
            const randomMean = meanGenerator();
            const generator = d3.randomNormal(randomMean);
            const key = i.toString();
            groupCounts[key] = [];

            for (let j = 0; j < 100; j++) {
                const entry = generator();
                groupCounts[key].push(entry);
                globalCounts.push(entry);
            }
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
        const boxPlotData = [];
        for (const [key, groupCount] of Object.entries(groupCounts)) {

            const record: any = {};
            const localMin = d3.min(groupCount);
            const localMax = d3.max(groupCount);

            record['key'] = key;
            record['counts'] = groupCount;
            record['quartile'] = boxQuartiles(groupCount);
            record['whiskers'] = [localMin, localMax];
            record['color'] = colorScale(key);

            boxPlotData.push(record);
        }

        // Compute an ordinal xScale for the keys in boxPlotData
        const xScale = d3.scalePoint()
            .domain(Object.keys(groupCounts))
            .rangeRound([0, width])
            .padding(0.5);

        // Compute a global y scale based on the global counts
        const min = d3.min(globalCounts) || 0;
        const max = d3.max(globalCounts) || 1;
        const yScale = d3.scaleLinear()
            .domain([min, max])
            .range([0, height]);

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
}
