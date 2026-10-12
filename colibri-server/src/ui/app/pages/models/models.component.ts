import { ChangeDetectionStrategy, Component, ElementRef, HostListener, Injector, OnDestroy, afterNextRender, computed, effect, inject, signal, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { SelectModule } from 'primeng/select';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { AdminService, ModelRow, ModelSnapshot, ModelsSnapshot } from '../../services';
import { OfflineBannerComponent } from '../../components/offline-banner/offline-banner.component';
import { bytes, count, download, duration, fileNamePart } from '../../format';

/** Models a page of the list shows. */
export const MODELS_PAGE_SIZE = 50;

/** Deleted ids shown until all are asked for. */
export const DELETED_SHOWN = 10;

/** How long typing in the filter pauses before the list is asked for, in ms. */
export const FILTER_DELAY = 300;

/** Formatted JSON up to this length is coloured; longer is shown plain, which is faster. */
export const HIGHLIGHT_LIMIT = 64 * 1024;

export interface ModelKey {
    app: string;
    channel: string;
    id: string;
}

export interface JsonPart {
    text: string;
    kind: 'key' | 'string' | 'number' | 'literal' | null;
}

const JSON_TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/** Splits formatted JSON into keys, strings, numbers and literals, to colour them. */
export const jsonParts = function (json: string): JsonPart[] {
    if (json.length > HIGHLIGHT_LIMIT) return [ { text: json, kind: null } ];

    const parts: JsonPart[] = [];
    let from = 0;
    for (const match of json.matchAll(JSON_TOKEN)) {
        const at = match.index;
        if (at > from) parts.push({ text: json.slice(from, at), kind: null });
        if (match[1] !== undefined) {
            parts.push({ text: match[1], kind: match[2] !== undefined ? 'key' : 'string' });
            if (match[2] !== undefined) parts.push({ text: match[2], kind: null });
        } else {
            parts.push({ text: match[0], kind: match[3] !== undefined ? 'literal' : 'number' });
        }
        from = at + match[0].length;
    }
    if (from < json.length) parts.push({ text: json.slice(from), kind: null });
    return parts;
};

const sameKey = (a: ModelKey | null, b: ModelKey | null): boolean =>
    a === b || (a !== null && b !== null && a.app === b.app && a.channel === b.channel && a.id === b.id);

const rowKey = (model: ModelKey): string => `${model.app}\n${model.channel}\n${model.id}`;

/** Whether the element is one the keyboard is still on: in the page and shown. */
const holdsFocus = function (element: Element | null): boolean {
    if (!element || element === document.body || !element.isConnected) return false;
    return typeof element.checkVisibility !== 'function' || element.checkVisibility();
};

interface AppOption {
    name: string;
    models: number;
    deleted: number;
}

interface ChannelOption {
    name: string;
    label: string;
}

@Component({
    selector: 'app-models',
    templateUrl: './models.component.html',
    styleUrl: './models.component.scss',
    imports: [DatePipe, FormsModule, RouterLink, SelectModule, ToggleSwitchModule, OfflineBannerComponent],
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class ModelsComponent implements OnDestroy {
    private admin = inject(AdminService);
    private route = inject(ActivatedRoute);
    private router = inject(Router);
    private host = inject<ElementRef<HTMLElement>>(ElementRef);
    private injector = inject(Injector);

    private params = toSignal(this.route.queryParamMap, { requireSync: true });
    app = computed(() => this.params().get('app') ?? '');
    channel = computed(() => this.params().get('channel') ?? '');
    filter = computed(() => this.params().get('q') ?? '');
    page = computed(() => Math.max(1, Math.trunc(Number(this.params().get('page') ?? '1')) || 1));
    /** Whether the list and the open model are updated every second. */
    live = computed(() => this.params().get('live') === '1');

    /** The model the detail shows. */
    open = computed<ModelKey | null>(() => {
        const id = this.params().get('model');
        if (id === null) return null;
        return { app: this.params().get('modelApp') ?? this.app(), channel: this.params().get('modelChannel') ?? this.channel(), id };
    }, { equal: sameKey });

    list = this.admin.feed<ModelsSnapshot>('models', {
        query: () => ({
            app: this.app(),
            channel: this.channel(),
            filter: this.filter(),
            offset: (this.page() - 1) * MODELS_PAGE_SIZE,
            limit: MODELS_PAGE_SIZE
        }),
        live: () => this.live()
    });

    detail = this.admin.feed<ModelSnapshot>('model', {
        query: () => {
            const open = this.open();
            return open ? { app: open.app, channel: open.channel, id: open.id } : null;
        },
        live: () => this.live()
    });

    /** Every app with models or deleted ids, and the one filtered to. */
    appOptions = computed<AppOption[]>(() => {
        const apps = new Map<string, AppOption>();
        for (const summary of this.list.data()?.channels ?? []) {
            const app = apps.get(summary.app) ?? { name: summary.app, models: 0, deleted: 0 };
            app.models += summary.models;
            app.deleted += summary.deleted;
            apps.set(summary.app, app);
        }
        const app = this.app();
        if (app && !apps.has(app)) apps.set(app, { name: app, models: 0, deleted: 0 });
        return [ ...apps.values() ].sort((a, b) => a.name.localeCompare(b.name));
    });

    /** The channels of the app, or of every app. */
    channelOptions = computed<ChannelOption[]>(() => {
        const app = this.app();
        const channels = new Map<string, number>();
        for (const summary of this.list.data()?.channels ?? []) {
            if (app && summary.app !== app) continue;
            channels.set(summary.channel, (channels.get(summary.channel) ?? 0) + summary.models);
        }
        const channel = this.channel();
        if (channel && !channels.has(channel)) channels.set(channel, 0);
        return [ ...channels ]
            .map(([ name, models ]) => ({ name, label: `${count(models)} ${models === 1 ? 'model' : 'models'}` }))
            .sort((a, b) => a.name.localeCompare(b.name));
    });

    /** Whether the list shows one channel, so its rows need not say which. */
    oneChannel = computed(() => this.app() !== '' && this.channel() !== '');

    filtered = computed(() => this.app() !== '' || this.channel() !== '' || this.filter() !== '');

    summary = computed(() => {
        const data = this.list.data();
        if (!data) return '';
        const all = data.channels.reduce((sum, summary) => sum + summary.models, 0);
        if (this.filtered()) return `${count(data.total)} of ${count(all)} match`;
        const apps = new Set(data.channels.filter(summary => summary.models > 0).map(summary => summary.app)).size;
        const channels = data.channels.filter(summary => summary.models > 0).length;
        return `${count(data.total)} in ${count(channels)} ${channels === 1 ? 'channel' : 'channels'} of ${count(apps)} ${apps === 1 ? 'app' : 'apps'}`;
    });

    /** 51-100 of 1,234. */
    range = computed(() => {
        const data = this.list.data();
        if (!data || data.total === 0) return '';
        const first = data.query.offset + 1;
        const last = data.query.offset + data.models.length;
        return `${count(first)}-${count(last)} of ${count(data.total)}`;
    });

    pages = computed(() => Math.max(1, Math.ceil((this.list.data()?.total ?? 0) / MODELS_PAGE_SIZE)));

    rows = computed(() => {
        const data = this.list.data();
        if (!data) return [];
        const open = this.open();
        return data.models.map(model => ({
            ...model,
            key: rowKey(model),
            size: model.bytes === null ? null : bytes(model.bytes),
            age: duration((data.at - model.updatedAt) / 1000),
            open: open !== null && open.app === model.app && open.channel === model.channel && open.id === model.id
        }));
    });

    deleted = computed(() => {
        const data = this.list.data();
        if (!data) return [];
        return data.deleted.map(row => ({ ...row, key: rowKey(row), age: duration((data.at - row.deletedAt) / 1000) }));
    });

    readonly DELETED_SHOWN = DELETED_SHOWN;
    /** Whether every deleted id the server sent is shown, not only the newest. */
    allDeleted = signal(false);
    deletedShown = computed(() => this.allDeleted() ? this.deleted() : this.deleted().slice(0, DELETED_SHOWN));

    /** Whether the page asked for is past the end, after models were deleted or the filter changed. */
    pastEnd = computed(() => {
        const data = this.list.data();
        return data !== null && data.total > 0 && data.models.length === 0;
    });

    empty = computed(() => {
        const data = this.list.data();
        if (!data) return 'Loading the models…';
        if (this.pastEnd()) return `Page ${this.page()} is past the end.`;
        if (data.total > 0) return null;
        if (this.filter()) return `No models match "${this.filter()}".`;
        if (this.app() || this.channel()) return 'No models in this channel.';
        return 'The server holds no synced models.';
    });

    /** The open model's snapshot, once it is the one asked for. */
    model = computed(() => {
        const data = this.detail.data();
        const open = this.open();
        return data && open && data.app === open.app && data.channel === open.channel && data.id === open.id ? data : null;
    });

    private json = computed(() => this.model()?.json ?? '');
    jsonParts = computed(() => jsonParts(this.json()));

    modelAge = computed(() => {
        const model = this.model();
        if (!model) return '';
        const time = model.found ? model.updatedAt : model.deletedAt;
        return time === undefined ? '' : duration((model.at - time) / 1000);
    });

    size = bytes;

    /** What the filter field shows: what is typed, until it is sent. */
    filterText = signal('');
    private filterTimer: ReturnType<typeof setTimeout> | undefined;

    constructor() {
        effect(() => {
            const filter = this.filter();
            untracked(() => {
                clearTimeout(this.filterTimer);
                this.filterText.set(filter);
            });
        });

        // Below 1100px the open model replaces the list: opening one hides the link that opened it,
        // and closing it removes the Back button. Either left the keyboard on the page's body.
        let shown: ModelKey | null | undefined;
        effect(() => {
            const open = this.open();
            const closed = shown;
            shown = open;
            // not on the page's first model, or none: nothing had the focus to lose
            if (closed === undefined) return;
            afterNextRender(() => this.keepFocus(open, closed), { injector: this.injector });
        });
    }

    private keepFocus(open: ModelKey | null, closed: ModelKey | null): void {
        if (holdsFocus(document.activeElement)) return;
        const host = this.host.nativeElement;
        if (open) {
            host.querySelector<HTMLElement>('#model-title')?.focus();
        } else if (closed) {
            const key = rowKey(closed);
            Array.from(host.querySelectorAll<HTMLElement>('.models-table a.id')).find(link => link.dataset['key'] === key)?.focus();
        }
    }

    ngOnDestroy(): void {
        clearTimeout(this.filterTimer);
    }

    setApp(app: string): void {
        void this.navigate({ app: app || null, channel: null, page: null });
    }

    setChannel(channel: string): void {
        void this.navigate({ channel: channel || null, page: null });
    }

    onFilter(value: string): void {
        this.filterText.set(value);
        clearTimeout(this.filterTimer);
        this.filterTimer = setTimeout(() => void this.navigate({ q: value.trim() || null, page: null }), FILTER_DELAY);
    }

    clearFilter(): void {
        clearTimeout(this.filterTimer);
        this.filterText.set('');
        void this.navigate({ q: null, page: null });
    }

    setPage(page: number): Promise<boolean> {
        return this.navigate({ page: page > 1 ? `${page}` : null });
    }

    setLive(live: boolean): void {
        void this.navigate({ live: live ? '1' : null });
    }

    refresh(): void {
        this.list.refresh();
        if (this.open()) this.detail.refresh();
    }

    /** The address of a model's detail, with the list as it is. */
    modelParams(model: ModelKey): Record<string, string> {
        return { model: model.id, modelApp: model.app, modelChannel: model.channel };
    }

    openModel(model: ModelRow): void {
        if (model.truncated) return;
        void this.router.navigate([], { relativeTo: this.route, queryParams: this.modelParams(model), queryParamsHandling: 'merge' });
    }

    @HostListener('document:keydown.escape', [ '$event' ])
    close(event?: Event): void {
        if (!this.open()) return;
        // Escape in the filter clears it, and in an open list closes the list
        if (event?.target instanceof Element && event.target.closest('input[type="search"], [role="combobox"], [role="listbox"]')) return;
        void this.navigate({ model: null, modelApp: null, modelChannel: null }, false);
    }

    /** The value as a .json file; its start, cut at 512 KiB, as a -partial.txt, since that is no valid JSON. */
    downloadModel(): void {
        const model = this.model();
        if (!model?.json) return;
        const name = `${fileNamePart(model.app)}-${fileNamePart(model.channel)}-${fileNamePart(model.id)}`;
        if (model.truncated) download(`${name}-partial.txt`, model.json, 'text/plain');
        else download(`${name}.json`, model.json, 'application/json');
    }

    private navigate(queryParams: Record<string, string | null>, replaceUrl = true): Promise<boolean> {
        return this.router.navigate([], { relativeTo: this.route, queryParams, queryParamsHandling: 'merge', replaceUrl });
    }
}
