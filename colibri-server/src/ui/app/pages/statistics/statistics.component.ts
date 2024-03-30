import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { ClientListComponent } from '../../components/client-list/client-list.component';

@Component({
    selector: 'app-statistics',
    standalone: true,
    imports: [
        CommonModule,
        ClientListComponent
    ],
    templateUrl: './statistics.component.html',
    styleUrl: './statistics.component.scss',
})
export class StatisticsComponent { }
