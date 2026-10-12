import { TestBed } from '@angular/core/testing';
import { EnvironmentInjector, createEnvironmentInjector, runInInjectionContext, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { ADMIN_CHANNEL, AdminFeed, AdminQuery, AdminService, Snapshot } from './admin.service';
import { Reconnect, SocketIOService } from './socketio.service';

interface Answer extends Snapshot {
    value: string;
}

describe('AdminService', () => {
    let channel: Subject<{ command: string; payload: unknown }>;
    let reconnected: Subject<Reconnect>;
    let emit: ReturnType<typeof vi.fn>;

    const answer = (topic: string, request: number | null, value = 'x') =>
        channel.next({ command: topic, payload: { request, at: 1000, value } });
    const sent = () => emit.mock.calls.map(call => [ call[1], call[2] ]);
    const lastRequest = (): number => emit.mock.lastCall![2].request;

    // A feed as a page holds it: until its injector, standing in for the page, is destroyed.
    const open = (topic: 'server' | 'clients' | 'models' | 'model', options: { query?: () => AdminQuery | null; live?: () => boolean } = {}) => {
        const injector = createEnvironmentInjector([], TestBed.inject(EnvironmentInjector));
        const feed = runInInjectionContext(injector, () => TestBed.inject(AdminService).feed<Answer>(topic, options));
        TestBed.flushEffects();
        return { feed: feed as AdminFeed<Answer>, close: () => injector.destroy() };
    };

    beforeEach(() => {
        channel = new Subject();
        reconnected = new Subject();
        emit = vi.fn();

        TestBed.configureTestingModule({
            providers: [{
                provide: SocketIOService,
                useValue: { listen: () => channel.asObservable(), emit, reconnected$: reconnected.asObservable() }
            }]
        });
    });

    it('subscribes while a page shows a topic, and ends the subscription with the page', () => {
        const { feed, close } = open('clients');
        expect(sent()).toEqual([ [ 'subscribe', { topic: 'clients', request: 1 } ] ]);
        expect(feed.loading()).toBe(true);

        answer('clients', 1, 'first');
        answer('clients', 1, 'second');
        expect(feed.data()?.value).toBe('second');
        expect(feed.loading()).toBe(false);

        close();
        expect(emit).toHaveBeenLastCalledWith(ADMIN_CHANNEL, 'unsubscribe', { topic: 'clients' });
    });

    it('drops the answers to a question asked before the latest', () => {
        const query = signal<AdminQuery>({ filter: 'a' });
        const { feed } = open('models', { query });

        query.set({ filter: 'b' });
        TestBed.flushEffects();
        expect(emit).toHaveBeenLastCalledWith(ADMIN_CHANNEL, 'subscribe', { topic: 'models', filter: 'b', request: 2 });

        answer('models', 1, 'old');
        expect(feed.data()).toBeNull();
        answer('models', 2, 'new');
        answer('models', 1, 'old again');
        expect(feed.data()?.value).toBe('new');
        // another page's answers, or a server that echoes nothing
        answer('models', null, 'none');
        expect(feed.data()?.value).toBe('new');
    });

    it('asks once when not live, and ends the subscription when live goes off', () => {
        const live = signal(true);
        const { feed } = open('model', { query: () => ({ app: 'a', channel: 'c', id: 'm' }), live });

        live.set(false);
        TestBed.flushEffects();
        expect(sent()).toEqual([
            [ 'subscribe', { topic: 'model', app: 'a', channel: 'c', id: 'm', request: 1 } ],
            [ 'unsubscribe', { topic: 'model' } ],
            [ 'request', { topic: 'model', app: 'a', channel: 'c', id: 'm', request: 2 } ]
        ]);

        feed.refresh();
        expect(emit).toHaveBeenLastCalledWith(ADMIN_CHANNEL, 'request', expect.objectContaining({ request: 3 }));
    });

    it('asks for nothing while there is nothing to ask', () => {
        const query = signal<AdminQuery | null>(null);
        const { feed } = open('model', { query });
        expect(emit).not.toHaveBeenCalled();
        expect(feed.loading()).toBe(false);

        query.set({ app: 'a', channel: 'c', id: 'm' });
        TestBed.flushEffects();
        query.set(null);
        TestBed.flushEffects();
        expect(sent().map(([ command ]) => command)).toEqual([ 'subscribe', 'unsubscribe' ]);
    });

    // the server forgets every subscription when the connection goes
    it('asks again after a reconnect', () => {
        open('server');
        reconnected.next({ lostAt: 1000, at: 2000 });

        expect(sent()).toEqual([
            [ 'subscribe', { topic: 'server', request: 1 } ],
            [ 'subscribe', { topic: 'server', request: 2 } ]
        ]);
    });

    it('leaves a topic to the page that took it over', () => {
        const first = open('clients');
        const second = open('clients');
        answer('clients', lastRequest());
        expect(second.feed.data()).not.toBeNull();

        first.close();
        expect(sent().map(([ command ]) => command)).toEqual([ 'subscribe', 'subscribe' ]);
        second.close();
        expect(emit).toHaveBeenLastCalledWith(ADMIN_CHANNEL, 'unsubscribe', { topic: 'clients' });
    });
});
