import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { Subject } from 'rxjs';
import { ConnectionState, Reconnect, ServerSnapshot, SocketIOService } from '../../services';
import { Fact, ServerComponent, serverSections } from './server.component';

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
        TRUSTED_PROXIES: [], TCP_PROXY_PROTOCOL: false
    },
    tls: null,
    tlsAtProxy: { web: false, tcp: false },
    voice: { listening: true, recording: false, samplingRate: 48000, clients: 0 },
    counts: {
        tcpClients: 3, webClients: 2, adminPages: 1, apps: 2, models: 1234, modelApps: 2, modelChannels: 3,
        deletedModels: 4, storeApps: 1, storeKeys: 7
    },
    ...overrides
});

const fact = (s: ServerSnapshot, section: string, label: string): Fact | undefined =>
    serverSections(s, time => new Date(time).toISOString()).find(x => x.id === section)?.facts.find(f => f.label === label);

describe('serverSections', () => {
    it('shows the versions, the uptime and the counts', () => {
        const s = snapshot();
        expect(fact(s, 'server', 'Uptime')?.value).toBe('1 h 2 min');
        expect(fact(s, 'counts', 'Synced models')).toEqual(expect.objectContaining({ value: '1,234', note: 'in 3 channels of 2 apps', link: '/models' }));
        expect(fact(s, 'counts', 'REST store')).toEqual(expect.objectContaining({ value: '7 values', note: 'in 1 app' }));
    });

    it('shows the commit after the version, short, with the full hash and the build time on hover', () => {
        const s = snapshot();
        expect(serverSections(s, String).find(x => x.id === 'server')?.facts.map(f => f.label).slice(0, 2)).toEqual([ 'Version', 'Commit' ]);
        expect(fact(s, 'server', 'Commit')).toEqual({
            label: 'Commit', value: '3e2855e0c1', mono: true, note: undefined,
            title: '3e2855e0c1d2b3a4f5e6d7c8b9a0f1e2d3c4b5a6\nBuilt 1970-04-10T00:00:00.000Z'
        });
    });

    it('says when the build had uncommitted changes, or no git information', () => {
        expect(fact(snapshot({ build: { commit: '3e2855e0c1d2b3a4f5e6d7c8b9a0f1e2d3c4b5a6', dirty: true, builtAt: null } }), 'server', 'Commit'))
            .toEqual(expect.objectContaining({ value: '3e2855e0c1', note: 'uncommitted changes', title: '3e2855e0c1d2b3a4f5e6d7c8b9a0f1e2d3c4b5a6' }));

        const unknown = fact(snapshot({ build: { commit: null, dirty: false, builtAt: null } }), 'server', 'Commit');
        expect(unknown).toEqual(expect.objectContaining({ value: 'unknown', tone: 'off' }));
        expect(unknown?.mono).toBeUndefined();
        expect(unknown?.title).toBe('Built without git information, e.g. a Docker build without COLIBRI_COMMIT');
    });

    it('says which limits are off, and which variable sets each', () => {
        const s = snapshot();
        s.settings = { ...s.settings, CLIENT_MESSAGE_RATE_LIMIT: 0, TCP_IDLE_TIMEOUT_SECONDS: 0 };

        expect(fact(s, 'limits', 'Messages per client')).toEqual(expect.objectContaining({ value: 'Off', variable: 'CLIENT_MESSAGE_RATE_LIMIT' }));
        expect(fact(s, 'limits', 'Burst')?.value).toBe('Off');
        expect(fact(s, 'limits', 'TCP idle timeout')?.value).toBe('Off');
        expect(fact(s, 'limits', 'TCP inbound backlog')?.value).toBe('2,000 messages');
        expect(fact(s, 'network', 'Trusted proxies')?.value).toBe('None');
        expect(fact(s, 'network', 'TLS')?.value).toBe('Off');
    });

    it('describes the certificate, never more, and warns before it expires', () => {
        const tls = { names: 'colibri.example.org', issuer: 'Example CA', selfSigned: false, validFrom: 0, validTo: 110 * DAY, fingerprint256: 'AB:CD' };
        const s = snapshot({ tls });

        expect(serverSections(s, String).find(x => x.id === 'certificate')?.facts.map(f => f.label))
            .toEqual([ 'Names', 'Issuer', 'Valid from', 'Valid until', 'SHA-256 fingerprint' ]);
        expect(fact(s, 'certificate', 'Valid until')).toEqual(expect.objectContaining({ tone: 'warn', note: 'expires in 10 days' }));
        expect(fact(snapshot({ tls: { ...tls, validTo: 99 * DAY } }), 'certificate', 'Valid until')).toEqual(expect.objectContaining({ tone: 'err', note: 'expired' }));
        expect(fact(snapshot({ tls: { ...tls, validTo: 200 * DAY } }), 'certificate', 'Valid until')?.tone).toBeUndefined();
        expect(fact(s, 'network', 'Web')?.note).toBe('HTTPS and WSS');
    });

    it('puts an IPv6 host in brackets', () => {
        const hosts = (s: ServerSnapshot) => [ 'Web', 'TCP', 'Voice' ].map(label => fact(s, 'network', label)?.value);

        expect(hosts(snapshot())).toEqual([ '0.0.0.0:9211', '0.0.0.0:9212', '0.0.0.0:9213' ]);
        const settings = { ...snapshot().settings, WEBSERVER_HOST: '::', TCP_HOST: '2001:db8::1', VOICE_HOST: 'colibri.example.org' };
        expect(hosts(snapshot({ settings }))).toEqual([ '[::]:9211', '[2001:db8::1]:9212', 'colibri.example.org:9213' ]);
    });

    describe('TLS terminated by this server or by a proxy', () => {
        const certificate = { names: 'colibri.example.org', issuer: 'Example CA', selfSigned: false, validFrom: 0, validTo: 200 * DAY, fingerprint256: 'AB:CD' };
        const rows = (s: ServerSnapshot) => ({
            web: fact(s, 'network', 'Web')?.note,
            tcp: fact(s, 'network', 'TCP')?.note,
            tls: [ fact(s, 'network', 'TLS')?.value, fact(s, 'network', 'TLS')?.note, fact(s, 'network', 'TLS')?.tone ]
        });

        it.each([
            [ 'no TLS', null, false, { web: 'HTTP and WS', tcp: 'unencrypted', tls: [ 'Off', undefined, 'off' ] } ],
            [ 'TLS on this server', certificate, false, { web: 'HTTPS and WSS', tcp: 'TLS', tls: [ 'On', undefined, 'ok' ] } ],
            [ 'web TLS terminated by a proxy', null, true, { web: 'HTTP and WS, TLS terminated by proxy', tcp: 'unencrypted', tls: [ 'Off', 'terminated by proxy (HTTPS)', 'off' ] } ],
            // a direct connection uses the server's own
            [ 'both', certificate, true, { web: 'HTTPS and WSS', tcp: 'TLS', tls: [ 'On', undefined, 'ok' ] } ]
        ])('with %s, says so in the Web, TCP and TLS rows', (_case, tls, web, expected) => {
            expect(rows(snapshot({ tls, tlsAtProxy: { web, tcp: false } }))).toEqual(expected);
        });

        it('names X-Forwarded-Proto on hover for web TLS terminated by a proxy, and only then', () => {
            const proxied = snapshot({ tlsAtProxy: { web: true, tcp: false } });
            expect(fact(proxied, 'network', 'Web')?.title).toBe('TLS terminated by a trusted proxy (X-Forwarded-Proto: https from a connected web client or admin page)');
            expect(fact(proxied, 'network', 'TLS')?.title).toBe(fact(proxied, 'network', 'Web')?.title);
            expect(fact(proxied, 'network', 'TLS')?.variable).toBe('TLS_CERT, TLS_KEY');

            expect(fact(snapshot(), 'network', 'Web')?.title).toBeUndefined();
            expect(fact(snapshot({ tls: certificate, tlsAtProxy: { web: true, tcp: false } }), 'network', 'Web')?.title).toBeUndefined();
        });

        it('with Unity clients through a proxy and TCP_TLS_AT_PROXY unset, says proxy TLS is undeclared', () => {
            const throughProxy = (tls: ServerSnapshot['tls'], web: boolean) => snapshot({
                tls, tlsAtProxy: { web, tcp: false }, settings: { ...snapshot().settings, TRUSTED_PROXIES: [ 'loopback' ], TCP_PROXY_PROTOCOL: true }
            });

            expect(rows(throughProxy(null, true))).toEqual({
                web: 'HTTP and WS, TLS terminated by proxy',
                tcp: 'unencrypted, proxy TLS undeclared',
                tls: [ 'Off', 'terminated by proxy (HTTPS)', 'off' ]
            });
            expect(rows(throughProxy(null, false)).tcp).toBe('unencrypted, proxy TLS undeclared');
            expect(fact(throughProxy(null, false), 'network', 'TCP')?.title).toBe(
                'Set TCP_TLS_AT_PROXY=true if the proxy terminates TLS on this port. Unity apps tick \'Server supports SSL/TLS?\' whenever the proxy port uses TLS'
            );
            // a direct connection uses the server's own
            expect(rows(throughProxy(certificate, false)).tcp).toBe('TLS');
            expect(fact(throughProxy(certificate, false), 'network', 'TCP')?.title).toBeUndefined();
            expect(fact(snapshot(), 'network', 'TCP')?.title).toBeUndefined();
        });

        describe('with TCP_TLS_AT_PROXY', () => {
            const declared = (tls: ServerSnapshot['tls'], web: boolean) => snapshot({
                tls, tlsAtProxy: { web, tcp: true },
                settings: { ...snapshot().settings, TRUSTED_PROXIES: [ 'loopback' ], TCP_PROXY_PROTOCOL: true, TCP_TLS_AT_PROXY: true }
            });

            it.each([
                [ 'TCP only', false, { web: 'HTTP and WS', tcp: 'TLS terminated by proxy', tls: [ 'Off', 'terminated by proxy (TCP)', 'off' ] } ],
                [ 'web too', true, { web: 'HTTP and WS, TLS terminated by proxy', tcp: 'TLS terminated by proxy', tls: [ 'Off', 'terminated by proxy (HTTPS, TCP)', 'off' ] } ]
            ])('says TLS is terminated by proxy in the TCP and TLS rows, %s', (_case, web, expected) => {
                expect(rows(declared(null, web))).toEqual(expected);
            });

            it('names the setting on hover, next to the web rule', () => {
                expect(fact(declared(null, false), 'network', 'TCP')?.title).toBe('Declared by TCP_TLS_AT_PROXY; PROXY protocol v1 carries no TLS information');
                expect(fact(declared(null, false), 'network', 'TLS')?.title).toBe(fact(declared(null, false), 'network', 'TCP')?.title);
                const both = fact(declared(null, true), 'network', 'TLS')?.title?.split('\n');
                expect(both).toEqual([ fact(declared(null, true), 'network', 'Web')?.title, fact(declared(null, true), 'network', 'TCP')?.title ]);
            });

            // a direct connection uses the server's own
            it('shows the server\'s own TLS instead when it has a certificate', () => {
                expect(rows(declared(certificate, false))).toEqual({ web: 'HTTPS and WSS', tcp: 'TLS', tls: [ 'On', undefined, 'ok' ] });
                expect(fact(declared(certificate, false), 'network', 'TCP')?.title).toBeUndefined();
            });
        });

        it('shows TCP_TLS_AT_PROXY as TCP TLS termination after TCP_PROXY_PROTOCOL, and when it has no effect', () => {
            const setting = (on: boolean, applies: boolean) => fact(snapshot({
                tlsAtProxy: { web: false, tcp: applies }, settings: { ...snapshot().settings, TCP_TLS_AT_PROXY: on }
            }), 'network', 'TCP TLS termination');
            const labels = serverSections(snapshot(), String).find(x => x.id === 'network')?.facts.map(f => f.label);

            expect(labels?.slice(-2)).toEqual([ 'PROXY protocol on TCP', 'TCP TLS termination' ]);
            expect(setting(true, true)).toEqual(expect.objectContaining({ value: 'Proxy', tone: 'ok', variable: 'TCP_TLS_AT_PROXY' }));
            expect(setting(true, true)?.note).toBeUndefined();
            expect(setting(true, false)).toEqual(expect.objectContaining({ value: 'Proxy', tone: 'warn', note: 'needs TCP_PROXY_PROTOCOL' }));
            expect(setting(true, false)?.title).toContain('No effect without TCP_PROXY_PROTOCOL');
            // and not again under Other settings
            expect(serverSections(snapshot({ settings: { ...snapshot().settings, TCP_TLS_AT_PROXY: true } }), String).some(x => x.id === 'other')).toBe(false);
        });

        // Not Off, which reads as "the proxy's TCP port has no TLS", so untick it in the Unity apps.
        it('shows TCP_TLS_AT_PROXY unset as not declared, muted, without a note', () => {
            const unset = (proxyProtocol: boolean) => fact(snapshot({
                settings: { ...snapshot().settings, TRUSTED_PROXIES: [ 'loopback' ], TCP_PROXY_PROTOCOL: proxyProtocol, TCP_TLS_AT_PROXY: false }
            }), 'network', 'TCP TLS termination');

            for (const proxyProtocol of [ false, true ]) {
                expect(unset(proxyProtocol)).toEqual({ label: 'TCP TLS termination', variable: 'TCP_TLS_AT_PROXY', value: 'Not declared', tone: 'off' });
            }
            // a server from before the setting
            expect(fact(snapshot(), 'network', 'TCP TLS termination')?.value).toBe('Not declared');
        });
    });

    it('lists settings it does not know under Other settings', () => {
        const s = snapshot();
        s.settings = { ...s.settings, NEW_SETTING: 'x' };
        expect(fact(s, 'other', 'NEW_SETTING')?.value).toBe('x');
        expect(serverSections(snapshot(), String).some(x => x.id === 'other')).toBe(false);
    });
});

describe('ServerComponent', () => {
    let channel: Subject<{ command: string; payload: unknown }>;
    let emit: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        channel = new Subject();
        emit = vi.fn();
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
        const request = emit.mock.calls.filter(call => call[1] === 'subscribe').at(-1)![2].request;
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
