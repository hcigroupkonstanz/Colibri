import { Component } from '@angular/core';
import { LogComponent } from '../log/log.component';
import { RouterModule } from '@angular/router';
import { FilterBarComponent } from '../../components/filter-bar/filter-bar.component';
import { CommonModule } from '@angular/common';

@Component({
    selector: 'app-root',
    templateUrl: './root.component.html',
    styleUrls: ['./root.component.scss'],
    standalone: true,
    imports: [LogComponent, RouterModule, FilterBarComponent, CommonModule]
})
export class RootComponent {
    tabs = [
        { label: 'Log', path: '/log' },
        { label: 'Statistics', path: '/statistics' },
    ];

    getIndicatorPosition() {
        const index = this.tabs.indexOf(this.tabs.find(tab => tab.path === location.pathname) || this.tabs[0]);
        return `${index * 120}px`;
    }
}
