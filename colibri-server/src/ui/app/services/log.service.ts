import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { SocketIOService } from './socketio.service';

export interface LogMessage {
    id: string;
    origin: string;
    level: number;
    message: string;
    group: string;
    /** When the line last occurred. */
    created: number;
    /** When the line first occurred: the same as `created` until it repeats. */
    first: number;
    /** How often the line repeated: 0 for a line that occurred once. */
    count: number;
    metadata: Record<string, unknown>;
    /**
     * Set on a row the page adds itself where the connection to the server was lost and back:
     * `first` is when it was lost, `created` when it was back.
     */
    reconnect?: true;
}

interface LogHistory {
    request: number | null;
    /** The server's Date.now(), the clock that stamps the lines. */
    at?: number;
    messages: LogMessage[];
}

export const LOG_LEVELS: ReadonlyArray<{ value: number; label: string }> = [
    { value: 0, label: 'Error' },
    { value: 1, label: 'Warn' },
    { value: 2, label: 'Info' },
    { value: 3, label: 'Debug' }
];

/** As many lines as the server sends in a history. */
export const MAX_MESSAGES = 10000;

/** How long live lines are collected before the page shows them, in ms. */
export const FLUSH_INTERVAL = 100;

const decode = function (text: string): string {
    try {
        return decodeURIComponent(text);
    } catch {
        return text;
    }
};

// Whether the address is the log page's: on the way to another page, it is that page's.
const isLogPath = function (): boolean {
    return location.pathname.endsWith('/log');
};

/** The level names in the address: ?levels=error,warn. */
const LEVEL_NAMES: ReadonlyArray<string> = [ 'error', 'warn', 'info', 'debug' ];

/**
 * The log's filters as the address holds them, so that a reload or a shared link shows the same:
 * the app in the hash, as before, the rest in the query. Left out at their defaults.
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
        // a + in a query is a space, as a form writes it
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
    /** The loaded lines in the order they last occurred, oldest first. */
    public readonly messages = this._messages.asReadonly();

    private readonly _loading = signal(true);
    /** Whether the history for the current filters is still on its way. */
    public readonly loading = this._loading.asReadonly();

    private readonly _apps = signal<ReadonlySet<string>>(new Set());
    /** Every app seen in a log line since the page loaded, whatever the filters. */
    public readonly apps = this._apps.asReadonly();

    private readonly initial = isLogPath() ? readAddress(location.search, location.hash) : readAddress('', '');

    public readonly filter = signal<string>(this.initial.filter);
    public readonly levels = signal<ReadonlySet<number>>(new Set(this.initial.levels));
    public readonly showBroadcastTraffic = signal(this.initial.showBroadcastTraffic);
    /** Whether the routine connect and disconnect lines are shown. */
    public readonly showConnections = signal(this.initial.showConnections);

    /** Text to look for in the loaded lines. Unlike the filters above, the page applies it itself. */
    public readonly search = signal(this.initial.search);

    // When the page was opened, by the browser's clock.
    private readonly openedLocally = Date.now();
    private readonly _openedAt = signal(this.openedLocally);
    /**
     * When the page was opened, by the server's clock, which stamps the lines: "New errors" counts
     * the errors since. A browser whose clock is a few minutes off would count errors from before
     * or miss new ones. The browser's own clock until the first history says what the server's reads.
     */
    public readonly openedAt = this._openedAt.asReadonly();
    private serverClockKnown = false;

    /** How many of the loaded lines there are of each level. */
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

    // Whether the log page is open: only then is the address the log's.
    private pageOpen = false;

    /**
     * Called by the log page when it opens. A link with filters in it, such as one from the Clients
     * page, sets them; a link without, such as the page's tab, keeps the filters and puts them back
     * in the address, or a reload or a copied link would lose them.
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
        // a new set only for other levels: a new one would request the log again
        const levels = this.levels();
        if (levels.size !== address.levels.length || address.levels.some(l => !levels.has(l))) this.setLevels(address.levels);
    }

    // The query is replaced, so that each key typed is not a step back. A new app is a new entry, as
    // it always was: the browser's back button goes back to the previous app. `replace` replaces
    // the app too, for a page opened without one in its address.
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
            // the whole path: a bare ?query resolves against <base href>
            history.replaceState(history.state, '', `${location.pathname}${search}${replace ? hash : currentHash}`);
        }
        if (!replace && currentHash !== hash) location.hash = hash;
    }

    private readonly byId = new Map<string, LogMessage>();
    private pending: LogMessage[] = [];
    private flushTimer: ReturnType<typeof setTimeout> | undefined;

    private lastRequest = 0;
    // The request whose history has not arrived yet. Live lines are dropped until it has: they
    // were filtered by the previous preferences, and the history holds every one that matches.
    private awaiting: number | null = null;

    constructor() {
        this.socketio
            .listen('colibri::log')
            .subscribe((msg) => {
                if (msg.command === 'history') {
                    this.receiveHistory(msg.payload as LogHistory);
                } else if (this.awaiting === null) {
                    this.queue(msg.payload as LogMessage);
                }
            });

        effect(() => {
            this.filter();
            this.levels();
            this.showBroadcastTraffic();
            this.showConnections();

            untracked(() => {
                this.clear();
                this.requestLog();
            });
        });

        effect(() => {
            this.filter();
            this.levels();
            this.showBroadcastTraffic();
            this.showConnections();
            this.search();
            untracked(() => this.updateAddress());
        });

        // the browser's back and forward buttons, a link to another app's log opened on this page,
        // or the address edited by hand
        const follow = () => {
            if (this.pageOpen && isLogPath()) this.applyAddress();
        };
        window.addEventListener('popstate', follow);
        window.addEventListener('hashchange', follow);

        // The lines from before stay. The history fills in what was logged meanwhile, below a
        // row that marks the gap; after a server restart that is the new server's whole log.
        this.socketio.reconnected$.subscribe(({ lostAt, at }) => {
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
        });
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

    // Lines arrive one socket event each, hundreds a second with sync traffic shown. Adding them
    // in batches copies the list once per batch rather than once per line.
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

    // A line the list already has is a repeat: the server sends the merged entry again with
    // the new count and time. It moves to the end, where the history puts it too.
    private add(batch: ReadonlyArray<LogMessage>): void {
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

            // A new object, not the old one changed: rows only re-render for a new reference.
            this.byId.set(message.id, message);
            added.set(message.id, message);

            const app = message.metadata?.['clientApp'];
            if (typeof app === 'string' && !this._apps().has(app) && !apps?.has(app)) {
                apps ??= new Set(this._apps());
                apps.add(app);
            }
        }

        if (apps) this._apps.set(apps);
        if (added.size === 0) return;

        let messages = this._messages();
        if (moved.size > 0) messages = messages.filter(m => !moved.has(m.id));
        messages = messages.concat([ ...added.values() ]);

        if (messages.length > MAX_MESSAGES) {
            for (const evicted of messages.slice(0, messages.length - MAX_MESSAGES)) {
                if (this.byId.get(evicted.id) === evicted) this.byId.delete(evicted.id);
            }
            messages = messages.slice(-MAX_MESSAGES);
        }

        this._messages.set(messages);
    }
}
