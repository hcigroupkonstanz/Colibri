import { ChangeDetectionStrategy, Component, ElementRef, afterRenderEffect, computed, inject, signal, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { SelectModule } from 'primeng/select';
import type { ClientRow, ClientsSnapshot } from '../../services/admin.service';
import { AdminService } from '../../services/admin.service';
import { ClientService } from '../../services/client.service';
import { LatencyChartComponent, clientColor } from '../../components/latency-chart/latency-chart.component';
import type { Direction } from '../../components/throughput-chart/throughput-chart.component';
import { ThroughputChartComponent } from '../../components/throughput-chart/throughput-chart.component';
import { LiveStatusComponent } from '../../components/live-status/live-status.component';
import { OfflineBannerComponent } from '../../components/offline-banner/offline-banner.component';
import { appColor, isAddress, shortId } from '../../components/log-message/log-format';
import { count, decimal, duration } from '../../format';

export type SortKey = 'app' | 'name' | 'transport' | 'version' | 'connected' | 'latency' | 'in' | 'out' | 'limit';

interface Column {
    key: SortKey;
    label: string;
    title: string;
    class: string;
    num?: boolean;
}

export const COLUMNS: ReadonlyArray<Column> = [
    { key: 'app', label: 'App', title: 'The app it joined', class: 'c-app' },
    { key: 'name', label: 'Client', title: 'Its name and address', class: 'c-name' },
    { key: 'transport', label: 'Transport', title: 'TCP for a Unity client, web for a Socket.IO client, and TLS, terminated by this server or by a trusted proxy', class: 'c-transport' },
    { key: 'version', label: 'Protocol', title: 'The protocol version it announced', class: 'c-version' },
    { key: 'connected', label: 'Connected', title: 'How long it has been connected', class: 'c-connected', num: true },
    { key: 'latency', label: 'Latency', title: 'Median round trip over the last second, in ms', class: 'c-latency', num: true },
    { key: 'in', label: 'In/s', title: 'Messages it sent per second, over the last second', class: 'c-in', num: true },
    { key: 'out', label: 'Out/s', title: 'Messages it was sent per second, over the last second', class: 'c-out', num: true },
    { key: 'limit', label: 'Load limit', title: 'Whether a load limit holds its updates back now', class: 'c-limit' }
];

export interface Sort {
    key: SortKey;
    descending: boolean;
}

/** Where a client's TLS is terminated: by this server, or by a trusted reverse proxy in front of it. */
export type TlsEnd = 'server' | 'proxy';

// A proxy's TLS comes from the transport's own signal: X-Forwarded-Proto for web, and TCP_TLS_AT_PROXY
// for TCP, as the server does not read TLS from a PROXY header.
const TLS_TITLES = {
    server: 'Encrypted: TLS',
    tcp: 'TLS terminated by a trusted proxy (TCP_TLS_AT_PROXY)',
    web: 'TLS terminated by a trusted proxy (X-Forwarded-Proto)'
} as const;

/** This server's own TLS is checked first, so a direct TLS client is never shown as proxied. */
export const tlsEnd = function (row: ClientRow): TlsEnd | null {
    return row.tls ? 'server' : row.tlsAtProxy ? 'proxy' : null;
};

const LIMIT_LABELS = { rate: 'Rate limit', backlog: 'Backlog' } as const;
const LIMIT_TITLES = {
    rate: 'It sends more than CLIENT_MESSAGE_RATE_LIMIT allows: its updates are held back and its broadcasts dropped',
    backlog: 'Its messages wait for the server: past TCP_INBOUND_BACKLOG_LIMIT, its updates are held back and its broadcasts dropped'
} as const;

export interface ClientView {
    id: string;
    app: string;
    appColor: string;
    /** The name. A web client named by its address shows the start of its id instead. */
    label: string;
    labelTitle: string;
    byId: boolean;
    /** The client's address. Behind a trusted proxy, the one the proxy reported. */
    address: string;
    transport: 'TCP' | 'Web';
    tls: TlsEnd | null;
    tlsTitle: string;
    version: string;
    connectedAt: number;
    connected: string;
    latency: string;
    in: string;
    out: string;
    limit: string | null;
    limitTitle: string;
    held: number;
    /** Its colour in the charts. */
    color: string | null;
    truncated: boolean;
}

/** Parses the sort query value: a column key, with a leading '-' for descending. Null for an unknown key. */
export const parseSort = function (value: string | null): Sort | null {
    if (!value) return null;
    const descending = value.startsWith('-');
    const key = (descending ? value.slice(1) : value) as SortKey;
    return COLUMNS.some(column => column.key === key) ? { key, descending } : null;
};

const sortValue = function (row: ClientRow, key: SortKey): string | number | null {
    switch (key) {
        case 'app': return row.app.toLowerCase();
        case 'name': return row.name.toLowerCase();
        // Within a transport: unencrypted, then TLS at a proxy, then TLS to this server
        case 'transport': return `${row.transport}${row.tls ? 2 : row.tlsAtProxy ? 1 : 0}`;
        case 'version': return row.version;
        // Negated, so the longest connected has the largest value.
        case 'connected': return -row.connectedAt;
        case 'latency': return row.latency;
        case 'in': return row.in;
        case 'out': return row.out;
        case 'limit': return row.limit === null ? null : row.limit === 'backlog' ? 2 : 1;
    }
};

/** Sorts by a column, the rows without a value last either way, then by app and name. */
export const sortClients = function (rows: ReadonlyArray<ClientRow>, sort: Sort | null): ClientRow[] {
    const byName = (a: ClientRow, b: ClientRow) =>
        a.app.localeCompare(b.app) || a.name.localeCompare(b.name) || a.connectedAt - b.connectedAt || a.id.localeCompare(b.id);
    if (!sort) return [ ...rows ].sort(byName);

    return [ ...rows ].sort((a, b) => {
        const x = sortValue(a, sort.key);
        const y = sortValue(b, sort.key);
        if (x === null || y === null) return x === y ? byName(a, b) : x === null ? 1 : -1;
        const order = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
        return (sort.descending ? -order : order) || byName(a, b);
    });
};

@Component({
    selector: 'app-clients',
    templateUrl: './clients.component.html',
    styleUrl: './clients.component.scss',
    imports: [DatePipe, FormsModule, RouterLink, SelectModule, LatencyChartComponent, ThroughputChartComponent, LiveStatusComponent, OfflineBannerComponent],
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class ClientsComponent {
    private admin = inject(AdminService);
    private clientService = inject(ClientService);
    private route = inject(ActivatedRoute);
    private router = inject(Router);
    private host = inject<ElementRef<HTMLElement>>(ElementRef);

    columns = COLUMNS;

    feed = this.admin.feed<ClientsSnapshot>('clients');

    private params = toSignal(this.route.queryParamMap, { requireSync: true });
    app = computed(() => this.params().get('app') ?? '');
    sort = computed(() => parseSort(this.params().get('sort')));
    /** The client a link from the log points at. */
    marked = computed(() => this.params().get('client'));
    /** What the throughput chart counts: the messages the clients sent, or those sent to them. */
    direction = computed<Direction>(() => this.params().get('throughput') === 'out' ? 'out' : 'in');

    /** Apps with a connected client. The filtered app stays in the list at 0, so the select can show it. */
    appOptions = computed(() => {
        const counts = new Map<string, number>();
        for (const client of this.feed.data()?.clients ?? []) counts.set(client.app, (counts.get(client.app) ?? 0) + 1);
        const app = this.app();
        if (app && !counts.has(app)) counts.set(app, 0);
        return [ ...counts ].map(([ name, clients ]) => ({ name, clients })).sort((a, b) => a.name.localeCompare(b.name));
    });

    /** Phone sort choices: one per column, in the direction its first header click gives. */
    sortOptions = [
        { value: '', label: 'By app' },
        { value: 'name', label: 'By name' },
        { value: 'transport', label: 'By transport' },
        { value: 'version', label: 'By protocol' },
        { value: '-connected', label: 'Longest connected' },
        { value: '-latency', label: 'Highest latency' },
        { value: '-in', label: 'Most in' },
        { value: '-out', label: 'Most out' },
        { value: '-limit', label: 'Held back first' }
    ];

    /**
     * Row order while the mouse is over the table. Sorted by a live value, the rows would reshuffle
     * on nearly every refresh and move the one under the pointer before its Log link is clicked.
     */
    private heldOrder = signal<ReadonlyArray<string> | null>(null);

    rows = computed<ClientView[]>(() => {
        const snapshot = this.feed.data();
        if (!snapshot) return [];
        const app = this.app();
        const slots = new Map(this.clientService.clients().map(client => [ client.id, client.slot ]));
        const shown = app ? snapshot.clients.filter(client => client.app === app) : snapshot.clients;

        const sorted = sortClients(shown, this.sort());
        const held = this.heldOrder();
        if (held) {
            // Clients that joined since the order was held go last, in their sorted order.
            const at = new Map(held.map((id, i) => [ id, i ]));
            sorted.sort((a, b) => (at.get(a.id) ?? held.length) - (at.get(b.id) ?? held.length));
        }

        return sorted.map(client => {
            const byId = client.transport === 'web' && isAddress(client.name);
            const slot = slots.get(client.id);
            const tls = tlsEnd(client);
            return {
                id: client.id,
                app: client.app,
                appColor: appColor(client.app),
                label: byId ? shortId(client.id) : client.name,
                labelTitle: byId ? `${client.name}, client ${client.id}` : `Client ${client.id}`,
                byId,
                address: client.address,
                transport: client.transport === 'tcp' ? 'TCP' : 'Web',
                tls,
                tlsTitle: tls === 'proxy' ? TLS_TITLES[client.transport] : tls ? TLS_TITLES[tls] : '',
                version: client.version,
                connectedAt: client.connectedAt,
                connected: duration((snapshot.at - client.connectedAt) / 1000),
                latency: client.latency === null ? '-' : `${decimal(client.latency)} ms`,
                in: decimal(client.in),
                out: decimal(client.out),
                limit: client.limit ? LIMIT_LABELS[client.limit] : null,
                limitTitle: client.limit ? LIMIT_TITLES[client.limit] : '',
                held: client.held,
                color: slot === undefined ? null : clientColor(slot),
                truncated: client.truncated === true
            };
        });
    });

    /** The count line above the table. It says so when the server has cut the client list short. */
    summary = computed(() => {
        const snapshot = this.feed.data();
        if (!snapshot) return '';
        const shown = this.rows();
        const tcp = shown.filter(row => row.transport === 'TCP').length;
        const web = shown.length - tcp;
        const total = this.app() ? `${count(shown.length)} of ${count(snapshot.total)} connected` : `${count(snapshot.total)} connected`;
        const parts = [ `${total}: ${count(tcp)} TCP, ${count(web)} web` ];
        if (snapshot.total > snapshot.clients.length) parts.push(`the first ${count(snapshot.clients.length)} listed`);
        return parts.join(', ');
    });

    adminPages = computed(() => this.feed.data()?.adminPages ?? 0);

    // Matched by template reference (#throughput), so a test's stand-in answers too.
    private throughputChart = viewChild<ThroughputChartComponent>('throughput');

    /**
     * The hint beside the Throughput title. Its total is the chart's, which keeps a client's last
     * rate for a second the server has none, so the total does not dip.
     */
    throughputHint = computed(() => {
        const what = this.direction() === 'in' ? 'Messages per second each client sent' : 'Messages per second sent to each client';
        const total = this.throughputChart()?.total() ?? null;
        return `${what}, stacked, over the last 120 s${total === null ? '' : `; total now ${decimal(total)}`}`;
    });

    empty = computed(() => {
        if (!this.feed.data()) return 'Loading the clients…';
        return this.app() ? `No clients of ${this.app()} connected.` : 'No clients connected.';
    });

    /** The phone sort list's value, mirroring the sort in the URL. */
    sortChoice = computed(() => {
        const sort = this.sort();
        return sort ? `${sort.descending ? '-' : ''}${sort.key}` : '';
    });

    private scrolledTo = signal<string | null>(null);

    constructor() {
        // Scrolls the linked row into view once: scrolledTo stops it from scrolling on every refresh.
        afterRenderEffect(() => {
            const id = this.marked();
            if (!id || this.scrolledTo() === id || !this.rows().some(row => row.id === id)) return;
            this.scrolledTo.set(id);
            Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>('tr[data-id]'))
                .find(row => row.dataset['id'] === id)?.scrollIntoView({ block: 'center' });
        });
    }

    /** Freezes the row order while a mouse is over the table. Touch and pen input do not. */
    holdOrder(event: PointerEvent): void {
        if (event.pointerType === 'mouse') this.heldOrder.set(this.rows().map(row => row.id));
    }

    releaseOrder(): void {
        this.heldOrder.set(null);
    }

    setApp(app: string): Promise<boolean> {
        return this.navigate({ app: app || null, client: null });
    }

    /** The first click sorts A to Z, or largest first for numbers and the limit column. The second reverses. */
    sortBy(key: SortKey): Promise<boolean> {
        const column = COLUMNS.find(c => c.key === key)!;
        const current = this.sort();
        const firstDescending = column.num === true || key === 'limit';
        const descending = current?.key === key ? !current.descending : firstDescending;
        // Ascending by app is the default, so it needs no sort parameter in the URL.
        const isDefault = key === 'app' && !descending;
        return this.navigate({ sort: isDefault ? null : `${descending ? '-' : ''}${key}` });
    }

    setDirection(direction: Direction): Promise<boolean> {
        return this.navigate({ throughput: direction === 'out' ? 'out' : null });
    }

    setSort(value: string | null): Promise<boolean> {
        return this.navigate({ sort: value || null });
    }

    ariaSort(key: SortKey): 'ascending' | 'descending' | null {
        const sort = this.sort() ?? { key: 'app', descending: false };
        if (sort.key !== key) return null;
        return sort.descending ? 'descending' : 'ascending';
    }

    private navigate(queryParams: Record<string, string | null>): Promise<boolean> {
        return this.router.navigate([], { relativeTo: this.route, queryParams, queryParamsHandling: 'merge', replaceUrl: true });
    }
}
