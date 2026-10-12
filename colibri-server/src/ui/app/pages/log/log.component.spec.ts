import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { Subject } from 'rxjs';
import { ConnectionState, LogMessage, LogService, Reconnect, SocketIOService } from '../../services';
import { FLUSH_INTERVAL } from '../../services/log.service';
import { LogComponent, PAGE_SIZE, textLine } from './log.component';

const message = (overrides: Partial<LogMessage>): LogMessage => ({
    id: '1',
    origin: 'test',
    level: 2,
    message: 'm',
    group: 'g',
    created: 1000,
    first: 1000,
    count: 0,
    metadata: {},
    ...overrides
});

describe('LogComponent', () => {
    let channels: Map<string, Subject<{ command: string; payload: unknown }>>;
    let emit: ReturnType<typeof vi.fn>;
    let state: ReturnType<typeof signal<ConnectionState>>;
    let lostAt: ReturnType<typeof signal<number | null>>;

    const channel = (name: string) => {
        if (!channels.has(name)) channels.set(name, new Subject());
        return channels.get(name)!;
    };
    const history = (messages: LogMessage[]) => {
        const request = emit.mock.calls.filter(call => call[1] === 'requestLog').at(-1)![2].request;
        channel('colibri::log').next({ command: 'history', payload: { request, messages } });
    };
    const live = (overrides: Partial<LogMessage>) => {
        channel('colibri::log').next({ command: 'message', payload: message(overrides) });
        vi.advanceTimersByTime(FLUSH_INTERVAL);
    };

    // the page created last
    let page: HTMLElement;

    const create = () => {
        const fixture = TestBed.createComponent(LogComponent);
        page = fixture.nativeElement;
        fixture.detectChanges();
        TestBed.flushEffects();
        return { fixture, component: fixture.componentInstance, log: TestBed.inject(LogService) };
    };

    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('ResizeObserver', class {
            observe(): void { /* not needed here */ }
            disconnect(): void { /* not needed here */ }
        });
        channels = new Map();
        emit = vi.fn();
        state = signal<ConnectionState>('connected');
        lostAt = signal<number | null>(null);

        TestBed.configureTestingModule({
            providers: [provideRouter([]), {
                provide: SocketIOService,
                useValue: {
                    listen: (name: string) => channel(name).asObservable(),
                    emit,
                    reconnected$: new Subject<Reconnect>().asObservable(),
                    state,
                    lostAt
                }
            }]
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('shows the newest page of lines, and older ones on request', () => {
        const { fixture, component } = create();
        history(Array.from({ length: PAGE_SIZE + 5 }, (_, i) => message({ id: `${i}` })));
        fixture.detectChanges();

        expect(component.rows().length).toBe(PAGE_SIZE);
        expect(component.rows()[0].id).toBe('5');
        expect(fixture.nativeElement.querySelector('.older').textContent).toContain('Show 5 older lines');

        component.showOlder();
        expect(component.rows().length).toBe(PAGE_SIZE + 5);
    });

    it('shows only the lines that match the search', () => {
        const { component, log } = create();
        history([ message({ id: 'a', message: 'Scene loaded' }), message({ id: 'b', message: 'Asset missing' }) ]);

        log.search.set('ASSET');

        expect(component.rows().map(r => r.id)).toEqual([ 'b' ]);
        expect(component.matches().length).toBe(1);
    });

    // new lines, repeats moving to the end and old lines making room would move what is read
    it('keeps the lines still while paused, counts the new ones, and catches up on follow', () => {
        const { component } = create();
        history([ message({ id: 'a' }), message({ id: 'b' }) ]);

        component.pause();
        live({ id: 'c' });
        live({ id: 'a', count: 1, created: 2000 });
        live({ id: 'c', count: 1, created: 3000 });

        expect(component.rows().map(r => r.id)).toEqual([ 'a', 'b' ]);
        // a repeat is not a new line
        expect(component.newLines()).toBe(1);

        component.follow();
        expect(component.rows().map(r => r.id)).toEqual([ 'b', 'a', 'c' ]);
        expect(component.newLines()).toBe(0);
    });

    it('follows again when the filters change, since the server sends a new history', () => {
        const { component, log } = create();
        history([ message({ id: 'a' }) ]);
        component.pause();

        log.setLevels([ 0 ]);
        TestBed.flushEffects();

        expect(component.following()).toBe(true);
    });

    it('says why the log is empty, with a way out', () => {
        const { fixture, component, log } = create();
        history([]);
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('.empty').textContent).toContain('No log lines yet.');

        log.setLevels([]);
        TestBed.flushEffects();
        history([]);
        expect(component.empty()?.text).toBe('All levels are hidden.');

        log.setLevels([ 0, 1, 2, 3 ]);
        log.filter.set('no-such-app');
        TestBed.flushEffects();
        history([]);
        expect(component.empty()?.text).toBe('No lines from no-such-app at these levels.');
        component.empty()?.action?.run();
        expect(log.filter()).toBe('');
    });

    it('pauses on a click on a line, but not on the empty state\'s button', () => {
        const { fixture, component, log } = create();
        history([ message({ id: 'a', message: 'Scene loaded' }) ]);
        log.search.set('zzz');
        fixture.detectChanges();

        (fixture.nativeElement.querySelector('.empty button') as HTMLElement).click();
        fixture.detectChanges();
        expect(log.search()).toBe('');
        expect(component.following()).toBe(true);

        (fixture.nativeElement.querySelector('app-log-message .message') as HTMLElement).click();
        expect(component.following()).toBe(false);
    });

    it('shows that the connection is lost', () => {
        const { fixture } = create();
        history([ message({ id: 'a' }) ]);
        expect(fixture.nativeElement.querySelector('.banner')).toBeNull();

        state.set('reconnecting');
        lostAt.set(new Date(2026, 9, 10, 12, 30, 5).getTime());
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('.banner').textContent).toContain('Connection to the server lost at 12:30:05.');
    });

    describe('errors and warnings', () => {
        // on the log, where the keys work, unless said otherwise
        const key = (key: string, target: EventTarget = page.querySelector('.scroller')!) =>
            target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

        beforeEach(() => {
            Element.prototype.scrollIntoView = vi.fn();
        });

        afterEach(() => {
            delete (Element.prototype as Partial<Element>).scrollIntoView;
        });

        it('goes through them with p and n, from the end and round, and pauses there', () => {
            const { fixture, component } = create();
            history([ message({ id: 'e', level: 0 }), message({ id: 'i' }), message({ id: 'w', level: 1 }), message({ id: 'd', level: 3 }) ]);
            fixture.detectChanges();
            expect(component.nav()).toEqual(expect.objectContaining({ problems: 2, position: null }));

            // the log 300px high, 100px from the top; the warning 20px high, 900px from it
            const scroller: HTMLElement = fixture.nativeElement.querySelector('.scroller');
            let scrollTop = 0;
            Object.defineProperty(scroller, 'scrollTop', { get: () => scrollTop, set: (value: number) => { scrollTop = value; } });
            Object.defineProperty(scroller, 'clientHeight', { value: 300 });
            scroller.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
            const warning: HTMLElement = fixture.nativeElement.querySelector('app-log-message[data-id="w"]');
            Object.defineProperty(warning, 'offsetHeight', { value: 20 });
            warning.getBoundingClientRect = () => ({ top: 900 }) as DOMRect;

            key('p');
            expect([ component.current(), component.following(), component.nav().position ]).toEqual([ 'w', false, 2 ]);
            // The scroll to it waits for the render, and moves the log only: scrollIntoView would
            // move the page around it too.
            TestBed.tick();
            expect(scrollTop).toBe(800 - (300 - 20) / 2);
            expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
            key('p');
            expect(component.current()).toBe('e');
            key('p');
            expect(component.current()).toBe('w');
            key('n');
            expect(component.current()).toBe('e');

            fixture.detectChanges();
            expect(fixture.nativeElement.querySelector('.row.current .message').textContent).toBe('m');

            // Previous and Next by "Jump to latest", for a phone, where the toolbar's are folded away
            const [ previous, next ] = fixture.nativeElement.querySelectorAll('.jump-bar .jump-step') as NodeListOf<HTMLButtonElement>;
            next.click();
            expect(component.current()).toBe('w');
            previous.click();
            expect(component.current()).toBe('e');

            component.follow();
            expect(component.current()).toBeNull();
            fixture.detectChanges();
            expect(fixture.nativeElement.querySelector('.jump-bar')).toBeNull();
        });

        it('ignores the keys while typing, and with the focus outside the log', () => {
            const { fixture, component } = create();
            history([ message({ id: 'e', level: 0 }) ]);

            key('n', fixture.nativeElement.querySelector('.search input'));
            expect(component.current()).toBeNull();
            key('n', document.body);
            key('e', document.body);
            expect(component.current()).toBeNull();
        });

        it('takes the focus on a page just loaded, so that the keys work, and goes to the search on /', () => {
            const fixture = TestBed.createComponent(LogComponent);
            page = fixture.nativeElement;
            document.body.appendChild(page);
            (document.activeElement as HTMLElement | null)?.blur();
            fixture.detectChanges();
            TestBed.tick();
            expect(document.activeElement).toBe(fixture.nativeElement.querySelector('.scroller'));

            key('/');
            expect(document.activeElement).toBe(fixture.nativeElement.querySelector('.search input'));
            fixture.nativeElement.remove();
        });

        it('goes to the first error since the page was opened with e', () => {
            const { component, log } = create();
            history([
                message({ id: 'old', level: 0, created: log.openedAt() - 1 }),
                message({ id: 'new', level: 0, created: log.openedAt() + 5 }),
                message({ id: 'newer', level: 0, created: log.openedAt() + 9 })
            ]);
            expect(component.nav().newErrors).toBe(2);

            key('e');
            expect(component.current()).toBe('new');
        });

        it('shows the older lines it takes to get to one', () => {
            const { component } = create();
            history([ message({ id: 'first', level: 1 }), ...Array.from({ length: PAGE_SIZE + 5 }, (_, i) => message({ id: `${i}` })) ]);
            expect(component.rows().some(row => row.id === 'first')).toBe(false);

            component.navigate('next');

            expect(component.rows()[0].id).toBe('first');
        });
    });

    describe('download', () => {
        // what the page offers for download: its name and its text
        let files: { name: string; text: string }[];
        let blobs: string[];

        beforeEach(() => {
            files = [];
            blobs = [];
            // jsdom's Blob cannot be read back
            vi.stubGlobal('Blob', class {
                constructor(public parts: string[]) {}
            });
            URL.createObjectURL = vi.fn((blob: { parts: string[] }) => {
                blobs.push(blob.parts.join(''));
                return `blob:${blobs.length}`;
            }) as unknown as typeof URL.createObjectURL;
            URL.revokeObjectURL = vi.fn();
            vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
                files.push({ name: this.download, text: blobs[Number(this.href.split(':').at(-1)) - 1] });
            });
        });

        afterEach(() => {
            vi.restoreAllMocks();
        });

        it('saves the lines that match the filters and the search, as text and as JSON', () => {
            const { component, log } = create();
            history([
                message({ id: 'a', message: '[Quest] Scene loaded', metadata: { clientApp: 'demo', clientName: 'Quest', clientId: 'q1' } }),
                message({ id: 'b', level: 0, message: 'Asset missing\nat Load()', count: 2, first: 500 })
            ]);
            log.search.set('asset');

            component.download('text');
            component.download('json');

            expect(files.map(file => file.name)).toEqual([ expect.stringMatching(/^colibri-log-\d{8}-\d{6}\.txt$/), expect.stringMatching(/\.json$/) ]);
            const text = files[0].text;
            expect(text).toContain('# App: all. Levels: error, warn, info, debug. Search: asset. Sync traffic hidden. Connections shown.');
            expect(text).toContain('# 1 line\n');
            expect(text).toContain('ERR g/test: Asset missing\n    at Load() [3 times since ');
            expect(text).not.toContain('Scene loaded');

            const json = JSON.parse(files[1].text);
            expect(json.filters).toEqual({ app: '', levels: [ 'error', 'warn', 'info', 'debug' ], search: 'asset', syncTraffic: false, connections: true });
            expect(json.lines.map((line: LogMessage) => line.id)).toEqual([ 'b' ]);
        });

        it('writes a client\'s line with its app, name and id', () => {
            const line = textLine(message({ message: '[Quest] Scene loaded', metadata: { clientApp: 'demo', clientName: 'Quest', clientId: 'q1' } }));
            expect(line).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} INF demo Quest \(q1\): Scene loaded$/);
        });
    });
});
