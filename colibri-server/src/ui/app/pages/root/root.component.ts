import { Component } from '@angular/core';
import { RouterModule } from '@angular/router';
import { FilterBarComponent } from '../../components/filter-bar/filter-bar.component';


@Component({
    selector: 'app-root',
    templateUrl: './root.component.html',
    styleUrls: ['./root.component.scss'],
    imports: [RouterModule, FilterBarComponent]
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
