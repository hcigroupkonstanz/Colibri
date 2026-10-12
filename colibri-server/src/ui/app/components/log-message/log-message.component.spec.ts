import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { LogMessage, LogService } from '../../services';
import { LogMessageComponent } from './log-message.component';

const message = (overrides: Partial<LogMessage>): LogMessage => ({
    id: '1',
    origin: 'ClientLogger',
    level: 0,
    message: '[Quest] Failed to load asset',
    group: 'hook',
    created: new Date(2026, 9, 10, 12, 0, 9, 970).getTime(),
    first: new Date(2026, 9, 10, 12, 0, 8, 706).getTime(),
    count: 9,
    metadata: { clientApp: 'demo-app', clientName: 'Quest', clientId: 'abc' },
    ...overrides
});

describe('LogMessageComponent', () => {
    let filter: ReturnType<typeof signal<string>>;

    const render = (log: LogMessage, search = '') => {
        const fixture = TestBed.createComponent(LogMessageComponent);
        fixture.componentRef.setInput('log', log);
        fixture.componentRef.setInput('search', search);
        fixture.detectChanges();
        return fixture;
    };
    const text = (root: HTMLElement, selector: string) => root.querySelector(selector)?.textContent?.trim();

    beforeEach(() => {
        filter = signal('');
        TestBed.configureTestingModule({ providers: [ provideRouter([]), { provide: LogService, useValue: { filter } } ] });
    });

    it('shows time, level, app, client and the message without the client prefix', () => {
        const root: HTMLElement = render(message({})).nativeElement;

        expect(text(root, '.time')).toBe('12:00:09.970');
        expect(text(root, '.level [aria-hidden]')).toBe('ERR');
        expect(text(root, '.level .visually-hidden')).toBe('Error');
        expect(text(root, '.app-chip')).toBe('demo-app');
        expect(text(root, '.client')).toBe('Quest');
        expect(text(root, '.message')).toBe('Failed to load asset');
    });

    // every web client on one host has the same address for a name
    it('shows a web client by the start of its id, with the address in its title', () => {
        const root: HTMLElement = render(message({
            message: '[172.20.0.1] Scene loaded',
            metadata: { clientApp: 'demo-app', clientName: '172.20.0.1', clientId: 'AysXA7fAeXWU9b__AAAT' }
        })).nativeElement;

        expect(text(root, '.client')).toBe('AysXA7');
        expect(root.querySelector('.client')?.getAttribute('title')).toBe('172.20.0.1, client AysXA7fAeXWU9b__AAAT');
        expect(text(root, '.message')).toBe('Scene loaded');
    });

    it('shows a repeat count with when it first occurred, and none for a single line', () => {
        const root: HTMLElement = render(message({})).nativeElement;
        expect(text(root, '.count')).toBe('×10');
        expect(root.querySelector('.count')?.getAttribute('title')).toBe('10 times, first at 12:00:08.706');

        expect(render(message({ count: 0 })).nativeElement.querySelector('.count')).toBeNull();
    });

    it('opens on a click to show the details', () => {
        const fixture = render(message({}));
        const root: HTMLElement = fixture.nativeElement;
        expect(root.querySelector('.details')).toBeNull();

        (root.querySelector('.time') as HTMLElement).click();
        fixture.detectChanges();

        expect(root.querySelector('.time')?.getAttribute('aria-expanded')).toBe('true');
        expect(text(root, '.details')).toContain('Client');
        expect(text(root, '.details')).toContain('abc');
    });

    it('filters to the app when its name is clicked, without opening', () => {
        const fixture = render(message({}));
        (fixture.nativeElement.querySelector('.app-chip') as HTMLElement).click();
        fixture.detectChanges();

        expect(filter()).toBe('demo-app');
        expect(fixture.nativeElement.querySelector('.details')).toBeNull();
    });

    it('links an opened line to the clients of its app, with its client marked', () => {
        const fixture = render(message({}));
        (fixture.nativeElement.querySelector('.time') as HTMLElement).click();
        fixture.detectChanges();

        const link: HTMLAnchorElement = fixture.nativeElement.querySelector('.details a.link');
        expect(link.textContent).toBe('Show clients');
        expect(link.getAttribute('href')).toBe('/clients?app=demo-app&client=abc');
    });

    it('marks the line Previous and Next went to', () => {
        const fixture = render(message({}));
        expect(fixture.nativeElement.querySelector('.row.current')).toBeNull();

        fixture.componentRef.setInput('current', true);
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('.row.current')).not.toBeNull();
    });

    it('marks the search text in the message', () => {
        const root: HTMLElement = render(message({}), 'asset').nativeElement;
        expect([ ...root.querySelectorAll('mark') ].map(m => m.textContent)).toEqual([ 'asset' ]);
    });
});
