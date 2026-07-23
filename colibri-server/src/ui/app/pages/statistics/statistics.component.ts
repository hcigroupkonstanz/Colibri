
import { Component } from '@angular/core';
import { LatencyChartComponent } from '../../components/latency-chart/latency-chart.component';

@Component({
    selector: 'app-statistics',
    imports: [
    LatencyChartComponent
],
    templateUrl: './statistics.component.html',
    styleUrl: './statistics.component.scss'
})
export class StatisticsComponent { }
