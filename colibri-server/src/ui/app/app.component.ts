import { Component } from '@angular/core';
import { SocketIOService } from './services/socketio.service';

@Component({
    selector: 'app-root',
    templateUrl: './app.component.html',
    styleUrls: ['./app.component.scss']
})
export class AppComponent {
    title = 'server-app';

    public constructor(private socketio: SocketIOService) {
    }

    loadMenu() {
        this.socketio.execute('scene menu');
    }

    loadDev() {
        this.socketio.execute('scene development');
    }

    loadRelease() {
        this.socketio.execute('scene release');
    }
}
