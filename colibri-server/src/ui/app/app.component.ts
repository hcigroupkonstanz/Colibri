import { Component } from '@angular/core';
import { SocketIOService } from './services/socketio.service';
import { LogComponent } from './components/log/log.component';

@Component({
    selector: 'app-root',
    templateUrl: './app.component.html',
    styleUrls: ['./app.component.scss'],
    standalone: true,
    imports: [LogComponent]
})
export class AppComponent {
    title = 'server-app';

    public constructor(private socketio: SocketIOService) {
    }
}
