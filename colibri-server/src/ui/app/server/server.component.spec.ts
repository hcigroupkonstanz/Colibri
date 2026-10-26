import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { Subject } from 'rxjs';
import type { Mock } from 'vitest';
import type { ConnectionState, Reconnect } from '../connection/socketio.service';
import type { ServerSnapshot } from '../connection/admin.service';
import { SocketIOService } from '../connection/socketio.service';
import { ServerComponent } from './server.component';

const DAY = 24 * 60 * 60 * 1000;

const snapshot = (overrides: Partial<ServerSnapshot> = {}): ServerSnapshot => ({
    request: 1,
    at: 100 * DAY,
    version: '2.0.0',
    build: { commit: '3e2855e0c1d2b3a4f5e6d7c8b9a0f1e2d3c4b5a6', dirty: false, builtAt: 99 * DAY },
    protocolVersion: '2',
    node: 'v24.21.0',
    startedAt: 100 * DAY - 3_725_000,
    uptime: 3725,
    settings: {
        WEBSERVER_HOST: '0.0.0.0', WEBSERVER_PORT: 9211, BASE_URL: '', TCP_HOST: '0.0.0.0', TCP_PORT: 9212,
        VOICE_HOST: '0.0.0.0', VOICE_PORT: 9213, VOICE_SAMPLING_RATE: 48000, VOICE_RECORDING: false,
        TCP_IDLE_TIMEOUT_SECONDS: 10, TCP_INBOUND_BACKLOG_LIMIT: 2000, CLIENT_MESSAGE_RATE_LIMIT: 1000,
        CLIENT_MESSAGE_RATE_BURST: 2000, APP_CLIENT_WARNING_THRESHOLD: 8, MODEL_TOMBSTONE_SECONDS: 600,
        STORE_EXPIRY_DAYS: 30, STORE_MAX_MB: 0,
        TRUSTED_PROXIES: [], TCP_PROXY_PROTOCOL: false
    },
    tls: null,
    proxyTls: null,
    tlsAtProxy: { web: false, tcp: false },
    voice: { listening: true, recording: false, samplingRate: 48000, clients: 0 },
    counts: {
        tcpClients: 3, webClients: 2, adminPages: 1, apps: 2, models: 1234, modelApps: 2, modelChannels: 3,
        deletedModels: 4, storeApps: 1, storeKeys: 7, storeBytes: 1536
    },
    ...overrides
});

describe('ServerComponent', () => {
    let channel: Subject<{ command: string; payload: unknown }>;
    let emit: Mock<SocketIOService['emit']>;

    beforeEach(() => {
        channel = new Subject();
        emit = vi.fn<SocketIOService['emit']>();
        TestBed.configureTestingModule({
            providers: [
                provideRouter([]),
                {
                    provide: SocketIOService,
                    useValue: {
                        listen: () => channel.asObservable(),
                        emit,
                        reconnected$: new Subject<Reconnect>().asObservable(),
                        state: signal<ConnectionState>('connected'),
                        lostAt: signal<number | null>(null)
                    }
                }
            ]
        });
    });

    const row = (overrides: Partial<ServerSnapshot>, label: string) => {
        const fixture = TestBed.createComponent(ServerComponent);
        fixture.detectChanges();
        const request = (emit.mock.calls.filter(call => call[1] === 'subscribe').at(-1)![2] as { request: number }).request;
        channel.next({ command: 'server', payload: snapshot({ request, ...overrides }) });
        fixture.detectChanges();
        const shownFact = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('.fact')).find(f => f.querySelector('dt')?.textContent === label)!;
        return {
            value: shownFact.querySelector('.value')!, note: shownFact.querySelector('.note')?.textContent ?? null,
            variable: shownFact.querySelector('code')?.textContent ?? null
        };
    };

    const shown = (build: ServerSnapshot['build']) => row({ build }, 'Commit');

    it('shows the commit in mono with the full hash on hover, and a note for uncommitted changes', () => {
        const { value, note } = shown({ commit: '3e2855e0c1d2b3a4f5e6d7c8b9a0f1e2d3c4b5a6', dirty: true, builtAt: null });
        expect(value.textContent?.trim()).toBe('3e2855e0c1');
        expect(value.classList.contains('mono')).toBe(true);
        expect(value.getAttribute('title')).toBe('3e2855e0c1d2b3a4f5e6d7c8b9a0f1e2d3c4b5a6');
        expect(note).toBe('uncommitted changes');
    });

    it('shows TLS terminated by proxy as Off with a note, X-Forwarded-Proto on hover', () => {
        const { value, note } = row({ tlsAtProxy: { web: true, tcp: false } }, 'TLS');
        expect(value.textContent?.trim()).toBe('Off');
        expect(value.classList.contains('off')).toBe(true);
        expect(value.getAttribute('title')).toContain('X-Forwarded-Proto');
        expect(note).toBe('terminated by proxy (HTTPS)');
    });

    it('shows the TCP port behind a proxy as unencrypted with proxy TLS undeclared, naming the setting on hover', () => {
        const { value, note } = row({ settings: { ...snapshot().settings, TRUSTED_PROXIES: [ 'loopback' ], TCP_PROXY_PROTOCOL: true } }, 'TCP');
        expect(note).toBe('unencrypted, proxy TLS undeclared');
        expect(value.getAttribute('title')).toContain('Set TCP_TLS_AT_PROXY=true');
        expect(value.getAttribute('title')).toContain('Server supports SSL/TLS?');
    });

    describe('with TCP_TLS_AT_PROXY', () => {
        const declared: Partial<ServerSnapshot> = {
            tlsAtProxy: { web: false, tcp: true },
            settings: { ...snapshot().settings, TRUSTED_PROXIES: [ 'loopback' ], TCP_PROXY_PROTOCOL: true, TCP_TLS_AT_PROXY: true }
        };

        it('shows the TCP port as TLS terminated by proxy, naming the setting on hover', () => {
            const { value, note } = row(declared, 'TCP');
            expect(note).toBe('TLS terminated by proxy');
            expect(value.getAttribute('title')).toContain('TCP_TLS_AT_PROXY');
        });

        it('shows TLS as Off, terminated by proxy for TCP', () => {
            const { value, note } = row(declared, 'TLS');
            expect(value.textContent?.trim()).toBe('Off');
            expect(note).toBe('terminated by proxy (TCP)');
        });

        it('shows TCP TLS termination by the proxy, with its variable', () => {
            const { value, note, variable } = row(declared, 'TCP TLS termination');
            expect(value.textContent?.trim()).toBe('Proxy');
            expect(value.classList.contains('ok')).toBe(true);
            expect(note).toBeNull();
            expect(variable).toBe('TCP_TLS_AT_PROXY');
        });

        it('shows the setting unset as not declared, muted, without a note', () => {
            const { value, note } = row({ settings: { ...snapshot().settings, TRUSTED_PROXIES: [ 'loopback' ], TCP_PROXY_PROTOCOL: true } }, 'TCP TLS termination');
            expect(value.textContent?.trim()).toBe('Not declared');
            expect(value.classList.contains('off')).toBe(true);
            expect(note).toBeNull();
        });

        it('says when the setting has no effect', () => {
            const { value, note } = row({ settings: { ...snapshot().settings, TRUSTED_PROXIES: [ 'loopback' ], TCP_TLS_AT_PROXY: true } }, 'TCP TLS termination');
            expect(value.textContent?.trim()).toBe('Proxy');
            expect(value.classList.contains('warn')).toBe(true);
            expect(note).toBe('needs TCP_PROXY_PROTOCOL');
            expect(value.getAttribute('title')).toContain('No effect');
        });
    });

    it('shows an unknown commit muted, saying why on hover', () => {
        const { value, note } = shown({ commit: null, dirty: false, builtAt: null });
        expect(value.textContent?.trim()).toBe('unknown');
        expect(value.classList.contains('off')).toBe(true);
        expect(value.getAttribute('title')).toContain('without git information');
        expect(note).toBeNull();
    });
});
