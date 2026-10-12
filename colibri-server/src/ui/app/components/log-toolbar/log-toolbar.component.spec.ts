import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ClientService, ColibriClient, LogService } from '../../services';
import { LogNav, LogToolbarComponent, NavStep, PHONE, SEARCH_DELAY } from './log-toolbar.component';

describe('LogToolbarComponent', () => {
    let log: {
        filter: ReturnType<typeof signal<string>>;
        levels: ReturnType<typeof signal<ReadonlySet<number>>>;
        showBroadcastTraffic: ReturnType<typeof signal<boolean>>;
        showConnections: ReturnType<typeof signal<boolean>>;
        search: ReturnType<typeof signal<string>>;
        apps: ReturnType<typeof signal<ReadonlySet<string>>>;
        levelCounts: ReturnType<typeof signal<number[]>>;
        setLevels: (values: ReadonlyArray<number>) => void;
        clearFilters: () => void;
    };
    let clients: ReturnType<typeof signal<ReadonlyArray<ColibriClient>>>;

    const client = (id: string, app: string): ColibriClient => ({ id, app, name: id, version: '2', latency: [], slot: 0 });

    beforeEach(() => {
        log = {
            filter: signal(''),
            levels: signal<ReadonlySet<number>>(new Set([ 0, 1, 2, 3 ])),
            showBroadcastTraffic: signal(false),
            showConnections: signal(true),
            search: signal(''),
            apps: signal<ReadonlySet<string>>(new Set()),
            levelCounts: signal([ 0, 0, 0, 0 ]),
            setLevels: (values) => log.levels.set(new Set(values)),
            clearFilters: vi.fn()
        };
        clients = signal<ReadonlyArray<ColibriClient>>([]);

        TestBed.configureTestingModule({
            providers: [
                { provide: LogService, useValue: log },
                { provide: ClientService, useValue: { clients } }
            ]
        });
    });

    it('turns a level off and on again', () => {
        const component = TestBed.createComponent(LogToolbarComponent).componentInstance;

        component.toggleLevel(3);
        expect([ ...log.levels() ]).toEqual([ 0, 1, 2 ]);

        component.toggleLevel(3);
        expect([ ...log.levels() ]).toEqual([ 0, 1, 2, 3 ]);
    });

    // filtered to one app, the log holds only that app's lines: the list must not shrink to it
    it('offers every app seen or connected, and the one filtered to, but not the admin UI', () => {
        log.apps.set(new Set([ 'seen' ]));
        log.filter.set('linked');
        clients.set([ client('a', 'connected'), client('b', 'connected'), client('c', 'seen'), client('d', 'colibri') ]);

        const component = TestBed.createComponent(LogToolbarComponent).componentInstance;

        expect(component.appOptions()).toEqual([
            { name: 'connected', clients: 2 },
            { name: 'linked', clients: 0 },
            { name: 'seen', clients: 1 }
        ]);
    });

    // it used to show the placeholder whatever was chosen
    it('shows the chosen app in the select', async () => {
        log.filter.set('demo');
        const fixture = TestBed.createComponent(LogToolbarComponent);
        fixture.detectChanges();
        // ngModel writes its value a microtask later
        await fixture.whenStable();
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('.apps .p-select-label').textContent.trim()).toBe('demo');
    });

    it('searches once typing pauses', () => {
        vi.useFakeTimers();
        try {
            const component = TestBed.createComponent(LogToolbarComponent).componentInstance;

            component.onSearch('ass');
            component.onSearch('asset ');
            expect(log.search()).toBe('');

            vi.advanceTimersByTime(SEARCH_DELAY);
            expect(log.search()).toBe('asset');
        } finally {
            vi.useRealTimers();
        }
    });

    // the trimmed search used to be written back into the field, eating the space just typed
    it('keeps what is typed in the field, and shows a search set elsewhere', () => {
        vi.useFakeTimers();
        try {
            const fixture = TestBed.createComponent(LogToolbarComponent);
            fixture.detectChanges();
            const input: HTMLInputElement = fixture.nativeElement.querySelector('.search input');

            input.value = 'frame ';
            input.dispatchEvent(new Event('input'));
            vi.advanceTimersByTime(SEARCH_DELAY);
            fixture.detectChanges();
            expect(log.search()).toBe('frame');
            expect(input.value).toBe('frame ');

            input.value = 'frame t';
            input.dispatchEvent(new Event('input'));
            log.search.set('');
            fixture.detectChanges();
            vi.advanceTimersByTime(SEARCH_DELAY);
            fixture.detectChanges();
            expect(input.value).toBe('');
            expect(log.search()).toBe('');
        } finally {
            vi.useRealTimers();
        }
    });

    it('clears the search with its own button, and stays in the field', () => {
        const fixture = TestBed.createComponent(LogToolbarComponent);
        fixture.detectChanges();
        document.body.appendChild(fixture.nativeElement);
        const input: HTMLInputElement = fixture.nativeElement.querySelector('.search input');
        expect(fixture.nativeElement.querySelector('.clear-search')).toBeNull();

        input.value = 'asset';
        input.dispatchEvent(new Event('input'));
        fixture.detectChanges();
        (fixture.nativeElement.querySelector('.clear-search') as HTMLElement).click();
        fixture.detectChanges();

        expect(input.value).toBe('');
        expect(log.search()).toBe('');
        expect(document.activeElement).toBe(input);
        expect(fixture.nativeElement.querySelector('.clear-search')).toBeNull();
        fixture.nativeElement.remove();
    });

    it('lists the filters folded away on a phone, each with a way to remove it', () => {
        log.filter.set('demo');
        log.search.set('asset');
        log.showBroadcastTraffic.set(true);
        log.showConnections.set(false);
        const component = TestBed.createComponent(LogToolbarComponent).componentInstance;

        expect(component.activeFilters().map(f => f.label)).toEqual([ 'App: demo', 'Search: asset', 'Sync traffic', 'No connections' ]);

        component.activeFilters()[0].clear();
        expect(log.filter()).toBe('');
        component.activeFilters()[2].clear();
        expect(log.showConnections()).toBe(true);
    });

    it('hides the connection lines with its own switch', async () => {
        const fixture = TestBed.createComponent(LogToolbarComponent);
        fixture.detectChanges();
        // ngModel writes its value a microtask later
        await fixture.whenStable();
        fixture.detectChanges();
        const [ sync, connections ] = fixture.nativeElement.querySelectorAll('.switch input') as NodeListOf<HTMLInputElement>;
        expect([ sync.checked, connections.checked ]).toEqual([ false, true ]);

        connections.click();
        fixture.detectChanges();

        expect(log.showConnections()).toBe(false);
        expect(log.showBroadcastTraffic()).toBe(false);
    });

    it('goes through the errors and warnings, and to the first new error', () => {
        const fixture = TestBed.createComponent(LogToolbarComponent);
        const steps: NavStep[] = [];
        fixture.componentInstance.navigate.subscribe(step => steps.push(step));
        const nav = (value: LogNav) => {
            fixture.componentRef.setInput('nav', value);
            fixture.detectChanges();
        };
        const root: HTMLElement = fixture.nativeElement;
        const buttons = () => root.querySelectorAll<HTMLButtonElement>('.nav button');

        nav({ problems: 0, position: null, newErrors: 0, openedAt: 0 });
        expect([ ...buttons() ].map(b => b.disabled)).toEqual([ true, true, true ]);

        nav({ problems: 14, position: 3, newErrors: 2, openedAt: 0 });
        expect(root.querySelector('.nav .position')?.textContent).toBe('3/14');
        expect(root.querySelector('.nav .first')?.textContent).toContain('2');
        buttons().forEach(b => b.click());
        expect(steps).toEqual([ 'previous', 'next', 'first-error' ]);
    });

    it('closes the folded filters on a phone after a step, so that the log has room to show the line', () => {
        const fixture = TestBed.createComponent(LogToolbarComponent);
        fixture.componentRef.setInput('nav', { problems: 3, position: null, newErrors: 0, openedAt: 0 });
        fixture.detectChanges();
        const next = fixture.nativeElement.querySelectorAll('.nav button')[1] as HTMLButtonElement;
        const phone = (matches: boolean) => vi.stubGlobal('matchMedia', (query: string) => ({ matches: matches && query === PHONE }));

        phone(false);
        fixture.componentInstance.open.set(true);
        next.click();
        expect(fixture.componentInstance.open()).toBe(true);

        phone(true);
        next.click();
        expect(fixture.componentInstance.open()).toBe(false);
        vi.unstubAllGlobals();
    });

    it('offers the lines as text or JSON', () => {
        const component = TestBed.createComponent(LogToolbarComponent).componentInstance;
        const formats: string[] = [];
        component.download.subscribe(format => formats.push(format));

        for (const item of component.downloadItems) item.command!({});

        expect(component.downloadItems.map(item => item.label)).toEqual([ 'Text', 'JSON' ]);
        expect(formats).toEqual([ 'text', 'json' ]);
    });

    it('counts in thousands past 999', () => {
        const component = TestBed.createComponent(LogToolbarComponent).componentInstance;

        expect([ 7, 999, 1000, 1250, 9999, 10000 ].map(n => component.shortCount(n))).toEqual([ '7', '999', '1k', '1.3k', '10k', '10k' ]);
    });

    it('moves to the search for the log page\'s / key, and opens the filters for it', () => {
        const fixture = TestBed.createComponent(LogToolbarComponent);
        fixture.detectChanges();
        document.body.appendChild(fixture.nativeElement);
        const input: HTMLInputElement = fixture.nativeElement.querySelector('.search input');

        fixture.componentInstance.focusSearch();
        expect(document.activeElement).toBe(input);
        expect(fixture.componentInstance.open()).toBe(true);
        fixture.nativeElement.remove();
    });
});
