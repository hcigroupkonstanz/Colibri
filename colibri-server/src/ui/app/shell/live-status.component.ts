import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { SocketIOService } from '../connection/socketio.service';

const LABELS = { connected: 'Live', connecting: 'Connecting', reconnecting: 'Offline' } as const;

/** Shows the socket connection state. Live feeds (AdminService.feed) arrive every second only while it is connected. */
@Component({
    selector: 'app-live-status',
    template: '<span class="live" [class.off]="!connected()" [title]="title()">{{ label() }}</span>',
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class LiveStatusComponent {
    private socketio = inject(SocketIOService);

    connected = computed(() => this.socketio.state() === 'connected');
    label = computed(() => LABELS[this.socketio.state()]);
    title = computed(() => this.connected() ? 'Updated every second' : 'Not updated until the connection is back');
}
