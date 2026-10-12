import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ConnectionState, SocketIOService } from '../../services';
import { LiveStatusComponent } from './live-status.component';

describe('LiveStatusComponent', () => {
    it('is live while connected, and grey while the connection is lost', () => {
        const state = signal<ConnectionState>('connected');
        TestBed.configureTestingModule({ providers: [ { provide: SocketIOService, useValue: { state } } ] });
        const fixture = TestBed.createComponent(LiveStatusComponent);
        fixture.detectChanges();
        const live = fixture.nativeElement.querySelector('.live') as HTMLElement;
        expect([ live.textContent, live.classList.contains('off') ]).toEqual([ 'Live', false ]);

        state.set('reconnecting');
        fixture.detectChanges();
        expect([ live.textContent, live.classList.contains('off') ]).toEqual([ 'Offline', true ]);
        expect(live.title).toBe('Not updated until the connection is back');
    });
});
