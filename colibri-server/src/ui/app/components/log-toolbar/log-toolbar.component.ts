import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MenuItem } from 'primeng/api';
import { MenuModule } from 'primeng/menu';
import { SelectModule } from 'primeng/select';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { ClientService, LOG_LEVELS, LogService } from '../../services';
import { LEVEL_TAGS } from '../log-message/log-format';

/** How long typing pauses before the search runs, in ms. */
export const SEARCH_DELAY = 150;

/** A phone, upright or sideways, where the filters fold away behind a button. */
export const PHONE = '(max-width: 699.98px), (max-height: 499.98px)';

interface AppOption {
    name: string;
    /** How many of its clients are connected. */
    clients: number;
}

interface ActiveFilter {
    label: string;
    clear: () => void;
}

/** Where the log is among its errors and warnings. */
export interface LogNav {
    /** How many errors and warnings the lines shown have. */
    problems: number;
    /** The one Previous and Next went to last, counted from 1, or null. */
    position: number | null;
    /** How many errors there are since the page was opened. */
    newErrors: number;
    openedAt: number;
}

export type NavStep = 'previous' | 'next' | 'first-error';

@Component({
    selector: 'app-log-toolbar',
    templateUrl: './log-toolbar.component.html',
    styleUrls: ['./log-toolbar.component.scss'],
    imports: [FormsModule, MenuModule, SelectModule, ToggleSwitchModule],
    providers: [DatePipe],
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class LogToolbarComponent implements OnDestroy {
    log = inject(LogService);
    private clients = inject(ClientService);
    private datePipe = inject(DatePipe);

    /** Whether the log scrolls to new lines. */
    following = input(true);
    followChange = output<boolean>();
    /** How many lines match the search, or null without one. */
    matches = input<number | null>(null);
    nav = input<LogNav>({ problems: 0, position: null, newErrors: 0, openedAt: 0 });
    navigate = output<NavStep>();
    download = output<'text' | 'json'>();

    downloadItems: MenuItem[] = [
        { label: 'Text', icon: 'pi pi-file', command: () => this.download.emit('text') },
        { label: 'JSON', icon: 'pi pi-code', command: () => this.download.emit('json') }
    ];

    positionLabel = computed(() => {
        const { problems, position } = this.nav();
        return position === null ? `${problems}` : `${position}/${problems}`;
    });

    firstErrorTitle = computed(() => {
        const since = this.datePipe.transform(this.nav().openedAt, 'HH:mm:ss');
        const errors = this.nav().newErrors;
        return errors > 0
            ? `${errors} ${errors === 1 ? 'error' : 'errors'} since the page was opened at ${since}: go to the first (e)`
            : `No errors since the page was opened at ${since}`;
    });

    levelOptions = LOG_LEVELS;
    tags = LEVEL_TAGS;

    /** Whether the filters are shown on a phone, where they are folded away. */
    open = signal(false);
    /** Whether the search field has text in it. */
    typed = signal(false);

    private searchInput = viewChild.required<ElementRef<HTMLInputElement>>('searchInput');
    private searchTimer: ReturnType<typeof setTimeout> | undefined;
    // The search this field set last. The field is written only for a search set elsewhere (Clear
    // filters, a removed filter chip): writing back its own, trimmed, ate the space just typed.
    private searchSent: string | null = null;

    allLevels = computed(() => this.log.levels().size === LOG_LEVELS.length);

    // Every app seen in the log since the page loaded and every app with a client connected, so
    // that the list does not shrink to the one app being shown.
    appOptions = computed<AppOption[]>(() => {
        const counts = new Map<string, number>();
        for (const app of this.log.apps()) counts.set(app, 0);
        for (const client of this.clients.clients()) {
            if (client.app !== 'colibri') counts.set(client.app, (counts.get(client.app) ?? 0) + 1);
        }
        const filter = this.log.filter();
        if (filter && !counts.has(filter)) counts.set(filter, 0);

        return [ ...counts ]
            .map(([ name, clients ]) => ({ name, clients }))
            .sort((a, b) => a.name.localeCompare(b.name));
    });

    /** The filters folded away on a phone that are not at their defaults. */
    activeFilters = computed<ActiveFilter[]>(() => {
        const active: ActiveFilter[] = [];
        const app = this.log.filter();
        if (app) active.push({ label: `App: ${app}`, clear: () => this.log.filter.set('') });
        const search = this.log.search();
        if (search) active.push({ label: `Search: ${search}`, clear: () => this.log.search.set('') });
        if (this.log.showBroadcastTraffic()) active.push({ label: 'Sync traffic', clear: () => this.log.showBroadcastTraffic.set(false) });
        if (!this.log.showConnections()) active.push({ label: 'No connections', clear: () => this.log.showConnections.set(true) });
        return active;
    });

    constructor() {
        effect(() => {
            const search = this.log.search();
            untracked(() => {
                if (search === this.searchSent) return;
                clearTimeout(this.searchTimer);
                this.searchSent = search;
                this.searchInput().nativeElement.value = search;
                this.typed.set(search !== '');
            });
        });
    }

    /** 1234 as 1.2k: a chip keeps its width as the log grows. */
    shortCount(count: number): string {
        if (count < 1000) return `${count}`;
        if (count < 10000) return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`;
        return `${Math.round(count / 1000)}k`;
    }

    isOn(level: number): boolean {
        return this.log.levels().has(level);
    }

    toggleLevel(level: number): void {
        const levels = new Set(this.log.levels());
        if (levels.has(level)) levels.delete(level);
        else levels.add(level);
        this.log.setLevels([ ...levels ].sort());
    }

    onSearch(value: string): void {
        this.typed.set(value !== '');
        clearTimeout(this.searchTimer);
        this.searchTimer = setTimeout(() => {
            this.searchSent = value.trim();
            this.log.search.set(this.searchSent);
        }, SEARCH_DELAY);
    }

    /** Escape leaves the field; the clear button stays in it, to type the next search. */
    clearSearch(input: HTMLInputElement, stay = false): void {
        clearTimeout(this.searchTimer);
        input.value = '';
        this.typed.set(false);
        this.searchSent = '';
        this.log.search.set('');
        if (stay) input.focus();
        else input.blur();
    }

    /**
     * Previous, Next or New errors. On a phone they are in the folded filters, which close, so
     * that the log has the room to show the line; the buttons by "Jump to latest" go on from there.
     */
    step(step: NavStep): void {
        this.navigate.emit(step);
        if (window.matchMedia?.(PHONE).matches) this.open.set(false);
    }

    /** To the search field, for the log page's '/' key; on a phone, the filters open for it. */
    focusSearch(): void {
        this.open.set(true);
        this.searchInput().nativeElement.focus();
    }

    ngOnDestroy(): void {
        clearTimeout(this.searchTimer);
    }
}
