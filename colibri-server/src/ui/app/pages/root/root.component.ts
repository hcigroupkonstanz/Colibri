import { Component } from '@angular/core';
import { LogComponent } from '../../components/log/log.component';

@Component({
    selector: 'app-root',
    templateUrl: './root.component.html',
    styleUrls: ['./root.component.scss'],
    standalone: true,
    imports: [LogComponent]
})
export class RootComponent {
}
