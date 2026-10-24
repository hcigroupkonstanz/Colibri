import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import type { Reconnect } from '../connection/socketio.service';
import { SocketIOService } from '../connection/socketio.service';

export interface LogMessage {
    id: string;
    origin: string;
    level: number;
    message: string;
    group: string;
    /** When the line last occurred. */
    created: number;
    /** When the line first occurred; equals `created` until it repeats. */
    first: number;
    /** Number of repeats: 0 for a line that occurred once. */
    count: number;
    metadata: Record<string, unknown>;
    /** Marks a row the page adds itself for a reconnect: `first` is when the connection was lost, `created` when it was back. */
    reconnect?: true;
}

interface LogHistory {
    request: number | null;
    /** The server's Date.now(), the clock that stamps the lines. */
    at?: number;
    messages: LogMessage[];
}

interface MergedBatch {
    /** Known ids the batch changed. */
    moved: Set<string>;
    /** Lines to append, in order of their last change. */
    added: Map<string, LogMessage>;
    /** All apps seen, or undefined when the batch brings no new one. */
    apps: Set<string> | undefined;
}

export const LOG_LEVELS: ReadonlyArray<{ value: number; label: string }> = [
    { value: 0, label: 'Error' },
    { value: 1, label: 'Warn' },
    { value: 2, label: 'Info' },
    { value: 3, label: 'Debug' }
];

/** The most lines the server sends in a history. */
export const MAX_MESSAGES = 10000;

/** Batching window for live lines, in ms. */
export const FLUSH_INTERVAL = 100;

const decode = function (text: string): string {
    try {
        return decodeURIComponent(text);
    } catch {
        return text;
    }
};

// While navigating away from the log page, location is already the next page's.
const isLogPath = function (): boolean {
    return location.pathname.endsWith('/log');
};

/** Level names in the query, indexed by level: ?levels=error,warn. */
const LEVEL_NAMES: ReadonlyArray<string> = [ 'error', 'warn', 'info', 'debug' ];

/**
 * The log filters as kept in the address, so a reload or shared link restores them: the app in
 * the hash, the rest in the query. Defaults are left out.
 */
export interface LogAddress {
    filter: string;
    levels: ReadonlyArray<number>;
    search: string;
    showBroadcastTraffic: boolean;
    showConnections: boolean;
}

export const readAddress = function (search: string, hash: string): LogAddress {
    const params = new Map<string, string>();
    for (const part of search.replace(/^\?/, '').split('&')) {
        if (!part) continue;
        const at = part.indexOf('=');
        // '+' is a space in a query
        const [ key, value ] = at < 0 ? [ part, '' ] : [ part.slice(0, at), part.slice(at + 1) ];
        params.set(decode(key.replace(/\+/g, ' ')), decode(value.replace(/\+/g, ' ')));
    }

    const levels = params.get('levels');
    return {
        filter: decode(hash.replace(/^#/, '')),
        levels: levels === undefined
            ? LOG_LEVELS.map(l => l.value)
            : levels.split(',').map(name => LEVEL_NAMES.indexOf(name.trim().toLowerCase())).filter(l => l >= 0).sort(),
        search: params.get('q') ?? '',
        showBroadcastTraffic: params.get('sync') === '1',
        showConnections: params.get('connections') !== '0'
    };
};

export const writeAddress = function (address: LogAddress): { search: string; hash: string } {
    const params: string[] = [];
    if (address.levels.length !== LOG_LEVELS.length) {
        params.push(`levels=${address.levels.map(l => LEVEL_NAMES[l]).join(',') || 'none'}`);
    }
    if (address.search) params.push(`q=${encodeURIComponent(address.search)}`);
    if (address.showBroadcastTraffic) params.push('sync=1');
    if (!address.showConnections) params.push('connections=0');
    return {
        search: params.length > 0 ? `?${params.join('&')}` : '',
        hash: address.filter ? `#${encodeURIComponent(address.filter)}` : ''
    };
};

@Injectable({
    providedIn: 'root'
})
export class LogService {
    private readonly socketio = inject(SocketIOService);

    private readonly _messages = signal<ReadonlyArray<LogMessage>>([]);
    /** Ordered by last occurrence, oldest first. */
    public readonly messages = this._messages.asReadonly();

    private readonly _loading = signal(true);
    /** True until the history for the current filters has arrived. */
    public readonly loading = this._loading.asReadonly();

    private readonly _apps = signal<ReadonlySet<string>>(new Set());
    /** Apps seen in log lines since the page loaded; kept across filter changes. */
    public readonly apps = this._apps.asReadonly();

    private readonly initial = isLogPath() ? readAddress(location.search, location.hash) : readAddress('', '');

    public readonly filter = signal<string>(this.initial.filter);
    public readonly levels = signal<ReadonlySet<number>>(new Set(this.initial.levels));
    public readonly showBroadcastTraffic = signal(this.initial.showBroadcastTraffic);
    /** Show the routine connect and disconnect lines. */
    public readonly showConnections = signal(this.initial.showConnections);

    /** Text to find in the loaded lines. Unlike the filters above, which the server applies, the page applies it. */
    public readonly search = signal(this.initial.search);

    private readonly openedLocally = Date.now();
    private readonly _openedAt = signal(this.openedLocally);
    /**
     * Page open time on the server's clock, the one that stamps the lines, so "New errors" is not
     * skewed by the browser's clock. The browser's clock until the first history arrives.
     */
    public readonly openedAt = this._openedAt.asReadonly();
    private serverClockKnown = false;

    /** Loaded lines per level, indexed by level; reconnect rows excluded. */
    public readonly levelCounts = computed(() => {
        const counts = LOG_LEVELS.map(() => 0);
        for (const message of this._messages()) {
            if (!message.reconnect && message.level in counts) counts[message.level]++;
        }
        return counts;
    });

    public setLevels(values: ReadonlyArray<number>): void {
        this.levels.set(new Set(values));
    }

    // The address belongs to the log only while its page is open.
    private pageOpen = false;

    /**
     * Called when the log page opens. Filters in the address (a link from the Clients page)
     * replace the current ones; without them the current filters are written to the address.
     */
    public openPage(): void {
        this.pageOpen = true;
        if (location.search || location.hash.length > 1) this.applyAddress();
        else this.updateAddress(true);
    }

    public closePage(): void {
        this.pageOpen = false;
    }

    public clearFilters(): void {
        this.filter.set('');
        this.showBroadcastTraffic.set(false);
        this.showConnections.set(true);
        this.search.set('');
        if (this.levels().size !== LOG_LEVELS.length) this.setLevels(LOG_LEVELS.map(l => l.value));
    }

    private applyAddress(): void {
        const address = readAddress(location.search, location.hash);
        this.filter.set(address.filter);
        this.search.set(address.search);
        this.showBroadcastTraffic.set(address.showBroadcastTraffic);
        this.showConnections.set(address.showConnections);
        // Keep the Set unless the levels differ: a new Set triggers a log request.
        const levels = this.levels();
        if (levels.size !== address.levels.length || address.levels.some(l => !levels.has(l))) this.setLevels(address.levels);
    }

    // The query is replaced, not pushed, so typing adds no history entries. A changed app (hash) is
    // a new entry, so Back returns to the previous app; `replace` replaces the app too, for a page
    // opened without one in its address.
    private updateAddress(replace = false): void {
        if (!this.pageOpen || !isLogPath()) return;
        const { search, hash } = writeAddress({
            filter: this.filter(),
            levels: [ ...this.levels() ].sort(),
            search: this.search(),
            showBroadcastTraffic: this.showBroadcastTraffic(),
            showConnections: this.showConnections()
        });
        const currentHash = location.hash.length > 1 ? location.hash : '';
        if (location.search !== search || (replace && currentHash !== hash)) {
            // Full path: a bare ?query resolves against <base href>.
            history.replaceState(history.state, '', `${location.pathname}${search}${replace ? hash : currentHash}`);
        }
        if (!replace && currentHash !== hash) location.hash = hash;
    }

    private readonly byId = new Map<string, LogMessage>();
    private pending: LogMessage[] = [];
    private flushTimer: ReturnType<typeof setTimeout> | undefined;

    private lastRequest = 0;
    // The request whose history is outstanding. Live lines are dropped until it arrives: they
    // may match the previous filters, and the history has every line matching the current ones.
    private awaiting: number | null = null;

    public constructor() {
        this.socketio
            .listen('colibri::log')
            .subscribe(msg => this.receiveLog(msg));

        effect(() => this.reloadOnFilterChange());

        effect(() => this.updateAddressOnChange());

        // Back/forward, a link to another app's log, or a hand-edited address.
        const follow = () => this.followAddress();
        window.addEventListener('popstate', follow);
        window.addEventListener('hashchange', follow);

        this.socketio.reconnected$.subscribe(reconnect => this.addReconnectRow(reconnect));
    }

    private receiveLog(msg: { command: string; payload: unknown }): void {
        if (msg.command === 'history') {
            this.receiveHistory(msg.payload as LogHistory);
        } else if (this.awaiting === null) {
            this.queue(msg.payload as LogMessage);
        }
    }

    private reloadOnFilterChange(): void {
        this.filter();
        this.levels();
        this.showBroadcastTraffic();
        this.showConnections();

        untracked(() => {
            this.clear();
            this.requestLog();
        });
    }

    private updateAddressOnChange(): void {
        this.filter();
        this.levels();
        this.showBroadcastTraffic();
        this.showConnections();
        this.search();
        untracked(() => this.updateAddress());
    }

    private followAddress(): void {
        if (this.pageOpen && isLogPath()) this.applyAddress();
    }

    // Existing lines stay. The history adds what was logged meanwhile after a row marking the
    // gap; after a server restart that is the new server's whole log.
    private addReconnectRow({ lostAt, at }: Reconnect): void {
        this.add([ {
            id: `reconnect-${at}`,
            origin: '',
            level: 2,
            message: '',
            group: '',
            created: at,
            first: lostAt,
            count: 0,
            metadata: {},
            reconnect: true
        } ]);
        this.requestLog();
    }

    private requestLog(): void {
        this.awaiting = ++this.lastRequest;
        this._loading.set(true);
        this.socketio.emit('colibri::log', 'requestLog', {
            filter: this.filter(),
            levels: [ ...this.levels() ],
            showBroadcastTraffic: this.showBroadcastTraffic(),
            showConnections: this.showConnections(),
            request: this.awaiting
        });
    }

    private receiveHistory(history: LogHistory): void {
        if (!this.serverClockKnown && typeof history.at === 'number') {
            this.serverClockKnown = true;
            this._openedAt.set(this.openedLocally + (history.at - Date.now()));
        }
        if (history.request !== this.awaiting) return;

        this.awaiting = null;
        this._loading.set(false);
        this.add(history.messages ?? []);
    }

    // Live lines arrive one event each, hundreds a second with sync traffic shown; batching
    // copies the list once per batch instead of once per line.
    private queue(message: LogMessage): void {
        this.pending.push(message);
        if (this.flushTimer === undefined) {
            this.flushTimer = setTimeout(() => this.flush(), FLUSH_INTERVAL);
        }
    }

    private flush(): void {
        this.flushTimer = undefined;
        const batch = this.pending;
        this.pending = [];
        this.add(batch);
    }

    private clear(): void {
        clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
        this.pending = [];
        this.byId.clear();
        this._messages.set([]);
    }

    // A known id is a repeat: the server resends the merged entry with the new count and time.
    // It moves to the end, as in the history.
    private add(batch: ReadonlyArray<LogMessage>): void {
        const { moved, added, apps } = this.mergeBatch(batch);

        if (apps) this._apps.set(apps);
        if (added.size === 0) return;

        let messages = this._messages();
        if (moved.size > 0) messages = messages.filter(m => !moved.has(m.id));
        messages = messages.concat([ ...added.values() ]);

        this._messages.set(this.evictOldest(messages));
    }

    private mergeBatch(batch: ReadonlyArray<LogMessage>): MergedBatch {
        const moved = new Set<string>();
        const added = new Map<string, LogMessage>();
        let apps: Set<string> | undefined;

        for (const message of batch) {
            const known = this.byId.get(message.id);
            if (known) {
                if (known.count === message.count && known.created === message.created) continue;
                moved.add(message.id);
                added.delete(message.id);
            }

            // Store the new object, never mutate: rows re-render only for a new reference.
            this.byId.set(message.id, message);
            added.set(message.id, message);

            const app = message.metadata?.['clientApp'];
            if (typeof app === 'string' && !this._apps().has(app) && !apps?.has(app)) {
                apps ??= new Set(this._apps());
                apps.add(app);
            }
        }

        return { moved, added, apps };
    }

    private evictOldest(messages: ReadonlyArray<LogMessage>): ReadonlyArray<LogMessage> {
        if (messages.length <= MAX_MESSAGES) return messages;
        for (const evicted of messages.slice(0, messages.length - MAX_MESSAGES)) {
            if (this.byId.get(evicted.id) === evicted) this.byId.delete(evicted.id);
        }
        return messages.slice(-MAX_MESSAGES);
    }
}
