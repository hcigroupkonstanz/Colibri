import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterModule } from '@angular/router';
import { DatePipe } from '@angular/common';
import { SocketIOService } from '../../services';

const LABELS = {
    connecting: 'Connecting',
    connected: 'Connected',
    reconnecting: 'Reconnecting'
} as const;

@Component({
    selector: 'app-root',
    templateUrl: './root.component.html',
    styleUrls: ['./root.component.scss'],
    imports: [RouterModule],
    providers: [DatePipe],
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class RootComponent {
    private socketio = inject(SocketIOService);
    private datePipe = inject(DatePipe);

    tabs = [
        { label: 'Log', path: '/log' },
        { label: 'Clients', path: '/clients' },
        { label: 'Models', path: '/models' },
        { label: 'Server', path: '/server' },
    ];

    state = this.socketio.state;

    statusLabel = computed(() => LABELS[this.state()]);

    statusTitle = computed(() => {
        const lostAt = this.socketio.lostAt();
        return lostAt === null
            ? `${this.statusLabel()} to the server`
            : `Connection to the server lost at ${this.datePipe.transform(lostAt, 'HH:mm:ss')}`;
    });
}
