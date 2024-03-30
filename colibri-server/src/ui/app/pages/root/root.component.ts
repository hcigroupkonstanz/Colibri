import { Component } from '@angular/core';
import { LogComponent } from '../log/log.component';
import { RouterModule } from '@angular/router';
import { FilterBarComponent } from '../../components/filter-bar/filter-bar.component';

@Component({
    selector: 'app-root',
    templateUrl: './root.component.html',
    styleUrls: ['./root.component.scss'],
    standalone: true,
    imports: [LogComponent, RouterModule, FilterBarComponent]
})
export class RootComponent {
}
