import type { AfterViewInit, ElementRef, OnDestroy } from '@angular/core';
import { ChangeDetectionStrategy, Component, HostListener, Injector, afterNextRender, afterRenderEffect, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import type { LogMessage } from './log.service';
import { LOG_LEVELS, LogService } from './log.service';
import { SocketIOService } from '../connection/socketio.service';
import { LogMessageComponent } from './log-message.component';
import type { LogNav, NavStep } from './log-toolbar.component';
import { LogToolbarComponent, PHONE } from './log-toolbar.component';
import { OfflineBannerComponent } from '../shell/offline-banner.component';
import { LEVEL_TAGS, matchesSearch, messageText, sourceOf } from './log-format';
import { download, fileNamePart } from '../download';

/**
 * Lines shown at first and added by each "Show older lines"; half as many on a phone. Rows are
 * not virtualized (their height follows their text), so this bounds the DOM size.
 */
export const PAGE_SIZE = 1000;
const screenPageSize = (): number => window.matchMedia?.(PHONE).matches ? PAGE_SIZE / 2 : PAGE_SIZE;

/** Distance from the end, in px, that still counts as at the end. */
const END_SLACK = 24;

/** Error or warning: the lines Previous and Next step through. */
const isProblem = (line: LogMessage): boolean => !line.reconnect && (line.level === 0 || line.level === 1);

/** The key press is for a form control or popup, not for the page shortcuts. */
const typing = (event: KeyboardEvent): boolean =>
    event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"], [role="combobox"], [role="listbox"], [role="menu"]') !== null;

/** The event is on a line or on the "Show older lines" button. */
const onLine = (event: Event): boolean =>
    event.target instanceof Element && event.target.closest('app-log-message, .older') !== null;

interface EmptyState {
    text: string;
    action?: { label: string; run: () => void };
}

@Component({
    selector: 'app-log',
    templateUrl: './log.component.html',
    styleUrls: ['./log.component.scss'],
    imports: [DatePipe, LogMessageComponent, LogToolbarComponent, OfflineBannerComponent],
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class LogComponent implements AfterViewInit, OnDestroy {
    log = inject(LogService);
    private socketio = inject(SocketIOService);
    private injector = inject(Injector);

    private scroller = viewChild.required<ElementRef<HTMLElement>>('scroller');
    private toolbar = viewChild.required(LogToolbarComponent);

    following = signal(true);

    // Snapshot taken on pause. New lines, repeats moving to the end and eviction of the oldest
    // would shift the lines being read.
    private frozen = signal<ReadonlyArray<LogMessage> | null>(null);
    private frozenIds = computed(() => new Set(this.frozen()?.map(line => line.id)));
    private readonly pageSize = screenPageSize();
    private limit = signal(this.pageSize);

    search = computed(() => this.log.search().toLowerCase());

    matches = computed(() => {
        const lines = this.frozen() ?? this.log.messages();
        const search = this.search();
        return search ? lines.filter(line => matchesSearch(line, search)) : lines;
    });

    rows = computed(() => {
        const matches = this.matches();
        const limit = this.limit();
        return matches.length > limit ? matches.slice(-limit) : matches;
    });

    hidden = computed(() => this.matches().length - this.rows().length);
    olderStep = computed(() => Math.min(this.pageSize, this.hidden()));

    /** Lines that arrived since pausing; repeats of lines in the snapshot and reconnect rows do not count. */
    newLines = computed(() => {
        if (!this.frozen()) return 0;
        const shown = this.frozenIds();
        let count = 0;
        for (const line of this.log.messages()) {
            if (!shown.has(line.id) && !line.reconnect) count++;
        }
        return count;
    });

    /** Id of the error or warning that Previous and Next went to last. */
    current = signal<string | null>(null);

    /** Ids of the errors and warnings among the matches, oldest first. */
    private problems = computed(() => this.matches().filter(isProblem).map(line => line.id));

    /** Ids of the errors created since the page was opened, oldest first. */
    private newErrors = computed(() => {
        const openedAt = this.log.openedAt();
        return this.matches().filter(line => !line.reconnect && line.level === 0 && line.created >= openedAt).map(line => line.id);
    });

    nav = computed<LogNav>(() => {
        const problems = this.problems();
        const current = this.current();
        const position = current === null ? -1 : problems.indexOf(current);
        return {
            problems: problems.length,
            position: position < 0 ? null : position + 1,
            newErrors: this.newErrors().length,
            openedAt: this.log.openedAt()
        };
    });

    /** Ids of the rows that start a new day; the template puts a date header above them. */
    dayStarts = computed(() => {
        const starts = new Set<string>();
        let previous = '';
        for (const row of this.rows()) {
            const day = new Date(row.created).toDateString();
            if (day !== previous) starts.add(row.id);
            previous = day;
        }
        return starts;
    });

    empty = computed<EmptyState | null>(() => {
        if (this.rows().length > 0) return null;
        if (this.socketio.state() === 'connecting') return { text: 'Connecting to the server…' };
        if (this.log.loading()) return { text: 'Loading the log…' };

        const clear = { label: 'Clear filters', run: () => this.log.clearFilters() };
        if (this.log.levels().size === 0) return { text: 'All levels are hidden.', action: clear };
        if (this.search()) return { text: `No lines match "${this.log.search()}".`, action: { label: 'Clear search', run: () => this.log.search.set('') } };
        if (this.log.filter()) return { text: `No lines from ${this.log.filter()} at these levels.`, action: clear };
        return { text: 'No log lines yet.' };
    });

    private lastTop = 0;
    private lastHeight = 0;
    private resizeObserver: ResizeObserver | undefined;

    constructor() {
        afterNextRender(() => {
            // By now location.search and location.hash are this page's, not the previous page's.
            this.log.openPage();
            // The shortcuts need focus in the log, which a freshly loaded page does not have.
            if (document.activeElement === null || document.activeElement === document.body) {
                this.scroller().nativeElement.focus({ preventScroll: true });
            }
        });

        afterRenderEffect(() => {
            this.rows();
            if (this.following()) this.scrollToEnd();
        });

        // New filters make the server send a new history, so a frozen snapshot would be stale.
        effect(() => {
            this.log.filter();
            this.log.levels();
            this.log.showBroadcastTraffic();
            this.log.showConnections();
            untracked(() => this.follow());
        });
    }

    ngAfterViewInit(): void {
        // A new height (rotated phone, filters opening) would leave the end out of view.
        this.resizeObserver = new ResizeObserver(() => {
            if (this.following()) this.scrollToEnd();
        });
        this.resizeObserver.observe(this.scroller().nativeElement);

        // Passive: the browser does not wait for these handlers before it scrolls.
        const el = this.scroller().nativeElement;
        el.addEventListener('wheel', this.onWheel, { passive: true });
        el.addEventListener('touchstart', this.onTouchStart, { passive: true });
        el.addEventListener('touchmove', this.onTouchMove, { passive: true });
    }

    ngOnDestroy(): void {
        this.log.closePage();
        this.resizeObserver?.disconnect();
        const el = this.scroller().nativeElement;
        el.removeEventListener('wheel', this.onWheel);
        el.removeEventListener('touchstart', this.onTouchStart);
        el.removeEventListener('touchmove', this.onTouchMove);
    }

    pause(): void {
        if (!this.following()) return;
        this.frozen.set(this.log.messages());
        this.following.set(false);
    }

    follow(): void {
        this.frozen.set(null);
        this.limit.set(this.pageSize);
        this.current.set(null);
        this.following.set(true);
    }

    /**
     * Goes to the next or previous error or warning, wrapping around; 'first-error' goes to the
     * first error since the page was opened. Without a current one among the matches, Next takes the
     * first at or below the top of the view and Previous the last at or above its end.
     */
    navigate(step: NavStep): void {
        if (step === 'first-error') {
            const [ id ] = this.newErrors();
            if (id !== undefined) this.goTo(id);
            return;
        }

        const problems = this.problems();
        if (problems.length === 0) return;
        const direction = step === 'next' ? 1 : -1;
        const at = this.current() === null ? -1 : problems.indexOf(this.current()!);
        if (at >= 0) {
            this.goTo(problems[(at + direction + problems.length) % problems.length]);
            return;
        }

        const index = new Map(this.matches().map((line, i) => [ line.id, i ]));
        const [ top, bottom ] = this.inView(index);
        const before = problems.filter(id => index.get(id)! <= bottom);
        const target = direction > 0
            ? problems.find(id => index.get(id)! >= top) ?? problems[0]
            : before[before.length - 1] ?? problems[problems.length - 1];
        this.goTo(target);
    }

    // Pauses so the line stays put, and shows as many older lines as it takes to reach it.
    private goTo(id: string): void {
        this.pause();
        const matches = this.matches();
        const fromEnd = matches.length - matches.findIndex(line => line.id === id);
        if (fromEnd > this.limit()) this.limit.set(Math.ceil(fromEnd / this.pageSize) * this.pageSize);
        this.current.set(id);

        afterNextRender(() => {
            const row = Array.from(this.scroller().nativeElement.querySelectorAll<HTMLElement>('app-log-message[data-id]'))
                .find(element => element.dataset['id'] === id);
            if (!row) return;
            this.center(row);
            row.querySelector<HTMLElement>('.time')?.focus({ preventScroll: true });
        }, { injector: this.injector });
    }

    // Centers the row in the log. Not scrollIntoView(), which scrolls the page around it as well.
    private center(row: HTMLElement): void {
        const el = this.scroller().nativeElement;
        const top = row.getBoundingClientRect().top - el.getBoundingClientRect().top;
        el.scrollTop += top - (el.clientHeight - row.offsetHeight) / 2;
    }

    // Indexes in matches() of the first and last line at least partly in view; the whole range if none is.
    private inView(index: ReadonlyMap<string, number>): [ number, number ] {
        const el = this.scroller().nativeElement;
        const box = el.getBoundingClientRect();
        let top = Infinity;
        let bottom = -Infinity;
        for (const row of Array.from(el.querySelectorAll<HTMLElement>('app-log-message[data-id]'))) {
            const rect = row.getBoundingClientRect();
            if (rect.bottom <= box.top || rect.top >= box.bottom) continue;
            const at = index.get(row.dataset['id']!);
            if (at === undefined) continue;
            top = Math.min(top, at);
            bottom = Math.max(bottom, at);
        }
        return top === Infinity ? [ 0, index.size - 1 ] : [ top, bottom ];
    }

    // '/' focuses the search, n and p step through errors and warnings, e goes to the first new
    // error. Host listener, so only with focus in the log or its toolbar: single-character
    // shortcuts anywhere on the page would clash with other keys and speech input (WCAG 2.1.4).
    @HostListener('keydown', [ '$event' ])
    onKey(event: KeyboardEvent): void {
        if (event.ctrlKey || event.metaKey || event.altKey || typing(event)) return;
        if (event.key === '/') {
            event.preventDefault();
            this.toolbar().focusSearch();
            return;
        }
        const step = ({ n: 'next', p: 'previous', e: 'first-error' } as const)[event.key as 'n' | 'p' | 'e'];
        if (!step) return;
        event.preventDefault();
        this.navigate(step);
    }

    /** Saves the loaded lines that match the filters and the search as a file. */
    download(format: 'text' | 'json'): void {
        const search = this.search();
        const lines = this.log.messages().filter(line => !line.reconnect && (!search || matchesSearch(line, search)));
        const stamp = new Date();
        const name = `colibri-log${this.log.filter() ? '-' + fileNamePart(this.log.filter()) : ''}-${fileStamp(stamp)}`;
        const filters = {
            app: this.log.filter(),
            levels: [ ...this.log.levels() ].sort().map(level => LOG_LEVELS[level].label.toLowerCase()),
            search: this.log.search(),
            syncTraffic: this.log.showBroadcastTraffic(),
            connections: this.log.showConnections()
        };

        if (format === 'json') {
            const body = { server: location.host, exported: stamp.toISOString(), filters, lines };
            download(`${name}.json`, JSON.stringify(body, null, 2), 'application/json');
            return;
        }

        const header = [
            `# Colibri log from ${location.host}, saved ${localTime(stamp.getTime())}`,
            `# App: ${filters.app || 'all'}. Levels: ${filters.levels.join(', ') || 'none'}.` +
                (filters.search ? ` Search: ${filters.search}.` : '') +
                ` Sync traffic ${filters.syncTraffic ? 'shown' : 'hidden'}. Connections ${filters.connections ? 'shown' : 'hidden'}.`,
            `# ${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`
        ];
        download(`${name}.txt`, [ ...header, ...lines.map(textLine) ].join('\n') + '\n', 'text/plain');
    }

    showOlder(): void {
        this.limit.update(limit => limit + this.pageSize);
    }

    // Scrolling up pauses (wheel, touch, keys and scroll bar alike); back at the end it follows again.
    // An unchanged scrollHeight tells a user scroll from the list resizing under the scroll position.
    onScroll(): void {
        const el = this.scroller().nativeElement;
        const sameContent = el.scrollHeight === this.lastHeight;
        const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight <= END_SLACK;

        if (sameContent && !atEnd && el.scrollTop < this.lastTop - 1) {
            this.pause();
        } else if (sameContent && atEnd && el.scrollTop > this.lastTop && !this.following()) {
            this.follow();
        }

        this.lastTop = el.scrollTop;
        this.lastHeight = el.scrollHeight;
    }

    // Wheel and touch pause before the first scroll event; on a busy stream the next batch would
    // otherwise scroll back to the end first.
    private onWheel = (event: WheelEvent): void => {
        const el = this.scroller().nativeElement;
        if (event.deltaY < 0 && el.scrollHeight > el.clientHeight) this.pause();
    };

    private touchY = 0;

    private onTouchStart = (event: TouchEvent): void => {
        this.touchY = event.touches[0]?.clientY ?? 0;
    };

    // A finger moving down scrolls the log up.
    private onTouchMove = (event: TouchEvent): void => {
        const el = this.scroller().nativeElement;
        const y = event.touches[0]?.clientY ?? 0;
        if (y > this.touchY + 8 && el.scrollHeight > el.clientHeight) this.pause();
    };

    // A mouse press (primary button) on a line starts reading, selecting or opening it.
    onPointerDown(event: PointerEvent): void {
        if (event.pointerType === 'mouse' && event.button === 0 && onLine(event)) this.pause();
    }

    // Opening a line or showing older lines pauses, so the view stays put. onLine() leaves out the
    // empty state's buttons.
    onClick(event: MouseEvent): void {
        if (!onLine(event)) return;
        this.pause();

        // "Jump to latest" shows once paused and covers the bottom of the log, where the newest line
        // is; scroll-padding-bottom on the paused scroller keeps this scroll clear of it.
        const line = (event.target as Element).closest('app-log-message');
        if (line) afterNextRender(() => line.scrollIntoView({ block: 'nearest' }), { injector: this.injector });
    }

    private scrollToEnd(): void {
        const el = this.scroller().nativeElement;
        el.scrollTop = el.scrollHeight;
        this.lastTop = el.scrollTop;
        this.lastHeight = el.scrollHeight;
    }
}

const pad = (value: number, length = 2): string => `${value}`.padStart(length, '0');

/** Local time as yyyy-MM-dd HH:mm:ss.SSS, the format the page shows. */
const localTime = function (time: number): string {
    const d = new Date(time);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};

const fileStamp = function (date: Date): string {
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
};

/** One line of the text download; continuation lines of a message are indented. */
export const textLine = function (line: LogMessage): string {
    const source = sourceOf(line);
    const id = line.metadata?.['clientId'];
    const who = source.app || source.client
        ? [ source.app, source.client, typeof id === 'string' && id !== 'UNKNOWN' ? `(${id})` : undefined ].filter(Boolean).join(' ')
        : source.server;
    const repeated = line.count > 0 ? ` [${line.count + 1} times since ${localTime(line.first)}]` : '';
    return `${localTime(line.created)} ${LEVEL_TAGS[line.level] ?? 'LOG'} ${who}: ${messageText(line).replace(/\n/g, '\n    ')}${repeated}`;
};
