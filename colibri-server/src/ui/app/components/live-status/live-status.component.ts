import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { SocketIOService } from '../../services';

const LABELS = { connected: 'Live', connecting: 'Connecting', reconnecting: 'Offline' } as const;

/** "Live" by a green dot while the page is updated every second; grey while it is not connected. */
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
