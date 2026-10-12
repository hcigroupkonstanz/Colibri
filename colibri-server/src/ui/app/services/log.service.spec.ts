import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { FLUSH_INTERVAL, LogMessage, LogService, MAX_MESSAGES, readAddress, writeAddress } from './log.service';
import { Reconnect, SocketIOService } from './socketio.service';

const message = (overrides: Partial<LogMessage>): LogMessage => ({
    id: '1',
    origin: 'test',
    level: 0,
    message: 'm',
    group: 'g',
    created: 1000,
    first: 1000,
    count: 0,
    metadata: {},
    ...overrides
});

describe('LogService', () => {
    let logChannel: Subject<{ command: string; payload: unknown }>;
    let emit: ReturnType<typeof vi.fn>;
    let reconnected: Subject<Reconnect>;

    const live = (overrides: Partial<LogMessage>) => logChannel.next({ command: 'message', payload: message(overrides) });
    const history = (request: number | null, messages: LogMessage[]) => logChannel.next({ command: 'history', payload: { request, messages } });
    const lastRequest = (): number => emit.mock.lastCall![2].request;

    const start = (): LogService => {
        const service = TestBed.inject(LogService);
        TestBed.flushEffects();
        history(lastRequest(), []);
        return service;
    };

    beforeEach(() => {
        vi.useFakeTimers();
        logChannel = new Subject();
        emit = vi.fn();
        reconnected = new Subject();

        TestBed.configureTestingModule({
            providers: [{
                provide: SocketIOService,
                useValue: { listen: () => logChannel.asObservable(), emit, reconnected$: reconnected.asObservable() }
            }]
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('requests the log with the default filter/levels/broadcast payload on construction', () => {
        TestBed.inject(LogService);
        TestBed.flushEffects();

        expect(emit).toHaveBeenCalledWith('colibri::log', 'requestLog', {
            filter: '',
            levels: [ 0, 1, 2, 3 ],
            showBroadcastTraffic: false,
            showConnections: true,
            request: 1
        });
    });

    it('loads the history it asked for, in the order sent', () => {
        const service = TestBed.inject(LogService);
        TestBed.flushEffects();
        expect(service.loading()).toBe(true);

        history(1, [ message({ id: 'a' }), message({ id: 'b' }) ]);

        expect(service.loading()).toBe(false);
        expect(service.messages().map(m => m.id)).toEqual([ 'a', 'b' ]);
    });

    it('takes when the page was opened by the server\'s clock, which stamps the lines', () => {
        vi.setSystemTime(1_000_000);
        const service = TestBed.inject(LogService);
        TestBed.flushEffects();
        expect(service.openedAt()).toBe(1_000_000);

        // the server's clock 5 min ahead of the browser's, read 2 s after the page was opened
        vi.setSystemTime(1_002_000);
        logChannel.next({ command: 'history', payload: { request: lastRequest(), at: 1_302_000, messages: [] } });
        expect(service.openedAt()).toBe(1_300_000);

        // once: later histories do not move it
        service.levels.set(new Set([ 0 ]));
        TestBed.flushEffects();
        logChannel.next({ command: 'history', payload: { request: lastRequest(), at: 9_999_999, messages: [] } });
        expect(service.openedAt()).toBe(1_300_000);
    });

    it('re-requests the log and clears messages when levels change', () => {
        const service = start();

        live({ id: '1' });
        vi.advanceTimersByTime(FLUSH_INTERVAL);
        expect(service.messages().length).toBe(1);

        service.setLevels([ 0 ]);
        TestBed.flushEffects();

        expect(service.messages().length).toBe(0);
        expect(emit).toHaveBeenLastCalledWith('colibri::log', 'requestLog', {
            filter: '',
            levels: [ 0 ],
            showBroadcastTraffic: false,
            showConnections: true,
            request: 2
        });
    });

    it('re-requests the log and clears messages when showBroadcastTraffic changes', () => {
        const service = start();

        live({ id: '1' });
        vi.advanceTimersByTime(FLUSH_INTERVAL);
        expect(service.messages().length).toBe(1);

        service.showBroadcastTraffic.set(true);
        TestBed.flushEffects();

        expect(service.messages().length).toBe(0);
        expect(emit).toHaveBeenLastCalledWith('colibri::log', 'requestLog', {
            filter: '',
            levels: [ 0, 1, 2, 3 ],
            showBroadcastTraffic: true,
            showConnections: true,
            request: 2
        });
    });

    // Lines sent before the server saw the new request were filtered by the old preferences,
    // and an older request's history can still be on its way.
    it('ignores live lines and older histories until the history it asked for arrives', () => {
        const service = start();

        service.setLevels([ 0 ]);
        TestBed.flushEffects();
        service.setLevels([ 0, 1 ]);
        TestBed.flushEffects();

        live({ id: 'old-live', level: 3 });
        history(2, [ message({ id: 'old-history', level: 3 }) ]);
        vi.advanceTimersByTime(FLUSH_INTERVAL);
        expect(service.messages()).toEqual([]);
        expect(service.loading()).toBe(true);

        history(3, [ message({ id: 'current' }) ]);
        live({ id: 'after' });
        vi.advanceTimersByTime(FLUSH_INTERVAL);

        expect(service.messages().map(m => m.id)).toEqual([ 'current', 'after' ]);
    });

    it('asks the server to leave out the connection lines, and again to show them', () => {
        const service = start();

        service.showConnections.set(false);
        TestBed.flushEffects();
        expect(emit).toHaveBeenLastCalledWith('colibri::log', 'requestLog', expect.objectContaining({ showConnections: false, request: 2 }));

        service.showConnections.set(true);
        TestBed.flushEffects();
        expect(emit).toHaveBeenLastCalledWith('colibri::log', 'requestLog', expect.objectContaining({ showConnections: true, request: 3 }));
    });

    // a tab, or a link from another page, opens /log without the filters the page still has
    it('puts its filters back in an address without them', () => {
        const service = start();
        const path = location.pathname + location.search + location.hash;
        try {
            service.filter.set('demo app');
            service.setLevels([ 0, 1 ]);
            service.search.set('asset');
            service.showConnections.set(false);
            TestBed.flushEffects();
            window.history.replaceState(null, '', '/log');

            service.openPage();

            expect(location.pathname + location.search + location.hash).toBe('/log?levels=error,warn&q=asset&connections=0#demo%20app');
        } finally {
            service.closePage();
            window.history.replaceState(null, '', path);
        }
    });

    it('takes its filters from a link with them in the address, with one new request', () => {
        const service = start();
        const path = location.pathname + location.search + location.hash;
        try {
            window.history.replaceState(null, '', '/log?levels=error,debug&q=frame+time&sync=1&connections=0#demo');
            const requests = emit.mock.calls.length;

            service.openPage();
            TestBed.flushEffects();

            expect([ service.filter(), [ ...service.levels() ], service.search(), service.showBroadcastTraffic(), service.showConnections() ])
                .toEqual([ 'demo', [ 0, 3 ], 'frame time', true, false ]);
            expect(emit.mock.calls.length).toBe(requests + 1);
        } finally {
            service.closePage();
            window.history.replaceState(null, '', path);
        }
    });

    it('follows the address when it changes on the open page, and only there', () => {
        const service = start();
        const path = location.pathname + location.search + location.hash;
        try {
            window.history.replaceState(null, '', '/log');
            service.openPage();

            location.hash = 'other-app';
            window.dispatchEvent(new HashChangeEvent('hashchange'));
            expect(service.filter()).toBe('other-app');

            // on the way to another page, the address is that page's
            window.history.replaceState(null, '', '/clients?app=x');
            window.dispatchEvent(new PopStateEvent('popstate'));
            expect(service.filter()).toBe('other-app');
        } finally {
            service.closePage();
            window.history.replaceState(null, '', path);
        }
    });

    it('writes the filters into the address and reads them back, the defaults left out', () => {
        const address = { filter: 'a b', levels: [ 1, 2 ], search: 'x&y=z', showBroadcastTraffic: true, showConnections: false };
        const { search, hash } = writeAddress(address);

        expect(search).toBe('?levels=warn,info&q=x%26y%3Dz&sync=1&connections=0');
        expect(readAddress(search, hash)).toEqual(address);
        expect(writeAddress({ ...address, filter: '', levels: [ 0, 1, 2, 3 ], search: '', showBroadcastTraffic: false, showConnections: true }))
            .toEqual({ search: '', hash: '' });
        expect(readAddress('?levels=none', '').levels).toEqual([]);
        expect(readAddress('?levels=bogus,ERROR', '').levels).toEqual([ 0 ]);
    });

    it('shows live lines in batches', () => {
        const service = start();

        live({ id: '1' });
        live({ id: '2' });
        expect(service.messages()).toEqual([]);

        vi.advanceTimersByTime(FLUSH_INTERVAL);

        expect(service.messages().map(m => m.id)).toEqual([ '1', '2' ]);
    });

    it('updates an existing message and moves it to the end', () => {
        const service = start();

        live({ id: '1', count: 0 });
        live({ id: '2', count: 0 });
        vi.advanceTimersByTime(FLUSH_INTERVAL);
        const before = service.messages().find(m => m.id === '1');

        live({ id: '1', count: 1, created: 2000 });
        vi.advanceTimersByTime(FLUSH_INTERVAL);

        expect(service.messages().map(m => m.id)).toEqual([ '2', '1' ]);
        expect(service.messages().find(m => m.id === '1')?.count).toBe(1);
        // Must be a new object, not the same one mutated in place: LogMessageComponent is OnPush
        // with a signal input, so a same-reference update would never re-render the row's
        // count/timestamp - it would only appear to jump position in the list.
        expect(service.messages().find(m => m.id === '1')).not.toBe(before);
    });

    it('leaves a line in place when it is sent again unchanged', () => {
        const service = start();

        live({ id: '1' });
        live({ id: '2' });
        vi.advanceTimersByTime(FLUSH_INTERVAL);
        live({ id: '1' });
        vi.advanceTimersByTime(FLUSH_INTERVAL);

        expect(service.messages().map(m => m.id)).toEqual([ '1', '2' ]);
    });

    it('keeps the newest MAX_MESSAGES lines', () => {
        const service = start();

        for (let i = 0; i < MAX_MESSAGES; i++) {
            live({ id: `${i}` });
        }
        vi.advanceTimersByTime(FLUSH_INTERVAL);
        expect(service.messages().length).toBe(MAX_MESSAGES);
        expect(service.messages()[0].id).toBe('0');

        live({ id: 'new' });
        vi.advanceTimersByTime(FLUSH_INTERVAL);

        expect(service.messages().length).toBe(MAX_MESSAGES);
        expect(service.messages()[0].id).toBe('1');
        expect(service.messages().at(-1)?.id).toBe('new');
    });

    it('keeps its lines after a reconnect, marks the gap and adds the history after it', () => {
        const service = start();

        live({ id: 'before' });
        live({ id: 'repeated', count: 0 });
        vi.advanceTimersByTime(FLUSH_INTERVAL);

        reconnected.next({ lostAt: 5000, at: 9000 });
        expect(emit).toHaveBeenLastCalledWith('colibri::log', 'requestLog', expect.objectContaining({ request: 2 }));

        history(2, [
            message({ id: 'before' }),
            message({ id: 'meanwhile', created: 6000 }),
            message({ id: 'repeated', count: 1, created: 7000 })
        ]);

        const rows = service.messages();
        expect(rows.map(m => m.id)).toEqual([ 'before', 'reconnect-9000', 'meanwhile', 'repeated' ]);
        expect(rows[1]).toEqual(expect.objectContaining({ reconnect: true, first: 5000, created: 9000 }));
        expect(rows[3].count).toBe(1);
    });

    it('counts the loaded lines of each level, without the reconnect rows', () => {
        const service = start();

        live({ id: '1', level: 0 });
        live({ id: '2', level: 3 });
        live({ id: '3', level: 3 });
        vi.advanceTimersByTime(FLUSH_INTERVAL);
        reconnected.next({ lostAt: 5000, at: 9000 });

        expect(service.levelCounts()).toEqual([ 1, 0, 0, 2 ]);
    });

    it('clears every filter, the search included, with one new request', () => {
        const service = start();
        service.filter.set('demo');
        service.setLevels([ 0 ]);
        service.showBroadcastTraffic.set(true);
        service.search.set('asset');
        TestBed.flushEffects();
        const requests = emit.mock.calls.length;

        service.clearFilters();
        TestBed.flushEffects();

        expect([ service.filter(), [ ...service.levels() ], service.showBroadcastTraffic(), service.search() ])
            .toEqual([ '', [ 0, 1, 2, 3 ], false, '' ]);
        expect(emit.mock.calls.length).toBe(requests + 1);
    });

    it('remembers every app it has seen, across filter changes', () => {
        const service = start();

        live({ id: '1', metadata: { clientApp: 'a' } });
        live({ id: '2', metadata: { clientApp: 'b' } });
        vi.advanceTimersByTime(FLUSH_INTERVAL);

        service.filter.set('a');
        TestBed.flushEffects();

        expect([ ...service.apps() ]).toEqual([ 'a', 'b' ]);
    });
});
