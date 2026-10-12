import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { LOG_LEVELS, LogMessage, LogService } from '../../services';
import { LEVEL_TAGS, appColor, highlight, isAddress, messageText, shortId, sourceOf } from './log-format';

@Component({
    selector: 'app-log-message',
    templateUrl: './log-message.component.html',
    styleUrls: ['./log-message.component.scss'],
    imports: [DatePipe, RouterLink],
    providers: [DatePipe],
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class LogMessageComponent {
    private logService = inject(LogService);
    private datePipe = inject(DatePipe);

    public log = input.required<LogMessage>();
    /** Lower-case text to highlight in the message. */
    public search = input('');
    /** Whether it is the error or warning Previous and Next went to last. */
    public current = input(false);

    public expanded = signal(false);

    source = computed(() => sourceOf(this.log()));
    tag = computed(() => LEVEL_TAGS[this.log().level] ?? 'LOG');
    levelName = computed(() => LOG_LEVELS[this.log().level]?.label ?? 'Log');
    appColor = computed(() => {
        const app = this.source().app;
        return app ? appColor(app) : null;
    });
    parts = computed(() => highlight(messageText(this.log()), this.search()));
    utc = computed(() => new Date(this.log().created).toISOString());
    clientId = computed(() => {
        const id = this.log().metadata?.['clientId'];
        return typeof id === 'string' && id !== 'UNKNOWN' ? id : null;
    });
    /** A web client by the start of its id: its name, the address, is the same for all on one host. */
    clientLabel = computed(() => {
        const client = this.source().client ?? '';
        const id = this.clientId();
        if (id && isAddress(client)) return { text: shortId(id), title: `${client}, client ${id}`, id: true };
        return { text: client, title: client, id: false };
    });
    countTitle = computed(() =>
        `${this.log().count + 1} times, first at ${this.datePipe.transform(this.log().first, 'HH:mm:ss.SSS')}`);

    onRowClick(): void {
        // a click that ends a text selection is not meant to open the row
        if (window.getSelection()?.type === 'Range') return;
        this.expanded.update(open => !open);
    }

    filterApp(event: Event, app: string): void {
        event.stopPropagation();
        this.logService.filter.set(app);
    }
}
