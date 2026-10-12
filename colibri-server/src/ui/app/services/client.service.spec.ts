import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { ADMIN_CHANNEL, LatencySnapshot } from './admin.service';
import { ClientService, ColibriClient, LATENCY_KEEP_MILLIS } from './client.service';
import { Reconnect, SocketIOService } from './socketio.service';

describe('ClientService', () => {
    let latencyChannel: Subject<{ command: string; payload: Record<string, [number, number][]> }>;
    let clientsChannel: Subject<{ command: string; payload: Partial<ColibriClient> }>;
    let adminChannel: Subject<{ command: string; payload: LatencySnapshot }>;
    let reconnected: Subject<Reconnect>;
    let emit: ReturnType<typeof vi.fn>;

    const history = (at: number, clients: Record<string, [number, number][]>, request = 1) => adminChannel.next({
        command: 'latency',
        payload: { request, at, clients: Object.entries(clients).map(([ id, samples ]) => ({ id, samples })), total: 1, medians: false }
    });

    beforeEach(() => {
        latencyChannel = new Subject();
        clientsChannel = new Subject();
        adminChannel = new Subject();
        reconnected = new Subject();
        emit = vi.fn();

        TestBed.configureTestingModule({
            providers: [{
                provide: SocketIOService,
                useValue: {
                    listen: (channel: string) =>
                        (channel === 'colibri::latency' ? latencyChannel : channel === ADMIN_CHANNEL ? adminChannel : clientsChannel).asObservable(),
                    emit,
                    reconnected$: reconnected.asObservable()
                }
            }]
        });
    });

    it('asks for the clients and then their latency history, and again after a reconnect, forgetting the old ones', () => {
        const service = TestBed.inject(ClientService);

        clientsChannel.next({ command: 'client::connected', payload: { id: 'a', app: 'colibri', name: 'A', version: '1' } });
        reconnected.next({ lostAt: 1000, at: 2000 });

        expect(service.clients()).toEqual([]);
        expect(emit.mock.calls).toEqual([
            [ 'colibri::clients', 'client::request', {} ],
            [ ADMIN_CHANNEL, 'request', { topic: 'latency', request: 1 } ],
            [ 'colibri::clients', 'client::request', {} ],
            [ ADMIN_CHANNEL, 'request', { topic: 'latency', request: 2 } ]
        ]);
    });

    it('adds a client on client::connected', () => {
        const service = TestBed.inject(ClientService);

        clientsChannel.next({ command: 'client::connected', payload: { id: 'a', app: 'colibri', name: 'A', version: '1' } });

        expect(service.clients().map(c => c.id)).toEqual(['a']);
        expect(service.clients()[0].latency).toEqual([]);
    });

    it('removes a client on client::disconnected', () => {
        const service = TestBed.inject(ClientService);

        clientsChannel.next({ command: 'client::connected', payload: { id: 'a', app: 'colibri', name: 'A', version: '1' } });
        clientsChannel.next({ command: 'client::connected', payload: { id: 'b', app: 'colibri', name: 'B', version: '1' } });
        clientsChannel.next({ command: 'client::disconnected', payload: { id: 'a' } });

        expect(service.clients().map(c => c.id)).toEqual(['b']);
    });

    // the colour of every client after a leaving one used to change
    it('gives a client the lowest free colour slot, and keeps it while others leave', () => {
        const service = TestBed.inject(ClientService);
        const connect = (id: string) => clientsChannel.next({ command: 'client::connected', payload: { id, app: 'demo', name: id, version: '2' } });

        connect('a');
        connect('b');
        connect('c');
        clientsChannel.next({ command: 'client::disconnected', payload: { id: 'a' } });
        connect('d');
        connect('e');

        expect(service.clients().map(c => [ c.id, c.slot ])).toEqual([ [ 'b', 1 ], [ 'c', 2 ], [ 'd', 0 ], [ 'e', 3 ] ]);
    });

    it('appends latency samples for a known client', () => {
        const service = TestBed.inject(ClientService);

        clientsChannel.next({ command: 'client::connected', payload: { id: 'a', app: 'colibri', name: 'A', version: '1' } });
        latencyChannel.next({ command: 'x', payload: { a: [[1000, 5], [1001, 6]] } });
        latencyChannel.next({ command: 'x', payload: { a: [[1002, 7]] } });

        expect(service.clients()[0].latency).toEqual([[1000, 5], [1001, 6], [1002, 7]]);
    });

    it('keeps the samples of the 122 s before the newest, as the server does', () => {
        const service = TestBed.inject(ClientService);

        clientsChannel.next({ command: 'client::connected', payload: { id: 'a', app: 'colibri', name: 'A', version: '1' } });

        // 100 ms apart for 130 s
        const samples: [number, number][] = Array.from({ length: 1301 }, (_, i) => [i * 100, i]);
        latencyChannel.next({ command: 'x', payload: { a: samples } });

        const latency = service.clients()[0].latency;
        expect(LATENCY_KEEP_MILLIS).toBe(122_000);
        expect(latency.length).toBe(1221);
        expect(latency[0]).toEqual([8_000, 80]);
        expect(latency.at(-1)).toEqual([130_000, 1300]);
    });

    it('takes the server\'s history in place of the samples it holds, and joins the live ones on without repeats', () => {
        const service = TestBed.inject(ClientService);

        clientsChannel.next({ command: 'client::connected', payload: { id: 'a', app: 'demo', name: 'A', version: '2' } });
        clientsChannel.next({ command: 'client::connected', payload: { id: 'b', app: 'demo', name: 'B', version: '2' } });
        // an update that came before the history: the history has it too
        latencyChannel.next({ command: 'update', payload: { a: [ [ 9_800, 7 ], [ 9_900, 8 ] ] } });

        // taken at 10_000: every sample before it, none of those at 10_000 itself
        history(10_000, { a: [ [ 9_700, 6 ], [ 9_800, 7 ], [ 9_900, 8 ] ], b: [] });
        expect(service.clients()[0].latency).toEqual([ [ 9_700, 6 ], [ 9_800, 7 ], [ 9_900, 8 ] ]);

        // the samples of the update the history was taken in, and those since
        latencyChannel.next({ command: 'update', payload: { a: [ [ 9_900, 8 ], [ 10_000, 9 ], [ 10_100, 10 ] ], b: [ [ 9_950, 3 ], [ 10_050, 4 ] ] } });
        expect(service.clients()[0].latency).toEqual([ [ 9_700, 6 ], [ 9_800, 7 ], [ 9_900, 8 ], [ 10_000, 9 ], [ 10_100, 10 ] ]);
        expect(service.clients()[1].latency).toEqual([ [ 10_050, 4 ] ]);
    });

    it('keeps the live samples from the history\'s time on, should they come first, and ignores an old answer', () => {
        const service = TestBed.inject(ClientService);

        clientsChannel.next({ command: 'client::connected', payload: { id: 'a', app: 'demo', name: 'A', version: '2' } });
        latencyChannel.next({ command: 'update', payload: { a: [ [ 9_900, 8 ], [ 10_000, 9 ] ] } });
        history(10_000, { a: [ [ 9_900, 8 ] ] });
        expect(service.clients()[0].latency).toEqual([ [ 9_900, 8 ], [ 10_000, 9 ] ]);

        history(20_000, { a: [ [ 1, 1 ] ] }, 0);
        expect(service.clients()[0].latency).toEqual([ [ 9_900, 8 ], [ 10_000, 9 ] ]);
    });

    it('ignores latency samples for unknown clients', () => {
        const service = TestBed.inject(ClientService);

        latencyChannel.next({ command: 'x', payload: { unknown: [[1000, 5]] } });

        expect(service.clients()).toEqual([]);
    });
});
