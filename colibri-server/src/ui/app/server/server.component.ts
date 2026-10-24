import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import type { ServerSnapshot } from '../connection/admin.service';
import { AdminService } from '../connection/admin.service';
import { LiveStatusComponent } from '../shell/live-status.component';
import { OfflineBannerComponent } from '../shell/offline-banner.component';
import { serverSections } from './server-sections';

@Component({
    selector: 'app-server',
    templateUrl: './server.component.html',
    styleUrl: './server.component.scss',
    imports: [RouterLink, LiveStatusComponent, OfflineBannerComponent],
    providers: [DatePipe],
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class ServerComponent {
    private admin = inject(AdminService);
    private datePipe = inject(DatePipe);

    feed = this.admin.feed<ServerSnapshot>('server');

    sections = computed(() => {
        const snapshot = this.feed.data();
        return snapshot ? serverSections(snapshot, time => this.datePipe.transform(time, 'yyyy-MM-dd HH:mm:ss') ?? '') : [];
    });
}
