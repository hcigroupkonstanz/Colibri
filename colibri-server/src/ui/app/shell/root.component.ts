import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterModule } from '@angular/router';
import { DatePipe } from '@angular/common';
import { SocketIOService } from '../connection/socketio.service';

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
    private readonly socketio = inject(SocketIOService);
    private readonly datePipe = inject(DatePipe);

    protected readonly tabs = [
        { label: 'Log', path: '/log' },
        { label: 'Clients', path: '/clients' },
        { label: 'Models', path: '/models' },
        { label: 'Server', path: '/server' },
    ];

    protected readonly state = this.socketio.state;

    protected readonly statusLabel = computed(() => LABELS[this.state()]);

    protected readonly statusTitle = computed(() => {
        const lostAt = this.socketio.lostAt();
        return lostAt === null
            ? `${this.statusLabel()} to the server`
            : `Connection to the server lost at ${this.datePipe.transform(lostAt, 'HH:mm:ss')}`;
    });
}
