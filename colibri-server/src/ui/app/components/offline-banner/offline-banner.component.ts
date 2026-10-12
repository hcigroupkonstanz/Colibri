import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { SocketIOService } from '../../services';

/** Says, at the top of a page, that what it shows is from before the connection was lost. */
@Component({
    selector: 'app-offline-banner',
    template: `
        @if (lostAt(); as lostAt) {
          <div class="banner" role="alert">
            <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
            Connection to the server lost at {{ lostAt | date:'HH:mm:ss' }}. Reconnecting…
          </div>
        }
    `,
    styles: `
        :host {
            display: block;
        }

        .banner {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px max(16px, env(safe-area-inset-right)) 8px max(16px, env(safe-area-inset-left));

            color: var(--bg);
            background: var(--warn);
            font-size: 13px;
            font-weight: 500;
        }
    `,
    imports: [DatePipe],
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class OfflineBannerComponent {
    private socketio = inject(SocketIOService);

    /** When the connection was lost, while it is. */
    lostAt = computed(() => this.socketio.state() === 'reconnecting' ? this.socketio.lostAt() : null);
}
