import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, HostListener, Injector, OnDestroy, afterNextRender, afterRenderEffect, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { LOG_LEVELS, LogMessage, LogService, SocketIOService } from '../../services';
import { LogMessageComponent } from '../../components/log-message/log-message.component';
import { LogNav, LogToolbarComponent, NavStep, PHONE } from '../../components/log-toolbar/log-toolbar.component';
import { OfflineBannerComponent } from '../../components/offline-banner/offline-banner.component';
import { LEVEL_TAGS, matchesSearch, messageText, sourceOf } from '../../components/log-message/log-format';
import { download, fileNamePart } from '../../format';

/**
 * How many lines are on the page at first, and how many more each "Show older lines" adds: half
 * as many on a phone, upright or sideways. The rows have the height their text needs, so they
 * are not virtualized, and a page of 10,000 rows would take seconds to build on a phone.
 */
export const PAGE_SIZE = 1000;
const screenPageSize = (): number => window.matchMedia?.(PHONE).matches ? PAGE_SIZE / 2 : PAGE_SIZE;

/** How close to the end, in px, still counts as at the end. */
const END_SLACK = 24;

/** Whether a line is an error or a warning, which Previous and Next go through. */
const isProblem = (line: LogMessage): boolean => !line.reconnect && (line.level === 0 || line.level === 1);

/** Whether a key press is meant for a field or a list, not for the page. */
const typing = (event: KeyboardEvent): boolean =>
    event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"], [role="combobox"], [role="listbox"], [role="menu"]') !== null;

/** Whether an event is on a line, or on "Show older lines" above them. */
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

    /** Whether the page scrolls to new lines as they arrive. */
    following = signal(true);

    // While paused, the page shows the lines it had then: new lines, repeats moving to the end and
    // the oldest lines making room would all shift what is being read.
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

    /** How many lines arrived since the page was paused, not counting repeats of lines it shows. */
    newLines = computed(() => {
        if (!this.frozen()) return 0;
        const shown = this.frozenIds();
        let count = 0;
        for (const line of this.log.messages()) {
            if (!shown.has(line.id) && !line.reconnect) count++;
        }
        return count;
    });

    /** The error or warning Previous and Next went to last. */
    current = signal<string | null>(null);

    /** The errors and warnings among the lines, oldest first. */
    private problems = computed(() => this.matches().filter(isProblem).map(line => line.id));

    /** The errors since the page was opened, oldest first. */
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

    /** The rows that start a new day, which get the date above them. */
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
            // by then the address is this page's, not the one it came from
            this.log.openPage();
            // The keys below work with the focus in the log. On a page just loaded, nothing has the
            // focus yet: the log takes it, so that they work from the start.
            if (document.activeElement === null || document.activeElement === document.body) {
                this.scroller().nativeElement.focus({ preventScroll: true });
            }
        });

        afterRenderEffect(() => {
            this.rows();
            if (this.following()) this.scrollToEnd();
        });

        // The server sends a new history for new filters; the paused lines were filtered by the old.
        effect(() => {
            this.log.filter();
            this.log.levels();
            this.log.showBroadcastTraffic();
            this.log.showConnections();
            untracked(() => this.follow());
        });
    }

    ngAfterViewInit(): void {
        // a new height (a rotated phone, the filters opening) would leave the end out of view
        this.resizeObserver = new ResizeObserver(() => {
            if (this.following()) this.scrollToEnd();
        });
        this.resizeObserver.observe(this.scroller().nativeElement);

        // passive, so that the browser never waits for these before it scrolls
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
     * To the next or previous error or warning, round from the last to the first. The first goes
     * from what is in view: Next to the first at or below its top, Previous to the last at or
     * above its end, which, at the end of the log, is the latest.
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

    // Pauses, so that the line stays where it is, and shows as many older lines as it takes.
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

    // Scrolls the log, and only the log, to have the row in its middle. scrollIntoView() scrolled
    // the page around it as well, which on a phone held sideways pushed the toolbar out of view.
    private center(row: HTMLElement): void {
        const el = this.scroller().nativeElement;
        const top = row.getBoundingClientRect().top - el.getBoundingClientRect().top;
        el.scrollTop += top - (el.clientHeight - row.offsetHeight) / 2;
    }

    // The first and last line at least partly in view, by their place in matches().
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

    // '/' to the search, n and p to the next and previous error or warning, as in many developer
    // tools, and e to the first new error. Only with the focus in the log or its toolbar: single
    // character keys that worked anywhere on the page would also take a key meant for something
    // else, or a word said to speech input (WCAG 2.1.4).
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

    /** The loaded lines that match the filters and the search, as a file. */
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

    // Any way of scrolling up pauses: wheel, touch, keys or the scroll bar. The height check tells
    // them from the list changing size under the scroll position. Back at the end, it follows again.
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

    // The wheel and a finger pause at once, before the first scroll event: under a busy stream, the
    // next batch of lines would otherwise scroll back to the end under the reader.
    private onWheel = (event: WheelEvent): void => {
        const el = this.scroller().nativeElement;
        if (event.deltaY < 0 && el.scrollHeight > el.clientHeight) this.pause();
    };

    private touchY = 0;

    private onTouchStart = (event: TouchEvent): void => {
        this.touchY = event.touches[0]?.clientY ?? 0;
    };

    // a finger moving down scrolls the log up
    private onTouchMove = (event: TouchEvent): void => {
        const el = this.scroller().nativeElement;
        const y = event.touches[0]?.clientY ?? 0;
        if (y > this.touchY + 8 && el.scrollHeight > el.clientHeight) this.pause();
    };

    // Pressing the mouse on a line is the start of reading, selecting or opening it.
    onPointerDown(event: PointerEvent): void {
        if (event.pointerType === 'mouse' && event.button === 0 && onLine(event)) this.pause();
    }

    // A tap opens a line, and the lines stay still while it is read. Not a button of the empty
    // state: "Clear search" left the log paused.
    onClick(event: MouseEvent): void {
        if (!onLine(event)) return;
        this.pause();

        // Once paused, the "Jump to latest" button covers the bottom of the log, where the newest
        // line, the one opened most, is. Its scroll-padding makes this move the line above it.
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

/** A time as the browser's local yyyy-MM-dd HH:mm:ss.SSS, as the page shows it. */
const localTime = function (time: number): string {
    const d = new Date(time);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};

const fileStamp = function (date: Date): string {
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
};

/** One line of the text download: time, level, source and message, continued lines indented. */
export const textLine = function (line: LogMessage): string {
    const source = sourceOf(line);
    const id = line.metadata?.['clientId'];
    const who = source.app || source.client
        ? [ source.app, source.client, typeof id === 'string' && id !== 'UNKNOWN' ? `(${id})` : undefined ].filter(Boolean).join(' ')
        : source.server;
    const repeated = line.count > 0 ? ` [${line.count + 1} times since ${localTime(line.first)}]` : '';
    return `${localTime(line.created)} ${LEVEL_TAGS[line.level] ?? 'LOG'} ${who}: ${messageText(line).replace(/\n/g, '\n    ')}${repeated}`;
};
