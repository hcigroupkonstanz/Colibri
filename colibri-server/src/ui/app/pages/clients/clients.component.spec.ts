import { TestBed } from '@angular/core/testing';
import { Component, input, signal } from '@angular/core';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { Subject } from 'rxjs';
import { ClientRow, ClientService, ColibriClient, ConnectionState, Reconnect, SocketIOService } from '../../services';
import { LatencyChartComponent, clientColor } from '../../components/latency-chart/latency-chart.component';
import { ThroughputChartComponent } from '../../components/throughput-chart/throughput-chart.component';
import { ClientsComponent, parseSort, sortClients } from './clients.component';

const client = (overrides: Partial<ClientRow>): ClientRow => ({
    id: 'id',
    app: 'demo',
    name: 'Quest',
    transport: 'tcp',
    version: '2',
    tls: false,
    tlsAtProxy: false,
    address: '10.0.0.5',
    connectedAt: 0,
    latency: null,
    in: null,
    out: null,
    limit: null,
    held: 0,
    ...overrides
});

// The chart has tests of its own; its d3 transitions do not belong in these.
@Component({ selector: 'app-latency-chart', template: '' })
class LatencyChartStub {
    app = input('');
}

@Component({ selector: 'app-throughput-chart', template: '' })
class ThroughputChartStub {
    snapshot = input<unknown>(null);
    app = input('');
    direction = input('in');
    total = signal<number | null>(null);
}

describe('ClientsComponent', () => {
    let channel: Subject<{ command: string; payload: unknown }>;
    let emit: ReturnType<typeof vi.fn>;
    let clients: ReturnType<typeof signal<ReadonlyArray<ColibriClient>>>;

    const snapshot = (rows: ClientRow[], extra: object = {}) => {
        const request = emit.mock.calls.filter(call => call[1] === 'subscribe').at(-1)![2].request;
        channel.next({ command: 'clients', payload: { request, at: 125_000, clients: rows, total: rows.length, adminPages: 1, ...extra } });
    };

    const open = async (url: string) => {
        const harness = await RouterTestingHarness.create();
        const component = await harness.navigateByUrl(url, ClientsComponent);
        TestBed.flushEffects();
        return { harness, component, root: harness.routeNativeElement! };
    };

    beforeEach(() => {
        channel = new Subject();
        emit = vi.fn();
        clients = signal<ReadonlyArray<ColibriClient>>([]);

        TestBed.configureTestingModule({
            providers: [
                provideRouter([ { path: 'clients', component: ClientsComponent } ]),
                {
                    provide: SocketIOService,
                    useValue: {
                        listen: () => channel.asObservable(),
                        emit,
                        reconnected$: new Subject<Reconnect>().asObservable(),
                        state: signal<ConnectionState>('connected'),
                        lostAt: signal<number | null>(null)
                    }
                },
                { provide: ClientService, useValue: { clients } }
            ]
        });
        TestBed.overrideComponent(ClientsComponent, {
            remove: { imports: [ LatencyChartComponent, ThroughputChartComponent ] },
            add: { imports: [ LatencyChartStub, ThroughputChartStub ] }
        });
    });

    it('subscribes to the clients while open, and stops when it closes', async () => {
        const { harness } = await open('/clients');
        expect(emit).toHaveBeenCalledWith('colibri::admin', 'subscribe', { topic: 'clients', request: expect.any(Number) });

        harness.fixture.destroy();
        expect(emit).toHaveBeenLastCalledWith('colibri::admin', 'unsubscribe', { topic: 'clients' });
    });

    it('lists each client with its transport, address, chart colour and load limit', async () => {
        clients.set([ { id: 'web1', app: 'demo', name: '127.0.0.1', version: '2', latency: [], slot: 3 } ]);
        const { harness, component } = await open('/clients');
        snapshot([
            client({ id: 'q1', connectedAt: 5_000, latency: 12.34, in: 30, out: 120.5, limit: 'rate', held: 4, tls: true }),
            client({ id: 'web1', transport: 'web', name: '127.0.0.1', address: '127.0.0.1', connectedAt: 65_000 })
        ]);
        harness.detectChanges();

        const quest = component.rows().find(row => row.id === 'q1');
        const web = component.rows().find(row => row.id === 'web1');
        expect(quest).toEqual(expect.objectContaining({
            label: 'Quest', byId: false, address: '10.0.0.5', transport: 'TCP', tls: 'server', connected: '2 min',
            latency: '12.3 ms', in: '30.0', out: '120.5', limit: 'Rate limit', held: 4, color: null
        }));
        // a web client by the start of its id, in its colour in the latency chart
        expect(web).toEqual(expect.objectContaining({ label: 'web1', byId: true, transport: 'Web', connected: '1 min', in: '-', color: clientColor(3) }));
        expect(component.summary()).toBe('2 connected: 1 TCP, 1 web');
        expect(harness.routeNativeElement!.querySelector('tr[data-id="q1"] td.c-limit')?.textContent).toContain('4 held');
        // under the transport too, for tablets, where the protocol column is left out
        expect(harness.routeNativeElement!.querySelector('tr[data-id="q1"] td.c-transport .version')?.textContent).toBe('v2');
    });

    it('shows TLS terminated by the server and by a proxy with the same lock, told apart by label and title', async () => {
        const { harness, component, root } = await open('/clients');
        snapshot([
            client({ id: 'direct', tls: true }),
            client({ id: 'proxied', transport: 'web', name: '198.51.100.7', tlsAtProxy: true }),
            client({ id: 'plain', transport: 'web', name: '198.51.100.8' }),
            // TLS to the server wins: a direct connection uses it
            client({ id: 'both', transport: 'web', name: '198.51.100.9', tls: true, tlsAtProxy: true })
        ]);
        harness.detectChanges();

        const view = (id: string) => component.rows().find(row => row.id === id);
        expect(view('direct')).toEqual(expect.objectContaining({ tls: 'server', tlsTitle: 'Encrypted: TLS' }));
        expect(view('proxied')?.tls).toBe('proxy');
        expect(view('proxied')?.tlsTitle).toBe('TLS terminated by a trusted proxy (X-Forwarded-Proto)');
        expect(view('plain')).toEqual(expect.objectContaining({ tls: null, tlsTitle: '' }));
        expect(view('both')?.tls).toBe('server');

        const lock = (id: string) => root.querySelector(`tr[data-id="${id}"] td.c-transport .tls`);
        expect(lock('direct')?.textContent?.trim()).toBe('TLS');
        expect(lock('direct')?.querySelector('.pi-lock')).not.toBeNull();
        expect(lock('proxied')?.textContent?.trim()).toBe('TLS (proxy)');
        expect(lock('proxied')?.querySelector('.pi-lock')).not.toBeNull();
        expect(lock('proxied')?.getAttribute('title')).toBe(view('proxied')?.tlsTitle);
        expect(lock('plain')).toBeNull();
        // "(proxy)" in its own element, which a phone puts on the next line
        expect(lock('proxied')?.querySelector('.by-proxy')?.textContent?.trim()).toBe('(proxy)');
        expect(lock('direct')?.querySelector('.by-proxy')).toBeNull();
        expect(lock('both')?.querySelector('.by-proxy')).toBeNull();
    });

    it('shows a Unity client through a proxy with TCP_TLS_AT_PROXY as TLS (proxy), naming the setting on hover', async () => {
        const { harness, component, root } = await open('/clients');
        snapshot([
            client({ id: 'tcp-proxied', name: 'quest-1', address: '198.51.100.7', tlsAtProxy: true }),
            client({ id: 'tcp-plain', name: 'quest-2', address: '198.51.100.8' }),
            client({ id: 'web-proxied', transport: 'web', name: '198.51.100.9', tlsAtProxy: true })
        ]);
        harness.detectChanges();

        const view = (id: string) => component.rows().find(row => row.id === id);
        expect(view('tcp-proxied')).toEqual(expect.objectContaining({ transport: 'TCP', tls: 'proxy' }));
        expect(view('tcp-proxied')?.tlsTitle).toBe('TLS terminated by a trusted proxy (TCP_TLS_AT_PROXY)');
        expect(view('tcp-plain')).toEqual(expect.objectContaining({ tls: null, tlsTitle: '' }));
        // a web client's comes from its proxy's X-Forwarded-Proto
        expect(view('web-proxied')?.tlsTitle).not.toContain('TCP_TLS_AT_PROXY');

        const lock = (id: string) => root.querySelector(`tr[data-id="${id}"] td.c-transport .tls`);
        expect(lock('tcp-proxied')?.textContent?.trim()).toBe('TLS (proxy)');
        expect(lock('tcp-proxied')?.querySelector('.pi-lock')).not.toBeNull();
        expect(lock('tcp-proxied')?.querySelector('.by-proxy')?.textContent?.trim()).toBe('(proxy)');
        expect(lock('tcp-proxied')?.getAttribute('title')).toBe(view('tcp-proxied')?.tlsTitle);
        expect(lock('tcp-plain')).toBeNull();
    });

    it('shows the app in the address only, and links each client to its log', async () => {
        const { harness, component, root } = await open('/clients?app=demo');
        snapshot([ client({ id: 'a', app: 'demo' }), client({ id: 'b', app: 'other' }) ]);
        harness.detectChanges();

        expect(component.rows().map(row => row.id)).toEqual([ 'a' ]);
        expect(component.summary()).toBe('1 of 2 connected: 1 TCP, 0 web');
        expect(component.appOptions()).toEqual([ { name: 'demo', clients: 1 }, { name: 'other', clients: 1 } ]);
        // not filtered to its app: the server's lines about a client, such as its rate limit
        // warning, name the client but not the app
        expect(root.querySelector('td.c-log a')?.getAttribute('href')).toBe('/log?q=a');
    });

    it('sorts by a column from the address, the rows without a value last', async () => {
        const { harness, component } = await open('/clients?sort=-latency');
        snapshot([ client({ id: 'a', latency: 5 }), client({ id: 'b', latency: null }), client({ id: 'c', latency: 9 }) ]);
        harness.detectChanges();
        expect(component.rows().map(row => row.id)).toEqual([ 'c', 'a', 'b' ]);

        await component.sortBy('latency');
        expect(component.rows().map(row => row.id)).toEqual([ 'a', 'c', 'b' ]);
    });

    it('keeps the rows in place while the mouse is over them', async () => {
        const { harness, component } = await open('/clients?sort=-latency');
        snapshot([ client({ id: 'a', latency: 5 }), client({ id: 'b', latency: 4 }) ]);
        harness.detectChanges();

        component.holdOrder({ pointerType: 'mouse' } as PointerEvent);
        snapshot([ client({ id: 'a', latency: 3 }), client({ id: 'b', latency: 4 }), client({ id: 'c', latency: 9 }) ]);
        // the new one after the others
        expect(component.rows().map(row => row.id)).toEqual([ 'a', 'b', 'c' ]);

        component.releaseOrder();
        expect(component.rows().map(row => row.id)).toEqual([ 'c', 'b', 'a' ]);

        // a finger does not hold them: it leaves no pointer over the rows
        component.holdOrder({ pointerType: 'touch' } as PointerEvent);
        snapshot([ client({ id: 'a', latency: 10 }), client({ id: 'b', latency: 4 }), client({ id: 'c', latency: 9 }) ]);
        expect(component.rows().map(row => row.id)).toEqual([ 'a', 'c', 'b' ]);
    });

    it('says why the list is empty', async () => {
        const { component } = await open('/clients?app=gone');
        expect(component.empty()).toBe('Loading the clients…');
        snapshot([]);
        expect(component.empty()).toBe('No clients of gone connected.');
    });

    it('switches the throughput chart between In and Out in the address, with the chart\'s total', async () => {
        const { harness, component, root } = await open('/clients?app=demo');
        snapshot([ client({ id: 'q1', in: 30, out: 120.5 }) ]);
        harness.detectChanges();
        const chart = () => harness.fixture.debugElement.query(debug => debug.componentInstance instanceof ThroughputChartStub).componentInstance as ThroughputChartStub;
        const button = (label: string) => Array.from(root.querySelectorAll<HTMLButtonElement>('.direction button')).find(b => b.textContent?.trim() === label)!;

        expect(component.direction()).toBe('in');
        expect(chart().direction()).toBe('in');
        expect(chart().app()).toBe('demo');
        expect(button('In').getAttribute('aria-pressed')).toBe('true');
        expect(component.throughputHint()).toBe('Messages per second each client sent, stacked, over the last 120 s');
        chart().total.set(42.25);
        expect(component.throughputHint()).toBe('Messages per second each client sent, stacked, over the last 120 s; total now 42.3');

        // setDirection, as the button's click: a DOM click in this harness ticks recursively (NG0101)
        await component.setDirection('out');
        harness.detectChanges();

        expect(TestBed.inject(Router).url).toBe('/clients?app=demo&throughput=out');
        expect(chart().direction()).toBe('out');
        expect(button('Out').getAttribute('aria-pressed')).toBe('true');
        expect(button('In').getAttribute('aria-pressed')).toBe('false');
        expect(component.throughputHint()).toBe('Messages per second sent to each client, stacked, over the last 120 s; total now 42.3');

        await component.setDirection('in');
        expect(TestBed.inject(Router).url).toBe('/clients?app=demo');
    });
});

describe('sortClients', () => {
    it('sorts by app and name by default, and a column either way', () => {
        const rows = [
            client({ id: '1', app: 'b', name: 'x', in: 3 }),
            client({ id: '2', app: 'a', name: 'y', in: null }),
            client({ id: '3', app: 'a', name: 'x', in: 7 })
        ];
        expect(sortClients(rows, null).map(r => r.id)).toEqual([ '3', '2', '1' ]);
        expect(sortClients(rows, { key: 'in', descending: true }).map(r => r.id)).toEqual([ '3', '1', '2' ]);
        expect(sortClients(rows, { key: 'in', descending: false }).map(r => r.id)).toEqual([ '1', '3', '2' ]);
        // the longest connected first
        expect(sortClients([ client({ id: 'new', connectedAt: 9 }), client({ id: 'old', connectedAt: 1 }) ], { key: 'connected', descending: true })
            .map(r => r.id)).toEqual([ 'old', 'new' ]);
    });

    it('sorts by transport: unencrypted, then TLS at a proxy, then TLS, per transport', () => {
        const rows = [
            client({ id: 'web-tls', transport: 'web', tls: true }),
            client({ id: 'web-proxy', transport: 'web', tlsAtProxy: true }),
            client({ id: 'web-plain', transport: 'web' }),
            client({ id: 'tcp-tls', tls: true }),
            client({ id: 'tcp-proxy', tlsAtProxy: true }),
            client({ id: 'tcp-plain' })
        ];
        expect(sortClients(rows, { key: 'transport', descending: false }).map(r => r.id))
            .toEqual([ 'tcp-plain', 'tcp-proxy', 'tcp-tls', 'web-plain', 'web-proxy', 'web-tls' ]);
        expect(sortClients(rows, { key: 'transport', descending: true }).map(r => r.id))
            .toEqual([ 'web-tls', 'web-proxy', 'web-plain', 'tcp-tls', 'tcp-proxy', 'tcp-plain' ]);
    });

    it('reads a sort from the address, and nothing it does not know', () => {
        expect(parseSort('-latency')).toEqual({ key: 'latency', descending: true });
        expect(parseSort('name')).toEqual({ key: 'name', descending: false });
        expect(parseSort('password')).toBeNull();
        expect(parseSort(null)).toBeNull();
    });
});
