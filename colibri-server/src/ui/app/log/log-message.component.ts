import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import type { LogMessage } from './log.service';
import { LOG_LEVELS, LogService } from './log.service';
import { LEVEL_TAGS, appColor, highlight, isAddress, messageText, shortId, sourceOf } from './log-format';

@Component({
    selector: 'app-log-message',
    templateUrl: './log-message.component.html',
    styleUrls: ['./log-message.component.scss'],
    imports: [DatePipe, RouterLink],
    // DatePipe has no root provider, so inject(DatePipe) needs this one.
    providers: [DatePipe],
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class LogMessageComponent {
    private readonly logService = inject(LogService);
    private readonly datePipe = inject(DatePipe);

    public readonly log = input.required<LogMessage>();
    /** Text to highlight in the message. Must be lower case. */
    public readonly search = input('');
    /** Marks the row that Previous and Next went to last. */
    public readonly current = input(false);

    protected readonly expanded = signal(false);

    protected readonly source = computed(() => sourceOf(this.log()));
    protected readonly tag = computed(() => LEVEL_TAGS[this.log().level] ?? 'LOG');
    protected readonly levelName = computed(() => LOG_LEVELS[this.log().level]?.label ?? 'Log');
    protected readonly appColor = computed(() => {
        const app = this.source().app;
        return app ? appColor(app) : null;
    });
    protected readonly parts = computed(() => highlight(messageText(this.log()), this.search()));
    protected readonly utc = computed(() => new Date(this.log().created).toISOString());
    protected readonly clientId = computed(() => {
        // The server writes UNKNOWN for a client without an id.
        const id = this.log().metadata?.['clientId'];
        return typeof id === 'string' && id !== 'UNKNOWN' ? id : null;
    });
    /** Web clients on one host share an address as their name, so they are labelled by the start of their id, if known. */
    protected readonly clientLabel = computed(() => {
        const client = this.source().client ?? '';
        const id = this.clientId();
        if (id && isAddress(client)) return { text: shortId(id), title: `${client}, client ${id}`, id: true };
        return { text: client, title: client, id: false };
    });
    protected readonly countTitle = computed(() =>
        `${this.log().count + 1} times, first at ${this.datePipe.transform(this.log().first, 'HH:mm:ss.SSS')}`);

    protected onRowClick(): void {
        // A click that ends a text selection does not toggle the row.
        if (window.getSelection()?.type === 'Range') return;
        this.expanded.update(open => !open);
    }

    protected filterApp(event: Event, app: string): void {
        event.stopPropagation();
        this.logService.filter.set(app);
    }
}
