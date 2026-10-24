import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { Subject } from 'rxjs';
import type { ConnectionState, Reconnect } from '../connection/socketio.service';
import type { ProxyTlsInfo, ServerSnapshot, TlsInfo } from '../connection/admin.service';
import { SocketIOService } from '../connection/socketio.service';
import type { Fact, Section } from './server.component';
import { ServerComponent, serverSections } from './server.component';

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

const fact = (s: ServerSnapshot, section: string, label: string): Fact | undefined =>
    serverSections(s, time => new Date(time).toISOString()).find(x => x.id === section)?.facts.find(f => f.label === label);

describe('serverSections', () => {
    it('shows the versions, the uptime and the counts', () => {
        const s = snapshot();
        expect(fact(s, 'server', 'Uptime')?.value).toBe('1 h 2 min');
        expect(fact(s, 'counts', 'Synced models')).toEqual(expect.objectContaining({ value: '1,234', note: 'in 3 channels of 2 apps', link: '/models' }));
        expect(fact(s, 'counts', 'REST store')).toEqual(expect.objectContaining({ value: '7 values', note: 'in 1 app, 1.5 KiB' }));
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
        expect(fact(s, 'limits', 'REST store values kept')).toEqual(expect.objectContaining({ value: '30 days after their last write', variable: 'STORE_EXPIRY_DAYS' }));
        expect(fact(s, 'limits', 'REST store size')).toEqual(expect.objectContaining({ value: 'Off', variable: 'STORE_MAX_MB' }));
        expect(fact(snapshot({ settings: { ...s.settings, STORE_EXPIRY_DAYS: 0, STORE_MAX_MB: 512 } }), 'limits', 'REST store values kept')?.value).toBe('Off');
        expect(fact(snapshot({ settings: { ...s.settings, STORE_MAX_MB: 512 } }), 'limits', 'REST store size')?.value).toBe('512 MiB');
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

    describe('the proxy\'s certificate (PROXY_TLS_ADDRESSES)', () => {
        const certificate = { names: 'DNS:colibri.example.org', issuer: 'CN=R11, O=Let\'s Encrypt, C=US', selfSigned: false,
            validFrom: 90 * DAY, validTo: 150 * DAY, fingerprint256: 'AB:CD' };
        const proxied = (proxyTls: ServerSnapshot['proxyTls'], tls: ServerSnapshot['tls'] = null) => snapshot({
            tls, proxyTls, settings: { ...snapshot().settings, PROXY_TLS_ADDRESSES: [ 'colibri.example.org:443', 'colibri.example.org:9212' ] }
        });
        const sectionsOf = (s: ServerSnapshot) => serverSections(s, String).filter(x => x.id.endsWith('certificate') || x.id.startsWith('proxy-'));

        it('shows nothing without PROXY_TLS_ADDRESSES, and lists them under Network when set', () => {
            expect(sectionsOf(snapshot())).toEqual([]);
            expect(fact(snapshot(), 'network', 'Proxy TLS addresses')).toEqual(expect.objectContaining({ value: 'None', tone: 'off' }));
            expect(fact(proxied([]), 'network', 'Proxy TLS addresses')?.value).toBe('colibri.example.org:443, colibri.example.org:9212');
        });

        it('says it is checking until the first check has finished', () => {
            expect(sectionsOf(proxied([])).map(x => [ x.title, x.facts.map(f => `${f.label}: ${f.value}`) ])).toEqual([
                [ 'Proxy TLS certificate', [ 'Addresses: colibri.example.org:443, colibri.example.org:9212', 'Status: Checking' ] ]
            ]);
        });

        it('describes a trusted certificate with every address that presented it', () => {
            const s = proxied([ { addresses: [ 'colibri.example.org:443', 'colibri.example.org:9212' ], checkedAt: 99 * DAY,
                certificate: { ...certificate, trusted: true, trustError: null }, error: null } ]);

            const [ section ] = sectionsOf(s);
            expect(section!.title).toBe('Proxy TLS certificate');
            expect(section!.facts.map(f => f.label)).toEqual([ 'Addresses', 'Trusted', 'Names', 'Issuer', 'Valid from', 'Valid until', 'SHA-256 fingerprint', 'Checked' ]);
            expect(section!.facts[1]).toEqual(expect.objectContaining({ value: 'Yes', tone: 'ok' }));
            expect(section!.facts[5]).toEqual(expect.objectContaining({ note: 'in 50 days' }));
        });

        it('marks one clients would refuse, and an address it could not reach', () => {
            const s = proxied([
                { addresses: [ 'colibri.example.org:443' ], checkedAt: 99 * DAY,
                    certificate: { ...certificate, validTo: 105 * DAY, trusted: false, trustError: 'CERT_HAS_EXPIRED' }, error: null },
                { addresses: [ 'colibri.example.org:9212' ], checkedAt: 99 * DAY, certificate: null, error: 'connect ECONNREFUSED 10.20.0.1:9212' }
            ]);

            const [ refused, unreachable ] = sectionsOf(s);
            expect(refused!.facts.find(f => f.label === 'Trusted')).toEqual(expect.objectContaining({ value: 'No', tone: 'err', note: 'CERT_HAS_EXPIRED' }));
            expect(refused!.facts.find(f => f.label === 'Valid until')).toEqual(expect.objectContaining({ tone: 'warn', note: 'expires in 5 days' }));
            expect(unreachable!.facts.map(f => [ f.label, f.value, f.tone, f.note ])).toEqual([
                [ 'Addresses', 'colibri.example.org:9212', undefined, undefined ],
                [ 'Connection', 'Failed', 'err', 'connect ECONNREFUSED 10.20.0.1:9212' ],
                [ 'Checked', String(99 * DAY), undefined, undefined ]
            ]);
            expect(new Set(sectionsOf(s).map(x => x.id)).size).toBe(2);
        });

        // The check runs once an hour: one that has expired since is refused already.
        it('marks a certificate that has expired since the check as not trusted', () => {
            const s = proxied([ { addresses: [ 'colibri.example.org:443' ], checkedAt: 99 * DAY,
                certificate: { ...certificate, validTo: 100 * DAY - 1, trusted: true, trustError: null }, error: null } ]);

            expect(sectionsOf(s)[0]!.facts.find(f => f.label === 'Trusted')).toEqual(expect.objectContaining({ value: 'No', tone: 'err', note: 'expired' }));
        });

        // TLS from the proxy to the server as well: clients see the proxy's certificate, the
        // server's own is the one between the two.
        it('tells the server\'s own certificate from the proxy\'s when it shows both', () => {
            const own = { ...certificate, names: 'DNS:colibri-internal', selfSigned: true, issuer: 'CN=colibri-internal', fingerprint256: 'EF:01' };
            const s = proxied([ { addresses: [ 'colibri.example.org:443' ], checkedAt: 99 * DAY,
                certificate: { ...certificate, trusted: true, trustError: null }, error: null } ], own);

            expect(sectionsOf(s).map(x => [ x.title, x.facts.find(f => f.label === 'SHA-256 fingerprint')?.value ])).toEqual([
                [ 'TLS certificate (this server)', 'EF:01' ],
                [ 'Proxy TLS certificate', 'AB:CD' ]
            ]);
            expect(sectionsOf(snapshot({ tls: own })).map(x => x.title)).toEqual([ 'TLS certificate' ]);
        });
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

            expect(labels?.slice(-3)).toEqual([ 'PROXY protocol on TCP', 'TCP TLS termination', 'Proxy TLS addresses' ]);
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

// Pins every section and fact with all its fields, for snapshots that together reach each branch of serverSections and
// certificateFacts.
describe('serverSections, the complete output', () => {
    const format = (time: number) => new Date(time).toISOString();
    const sections = (s: ServerSnapshot) => serverSections(s, format);
    const settings = (overrides: ServerSnapshot['settings']) => ({ ...snapshot().settings, ...overrides });
    const certificate = (overrides: Partial<TlsInfo> = {}): TlsInfo => ({
        names: 'colibri.example.org', issuer: 'Example CA', selfSigned: false, validFrom: 0, validTo: 200 * DAY, fingerprint256: 'AB:CD', ...overrides
    });
    const behindProxy = { TRUSTED_PROXIES: [ 'loopback' ], TCP_PROXY_PROTOCOL: true };

    // Sections that several snapshots share.
    const SERVER: Section = {
        id: 'server', title: 'Server', facts: [
            { label: 'Version', value: '2.0.0', mono: true },
            { label: 'Commit', value: '3e2855e0c1', mono: true, title: '3e2855e0c1d2b3a4f5e6d7c8b9a0f1e2d3c4b5a6\nBuilt 1970-04-10T00:00:00.000Z' },
            { label: 'Protocol version', value: '2', mono: true },
            { label: 'Node.js', value: 'v24.21.0', mono: true },
            { label: 'Started', value: '1970-04-10T22:57:55.000Z' },
            { label: 'Uptime', value: '1 h 2 min' }
        ]
    };

    const COUNTS: Section = {
        id: 'counts', title: 'Clients and data', facts: [
            { label: 'Unity clients', value: '3', note: 'TCP', link: '/clients' },
            { label: 'Web clients', value: '2', note: 'Socket.IO', link: '/clients' },
            { label: 'Apps', value: '2', note: 'with clients connected' },
            { label: 'Admin pages', value: '1', note: 'open, this one included' },
            { label: 'Synced models', value: '1,234', note: 'in 3 channels of 2 apps', link: '/models' },
            { label: 'Recently deleted models', value: '4', note: 'kept for 600 s', link: '/models' },
            { label: 'REST store', value: '7 values', note: 'in 1 app, 1.5 KiB' }
        ]
    };

    const NETWORK_PLAIN: Section = {
        id: 'network', title: 'Network', facts: [
            { label: 'Web', value: '0.0.0.0:9211', variable: 'WEBSERVER_HOST, WEBSERVER_PORT', note: 'HTTP and WS', mono: true },
            { label: 'TCP', value: '0.0.0.0:9212', variable: 'TCP_HOST, TCP_PORT', note: 'unencrypted', mono: true },
            { label: 'Voice', value: '0.0.0.0:9213', variable: 'VOICE_HOST, VOICE_PORT', note: 'UDP', mono: true },
            { label: 'Base URL', value: '/', variable: 'BASE_URL', mono: true },
            { label: 'TLS', value: 'Off', variable: 'TLS_CERT, TLS_KEY', tone: 'off' },
            { label: 'Trusted proxies', value: 'None', variable: 'TRUSTED_PROXIES', tone: 'off', mono: false },
            { label: 'PROXY protocol on TCP', value: 'Off', variable: 'TCP_PROXY_PROTOCOL', tone: 'off' },
            { label: 'TCP TLS termination', value: 'Not declared', variable: 'TCP_TLS_AT_PROXY', tone: 'off' },
            { label: 'Proxy TLS addresses', value: 'None', variable: 'PROXY_TLS_ADDRESSES', tone: 'off', mono: false }
        ]
    };

    const LIMITS: Section = {
        id: 'limits', title: 'Load limits', facts: [
            { label: 'Messages per client', value: '1,000 a second', variable: 'CLIENT_MESSAGE_RATE_LIMIT' },
            { label: 'Burst', value: '2,000 messages', variable: 'CLIENT_MESSAGE_RATE_BURST' },
            { label: 'TCP inbound backlog', value: '2,000 messages', variable: 'TCP_INBOUND_BACKLOG_LIMIT' },
            { label: 'TCP idle timeout', value: '10 s', variable: 'TCP_IDLE_TIMEOUT_SECONDS' },
            { label: 'App client warning', value: 'above 8 clients', variable: 'APP_CLIENT_WARNING_THRESHOLD' },
            { label: 'Deleted models kept', value: '600 s', variable: 'MODEL_TOMBSTONE_SECONDS' },
            { label: 'REST store values kept', value: '30 days after their last write', variable: 'STORE_EXPIRY_DAYS' },
            { label: 'REST store size', value: 'Off', variable: 'STORE_MAX_MB', tone: 'off' }
        ]
    };

    const VOICE: Section = {
        id: 'voice', title: 'Voice', facts: [
            { label: 'Voice server', value: 'On', tone: 'ok' },
            { label: 'Recording', value: 'Off', variable: 'VOICE_RECORDING', tone: 'off' },
            { label: 'Sampling rate', value: '48,000 Hz', variable: 'VOICE_SAMPLING_RATE' },
            { label: 'Voice clients', value: '0' }
        ]
    };

    const NETWORK_TLS: Section = {
        id: 'network', title: 'Network', facts: [
            { label: 'Web', value: '0.0.0.0:9211', variable: 'WEBSERVER_HOST, WEBSERVER_PORT', note: 'HTTPS and WSS', mono: true },
            { label: 'TCP', value: '0.0.0.0:9212', variable: 'TCP_HOST, TCP_PORT', note: 'TLS', mono: true },
            { label: 'Voice', value: '0.0.0.0:9213', variable: 'VOICE_HOST, VOICE_PORT', note: 'UDP', mono: true },
            { label: 'Base URL', value: '/', variable: 'BASE_URL', mono: true },
            { label: 'TLS', value: 'On', variable: 'TLS_CERT, TLS_KEY', tone: 'ok' },
            { label: 'Trusted proxies', value: 'None', variable: 'TRUSTED_PROXIES', tone: 'off', mono: false },
            { label: 'PROXY protocol on TCP', value: 'Off', variable: 'TCP_PROXY_PROTOCOL', tone: 'off' },
            { label: 'TCP TLS termination', value: 'Not declared', variable: 'TCP_TLS_AT_PROXY', tone: 'off' },
            { label: 'Proxy TLS addresses', value: 'None', variable: 'PROXY_TLS_ADDRESSES', tone: 'off', mono: false }
        ]
    };

    const CERTIFICATE: Section = {
        id: 'certificate', title: 'TLS certificate', facts: [
            { label: 'Names', value: 'colibri.example.org', mono: true },
            { label: 'Issuer', value: 'Example CA' },
            { label: 'Valid from', value: '1970-01-01T00:00:00.000Z' },
            { label: 'Valid until', value: '1970-07-20T00:00:00.000Z', note: 'in 100 days' },
            { label: 'SHA-256 fingerprint', value: 'AB:CD', mono: true }
        ]
    };

    const NETWORK_PROXY_ADDRESSES: Section = {
        id: 'network', title: 'Network', facts: [
            { label: 'Web', value: '0.0.0.0:9211', variable: 'WEBSERVER_HOST, WEBSERVER_PORT', note: 'HTTP and WS', mono: true },
            { label: 'TCP', value: '0.0.0.0:9212', variable: 'TCP_HOST, TCP_PORT', note: 'unencrypted', mono: true },
            { label: 'Voice', value: '0.0.0.0:9213', variable: 'VOICE_HOST, VOICE_PORT', note: 'UDP', mono: true },
            { label: 'Base URL', value: '/', variable: 'BASE_URL', mono: true },
            { label: 'TLS', value: 'Off', variable: 'TLS_CERT, TLS_KEY', tone: 'off' },
            { label: 'Trusted proxies', value: 'None', variable: 'TRUSTED_PROXIES', tone: 'off', mono: false },
            { label: 'PROXY protocol on TCP', value: 'Off', variable: 'TCP_PROXY_PROTOCOL', tone: 'off' },
            { label: 'TCP TLS termination', value: 'Not declared', variable: 'TCP_TLS_AT_PROXY', tone: 'off' },
            { label: 'Proxy TLS addresses', value: 'colibri.example.org:443, colibri.example.org:9212', variable: 'PROXY_TLS_ADDRESSES', mono: true }
        ]
    };

    const NETWORK_TLS_PROXY_ADDRESSES: Section = {
        id: 'network', title: 'Network', facts: [
            { label: 'Web', value: '0.0.0.0:9211', variable: 'WEBSERVER_HOST, WEBSERVER_PORT', note: 'HTTPS and WSS', mono: true },
            { label: 'TCP', value: '0.0.0.0:9212', variable: 'TCP_HOST, TCP_PORT', note: 'TLS', mono: true },
            { label: 'Voice', value: '0.0.0.0:9213', variable: 'VOICE_HOST, VOICE_PORT', note: 'UDP', mono: true },
            { label: 'Base URL', value: '/', variable: 'BASE_URL', mono: true },
            { label: 'TLS', value: 'On', variable: 'TLS_CERT, TLS_KEY', tone: 'ok' },
            { label: 'Trusted proxies', value: 'None', variable: 'TRUSTED_PROXIES', tone: 'off', mono: false },
            { label: 'PROXY protocol on TCP', value: 'Off', variable: 'TCP_PROXY_PROTOCOL', tone: 'off' },
            { label: 'TCP TLS termination', value: 'Not declared', variable: 'TCP_TLS_AT_PROXY', tone: 'off' },
            { label: 'Proxy TLS addresses', value: 'colibri.example.org:443, colibri.example.org:9212', variable: 'PROXY_TLS_ADDRESSES', mono: true }
        ]
    };

    const PROXY_CHECKING: Section = {
        id: 'proxy-certificate-0', title: 'Proxy TLS certificate', facts: [
            { label: 'Addresses', value: 'colibri.example.org:443, colibri.example.org:9212', variable: 'PROXY_TLS_ADDRESSES', mono: true },
            { label: 'Status', value: 'Checking', tone: 'off' }
        ]
    };

    const PROXY_TRUSTED: Section = {
        id: 'proxy-certificate-0', title: 'Proxy TLS certificate', facts: [
            { label: 'Addresses', value: 'colibri.example.org:443, colibri.example.org:9212', variable: 'PROXY_TLS_ADDRESSES', mono: true },
            { label: 'Trusted', value: 'Yes', tone: 'ok' },
            { label: 'Names', value: 'DNS:colibri.example.org', mono: true },
            { label: 'Issuer', value: 'CN=R11, O=Let\'s Encrypt, C=US' },
            { label: 'Valid from', value: '1970-04-01T00:00:00.000Z' },
            { label: 'Valid until', value: '1970-05-31T00:00:00.000Z', note: 'in 50 days' },
            { label: 'SHA-256 fingerprint', value: 'AB:CD', mono: true },
            { label: 'Checked', value: '1970-04-10T00:00:00.000Z' }
        ]
    };

    const VOICE_NOT_REPORTING: Section = {
        id: 'voice', title: 'Voice', facts: [
            { label: 'Voice server', value: 'Off', note: 'not listening', tone: 'off' },
            { label: 'Recording', value: 'Off', variable: 'VOICE_RECORDING', tone: 'off' },
            { label: 'Sampling rate', value: '0 Hz', variable: 'VOICE_SAMPLING_RATE' },
            { label: 'Voice clients', value: '0' }
        ]
    };

    describe('without TLS', () => {
        it('with no proxy', () => {
            expect(sections(snapshot())).toEqual([ SERVER, COUNTS, NETWORK_PLAIN, LIMITS, VOICE ]);
        });

        it('with IPv6 hosts and a base URL', () => {
            const s = snapshot({ settings: settings({ WEBSERVER_HOST: '::', TCP_HOST: '2001:db8::1', VOICE_HOST: 'colibri.example.org', BASE_URL: '/colibri' }) });
            expect(sections(s)).toEqual([
                SERVER, COUNTS,
                {
                    id: 'network', title: 'Network', facts: [
                        { label: 'Web', value: '[::]:9211', variable: 'WEBSERVER_HOST, WEBSERVER_PORT', note: 'HTTP and WS', mono: true },
                        { label: 'TCP', value: '[2001:db8::1]:9212', variable: 'TCP_HOST, TCP_PORT', note: 'unencrypted', mono: true },
                        { label: 'Voice', value: 'colibri.example.org:9213', variable: 'VOICE_HOST, VOICE_PORT', note: 'UDP', mono: true },
                        { label: 'Base URL', value: '/colibri', variable: 'BASE_URL', mono: true },
                        { label: 'TLS', value: 'Off', variable: 'TLS_CERT, TLS_KEY', tone: 'off' },
                        { label: 'Trusted proxies', value: 'None', variable: 'TRUSTED_PROXIES', tone: 'off', mono: false },
                        { label: 'PROXY protocol on TCP', value: 'Off', variable: 'TCP_PROXY_PROTOCOL', tone: 'off' },
                        { label: 'TCP TLS termination', value: 'Not declared', variable: 'TCP_TLS_AT_PROXY', tone: 'off' },
                        { label: 'Proxy TLS addresses', value: 'None', variable: 'PROXY_TLS_ADDRESSES', tone: 'off', mono: false }
                    ]
                },
                LIMITS, VOICE
            ]);
        });

        it('with trusted proxies and no PROXY protocol', () => {
            const s = snapshot({ settings: settings({ TRUSTED_PROXIES: [ 'loopback', '10.0.0.0/8' ] }) });
            expect(sections(s)).toEqual([
                SERVER, COUNTS,
                {
                    id: 'network', title: 'Network', facts: [
                        { label: 'Web', value: '0.0.0.0:9211', variable: 'WEBSERVER_HOST, WEBSERVER_PORT', note: 'HTTP and WS', mono: true },
                        { label: 'TCP', value: '0.0.0.0:9212', variable: 'TCP_HOST, TCP_PORT', note: 'unencrypted', mono: true },
                        { label: 'Voice', value: '0.0.0.0:9213', variable: 'VOICE_HOST, VOICE_PORT', note: 'UDP', mono: true },
                        { label: 'Base URL', value: '/', variable: 'BASE_URL', mono: true },
                        { label: 'TLS', value: 'Off', variable: 'TLS_CERT, TLS_KEY', tone: 'off' },
                        { label: 'Trusted proxies', value: 'loopback, 10.0.0.0/8', variable: 'TRUSTED_PROXIES', mono: true },
                        { label: 'PROXY protocol on TCP', value: 'Off', variable: 'TCP_PROXY_PROTOCOL', tone: 'off' },
                        { label: 'TCP TLS termination', value: 'Not declared', variable: 'TCP_TLS_AT_PROXY', tone: 'off' },
                        { label: 'Proxy TLS addresses', value: 'None', variable: 'PROXY_TLS_ADDRESSES', tone: 'off', mono: false }
                    ]
                },
                LIMITS, VOICE
            ]);
        });

        it('with the PROXY protocol and no trusted proxies', () => {
            const s = snapshot({ settings: settings({ TCP_PROXY_PROTOCOL: true }) });
            expect(sections(s)).toEqual([
                SERVER, COUNTS,
                {
                    id: 'network', title: 'Network', facts: [
                        { label: 'Web', value: '0.0.0.0:9211', variable: 'WEBSERVER_HOST, WEBSERVER_PORT', note: 'HTTP and WS', mono: true },
                        { label: 'TCP', value: '0.0.0.0:9212', variable: 'TCP_HOST, TCP_PORT', note: 'unencrypted', mono: true },
                        { label: 'Voice', value: '0.0.0.0:9213', variable: 'VOICE_HOST, VOICE_PORT', note: 'UDP', mono: true },
                        { label: 'Base URL', value: '/', variable: 'BASE_URL', mono: true },
                        { label: 'TLS', value: 'Off', variable: 'TLS_CERT, TLS_KEY', tone: 'off' },
                        { label: 'Trusted proxies', value: 'None', variable: 'TRUSTED_PROXIES', tone: 'off', mono: false },
                        { label: 'PROXY protocol on TCP', value: 'On', variable: 'TCP_PROXY_PROTOCOL', tone: 'ok' },
                        { label: 'TCP TLS termination', value: 'Not declared', variable: 'TCP_TLS_AT_PROXY', tone: 'off' },
                        { label: 'Proxy TLS addresses', value: 'None', variable: 'PROXY_TLS_ADDRESSES', tone: 'off', mono: false }
                    ]
                },
                LIMITS, VOICE
            ]);
        });
    });

    describe('with TLS by this server', () => {
        it('and a certificate valid for 100 more days', () => {
            expect(sections(snapshot({ tls: certificate() }))).toEqual([ SERVER, COUNTS, NETWORK_TLS, CERTIFICATE, LIMITS, VOICE ]);
        });

        it('and a self-signed certificate valid for exactly 30 more days, which is no reason to warn', () => {
            const s = snapshot({ tls: certificate({ selfSigned: true, issuer: 'CN=colibri-internal', validTo: 130 * DAY }) });
            expect(sections(s)).toEqual([
                SERVER, COUNTS, NETWORK_TLS,
                {
                    id: 'certificate', title: 'TLS certificate', facts: [
                        { label: 'Names', value: 'colibri.example.org', mono: true },
                        { label: 'Issuer', value: 'CN=colibri-internal', note: 'self-signed' },
                        { label: 'Valid from', value: '1970-01-01T00:00:00.000Z' },
                        { label: 'Valid until', value: '1970-05-11T00:00:00.000Z', note: 'in 30 days' },
                        { label: 'SHA-256 fingerprint', value: 'AB:CD', mono: true }
                    ]
                },
                LIMITS, VOICE
            ]);
        });

        it('and a certificate that expires in 29 days', () => {
            expect(sections(snapshot({ tls: certificate({ validTo: 129 * DAY + DAY / 2 }) }))).toEqual([
                SERVER, COUNTS, NETWORK_TLS,
                {
                    id: 'certificate', title: 'TLS certificate', facts: [
                        { label: 'Names', value: 'colibri.example.org', mono: true },
                        { label: 'Issuer', value: 'Example CA' },
                        { label: 'Valid from', value: '1970-01-01T00:00:00.000Z' },
                        { label: 'Valid until', value: '1970-05-10T12:00:00.000Z', note: 'expires in 29 days', tone: 'warn' },
                        { label: 'SHA-256 fingerprint', value: 'AB:CD', mono: true }
                    ]
                },
                LIMITS, VOICE
            ]);
        });

        it('and a certificate that expires in 1 day', () => {
            expect(sections(snapshot({ tls: certificate({ validTo: 101 * DAY }) }))).toEqual([
                SERVER, COUNTS, NETWORK_TLS,
                {
                    id: 'certificate', title: 'TLS certificate', facts: [
                        { label: 'Names', value: 'colibri.example.org', mono: true },
                        { label: 'Issuer', value: 'Example CA' },
                        { label: 'Valid from', value: '1970-01-01T00:00:00.000Z' },
                        { label: 'Valid until', value: '1970-04-12T00:00:00.000Z', note: 'expires in 1 day', tone: 'warn' },
                        { label: 'SHA-256 fingerprint', value: 'AB:CD', mono: true }
                    ]
                },
                LIMITS, VOICE
            ]);
        });

        it('and a certificate that expires today', () => {
            expect(sections(snapshot({ tls: certificate({ validTo: 100 * DAY + DAY / 4 }) }))).toEqual([
                SERVER, COUNTS, NETWORK_TLS,
                {
                    id: 'certificate', title: 'TLS certificate', facts: [
                        { label: 'Names', value: 'colibri.example.org', mono: true },
                        { label: 'Issuer', value: 'Example CA' },
                        { label: 'Valid from', value: '1970-01-01T00:00:00.000Z' },
                        { label: 'Valid until', value: '1970-04-11T06:00:00.000Z', note: 'expires today', tone: 'warn' },
                        { label: 'SHA-256 fingerprint', value: 'AB:CD', mono: true }
                    ]
                },
                LIMITS, VOICE
            ]);
        });

        it('and a certificate that expired a day ago', () => {
            expect(sections(snapshot({ tls: certificate({ validTo: 99 * DAY }) }))).toEqual([
                SERVER, COUNTS, NETWORK_TLS,
                {
                    id: 'certificate', title: 'TLS certificate', facts: [
                        { label: 'Names', value: 'colibri.example.org', mono: true },
                        { label: 'Issuer', value: 'Example CA' },
                        { label: 'Valid from', value: '1970-01-01T00:00:00.000Z' },
                        { label: 'Valid until', value: '1970-04-10T00:00:00.000Z', note: 'expired', tone: 'err' },
                        { label: 'SHA-256 fingerprint', value: 'AB:CD', mono: true }
                    ]
                },
                LIMITS, VOICE
            ]);
        });

        it('and a certificate that ends this very moment', () => {
            expect(sections(snapshot({ tls: certificate({ validTo: 100 * DAY }) }))).toEqual([
                SERVER, COUNTS, NETWORK_TLS,
                {
                    id: 'certificate', title: 'TLS certificate', facts: [
                        { label: 'Names', value: 'colibri.example.org', mono: true },
                        { label: 'Issuer', value: 'Example CA' },
                        { label: 'Valid from', value: '1970-01-01T00:00:00.000Z' },
                        { label: 'Valid until', value: '1970-04-11T00:00:00.000Z', note: 'expired', tone: 'err' },
                        { label: 'SHA-256 fingerprint', value: 'AB:CD', mono: true }
                    ]
                },
                LIMITS, VOICE
            ]);
        });

        it('and a certificate that is not valid yet', () => {
            expect(sections(snapshot({ tls: certificate({ validFrom: 102 * DAY }) }))).toEqual([
                SERVER, COUNTS, NETWORK_TLS,
                {
                    id: 'certificate', title: 'TLS certificate', facts: [
                        { label: 'Names', value: 'colibri.example.org', mono: true },
                        { label: 'Issuer', value: 'Example CA' },
                        { label: 'Valid from', value: '1970-04-13T00:00:00.000Z', note: 'not yet valid', tone: 'err' },
                        { label: 'Valid until', value: '1970-07-20T00:00:00.000Z', note: 'in 100 days' },
                        { label: 'SHA-256 fingerprint', value: 'AB:CD', mono: true }
                    ]
                },
                LIMITS, VOICE
            ]);
        });

        it('and a certificate that is valid from this very moment', () => {
            expect(sections(snapshot({ tls: certificate({ validFrom: 100 * DAY }) }))).toEqual([
                SERVER, COUNTS, NETWORK_TLS,
                {
                    id: 'certificate', title: 'TLS certificate', facts: [
                        { label: 'Names', value: 'colibri.example.org', mono: true },
                        { label: 'Issuer', value: 'Example CA' },
                        { label: 'Valid from', value: '1970-04-11T00:00:00.000Z' },
                        { label: 'Valid until', value: '1970-07-20T00:00:00.000Z', note: 'in 100 days' },
                        { label: 'SHA-256 fingerprint', value: 'AB:CD', mono: true }
                    ]
                },
                LIMITS, VOICE
            ]);
        });

        it('and TLS at a proxy as well, which a direct connection does not use', () => {
            const s = snapshot({ tls: certificate(), tlsAtProxy: { web: true, tcp: true }, settings: settings({ ...behindProxy, TCP_TLS_AT_PROXY: true }) });
            expect(sections(s)).toEqual([
                SERVER, COUNTS,
                {
                    id: 'network', title: 'Network', facts: [
                        { label: 'Web', value: '0.0.0.0:9211', variable: 'WEBSERVER_HOST, WEBSERVER_PORT', note: 'HTTPS and WSS', mono: true },
                        { label: 'TCP', value: '0.0.0.0:9212', variable: 'TCP_HOST, TCP_PORT', note: 'TLS', mono: true },
                        { label: 'Voice', value: '0.0.0.0:9213', variable: 'VOICE_HOST, VOICE_PORT', note: 'UDP', mono: true },
                        { label: 'Base URL', value: '/', variable: 'BASE_URL', mono: true },
                        { label: 'TLS', value: 'On', variable: 'TLS_CERT, TLS_KEY', tone: 'ok' },
                        { label: 'Trusted proxies', value: 'loopback', variable: 'TRUSTED_PROXIES', mono: true },
                        { label: 'PROXY protocol on TCP', value: 'On', variable: 'TCP_PROXY_PROTOCOL', tone: 'ok' },
                        { label: 'TCP TLS termination', value: 'Proxy', variable: 'TCP_TLS_AT_PROXY', tone: 'ok' },
                        { label: 'Proxy TLS addresses', value: 'None', variable: 'PROXY_TLS_ADDRESSES', tone: 'off', mono: false }
                    ]
                },
                CERTIFICATE, LIMITS, VOICE
            ]);
        });
    });

    describe('with TLS at a proxy', () => {
        it('for the web port', () => {
            expect(sections(snapshot({ tlsAtProxy: { web: true, tcp: false } }))).toEqual([
                SERVER, COUNTS,
                {
                    id: 'network', title: 'Network', facts: [
                        {
                            label: 'Web', value: '0.0.0.0:9211', variable: 'WEBSERVER_HOST, WEBSERVER_PORT', note: 'HTTP and WS, TLS terminated by proxy', mono: true,
                            title: 'TLS terminated by a trusted proxy (X-Forwarded-Proto: https from a connected web client or admin page)'
                        },
                        { label: 'TCP', value: '0.0.0.0:9212', variable: 'TCP_HOST, TCP_PORT', note: 'unencrypted', mono: true },
                        { label: 'Voice', value: '0.0.0.0:9213', variable: 'VOICE_HOST, VOICE_PORT', note: 'UDP', mono: true },
                        { label: 'Base URL', value: '/', variable: 'BASE_URL', mono: true },
                        {
                            label: 'TLS', value: 'Off', variable: 'TLS_CERT, TLS_KEY', note: 'terminated by proxy (HTTPS)', tone: 'off',
                            title: 'TLS terminated by a trusted proxy (X-Forwarded-Proto: https from a connected web client or admin page)'
                        },
                        { label: 'Trusted proxies', value: 'None', variable: 'TRUSTED_PROXIES', tone: 'off', mono: false },
                        { label: 'PROXY protocol on TCP', value: 'Off', variable: 'TCP_PROXY_PROTOCOL', tone: 'off' },
                        { label: 'TCP TLS termination', value: 'Not declared', variable: 'TCP_TLS_AT_PROXY', tone: 'off' },
                        { label: 'Proxy TLS addresses', value: 'None', variable: 'PROXY_TLS_ADDRESSES', tone: 'off', mono: false }
                    ]
                },
                LIMITS, VOICE
            ]);
        });

        it('for the TCP port, declared by TCP_TLS_AT_PROXY', () => {
            const s = snapshot({ tlsAtProxy: { web: false, tcp: true }, settings: settings({ ...behindProxy, TCP_TLS_AT_PROXY: true }) });
            expect(sections(s)).toEqual([
                SERVER, COUNTS,
                {
                    id: 'network', title: 'Network', facts: [
                        { label: 'Web', value: '0.0.0.0:9211', variable: 'WEBSERVER_HOST, WEBSERVER_PORT', note: 'HTTP and WS', mono: true },
                        {
                            label: 'TCP', value: '0.0.0.0:9212', variable: 'TCP_HOST, TCP_PORT', note: 'TLS terminated by proxy', mono: true,
                            title: 'Declared by TCP_TLS_AT_PROXY; PROXY protocol v1 carries no TLS information'
                        },
                        { label: 'Voice', value: '0.0.0.0:9213', variable: 'VOICE_HOST, VOICE_PORT', note: 'UDP', mono: true },
                        { label: 'Base URL', value: '/', variable: 'BASE_URL', mono: true },
                        {
                            label: 'TLS', value: 'Off', variable: 'TLS_CERT, TLS_KEY', note: 'terminated by proxy (TCP)', tone: 'off',
                            title: 'Declared by TCP_TLS_AT_PROXY; PROXY protocol v1 carries no TLS information'
                        },
                        { label: 'Trusted proxies', value: 'loopback', variable: 'TRUSTED_PROXIES', mono: true },
                        { label: 'PROXY protocol on TCP', value: 'On', variable: 'TCP_PROXY_PROTOCOL', tone: 'ok' },
                        { label: 'TCP TLS termination', value: 'Proxy', variable: 'TCP_TLS_AT_PROXY', tone: 'ok' },
                        { label: 'Proxy TLS addresses', value: 'None', variable: 'PROXY_TLS_ADDRESSES', tone: 'off', mono: false }
                    ]
                },
                LIMITS, VOICE
            ]);
        });

        it('for the web and the TCP port', () => {
            const s = snapshot({ tlsAtProxy: { web: true, tcp: true }, settings: settings({ ...behindProxy, TCP_TLS_AT_PROXY: true }) });
            expect(sections(s)).toEqual([
                SERVER, COUNTS,
                {
                    id: 'network', title: 'Network', facts: [
                        {
                            label: 'Web', value: '0.0.0.0:9211', variable: 'WEBSERVER_HOST, WEBSERVER_PORT', note: 'HTTP and WS, TLS terminated by proxy', mono: true,
                            title: 'TLS terminated by a trusted proxy (X-Forwarded-Proto: https from a connected web client or admin page)'
                        },
                        {
                            label: 'TCP', value: '0.0.0.0:9212', variable: 'TCP_HOST, TCP_PORT', note: 'TLS terminated by proxy', mono: true,
                            title: 'Declared by TCP_TLS_AT_PROXY; PROXY protocol v1 carries no TLS information'
                        },
                        { label: 'Voice', value: '0.0.0.0:9213', variable: 'VOICE_HOST, VOICE_PORT', note: 'UDP', mono: true },
                        { label: 'Base URL', value: '/', variable: 'BASE_URL', mono: true },
                        {
                            label: 'TLS', value: 'Off', variable: 'TLS_CERT, TLS_KEY', note: 'terminated by proxy (HTTPS, TCP)', tone: 'off',
                            title: 'TLS terminated by a trusted proxy (X-Forwarded-Proto: https from a connected web client or admin page)\nDeclared by TCP_TLS_AT_PROXY; PROXY protocol v1 carries no TLS information'
                        },
                        { label: 'Trusted proxies', value: 'loopback', variable: 'TRUSTED_PROXIES', mono: true },
                        { label: 'PROXY protocol on TCP', value: 'On', variable: 'TCP_PROXY_PROTOCOL', tone: 'ok' },
                        { label: 'TCP TLS termination', value: 'Proxy', variable: 'TCP_TLS_AT_PROXY', tone: 'ok' },
                        { label: 'Proxy TLS addresses', value: 'None', variable: 'PROXY_TLS_ADDRESSES', tone: 'off', mono: false }
                    ]
                },
                LIMITS, VOICE
            ]);
        });

        it('for the TCP port, not declared, with TCP_TLS_AT_PROXY set to false', () => {
            const s = snapshot({ settings: settings({ ...behindProxy, TCP_TLS_AT_PROXY: false }) });
            expect(sections(s)).toEqual([
                SERVER, COUNTS,
                {
                    id: 'network', title: 'Network', facts: [
                        { label: 'Web', value: '0.0.0.0:9211', variable: 'WEBSERVER_HOST, WEBSERVER_PORT', note: 'HTTP and WS', mono: true },
                        {
                            label: 'TCP', value: '0.0.0.0:9212', variable: 'TCP_HOST, TCP_PORT', note: 'unencrypted, proxy TLS undeclared', mono: true,
                            title: 'Set TCP_TLS_AT_PROXY=true if the proxy terminates TLS on this port. Unity apps tick \'Server supports SSL/TLS?\' whenever the proxy port uses TLS'
                        },
                        { label: 'Voice', value: '0.0.0.0:9213', variable: 'VOICE_HOST, VOICE_PORT', note: 'UDP', mono: true },
                        { label: 'Base URL', value: '/', variable: 'BASE_URL', mono: true },
                        { label: 'TLS', value: 'Off', variable: 'TLS_CERT, TLS_KEY', tone: 'off' },
                        { label: 'Trusted proxies', value: 'loopback', variable: 'TRUSTED_PROXIES', mono: true },
                        { label: 'PROXY protocol on TCP', value: 'On', variable: 'TCP_PROXY_PROTOCOL', tone: 'ok' },
                        { label: 'TCP TLS termination', value: 'Not declared', variable: 'TCP_TLS_AT_PROXY', tone: 'off' },
                        { label: 'Proxy TLS addresses', value: 'None', variable: 'PROXY_TLS_ADDRESSES', tone: 'off', mono: false }
                    ]
                },
                LIMITS, VOICE
            ]);
        });

        it('for the web port, with the TCP port not declared', () => {
            const s = snapshot({ tlsAtProxy: { web: true, tcp: false }, settings: settings(behindProxy) });
            expect(sections(s)).toEqual([
                SERVER, COUNTS,
                {
                    id: 'network', title: 'Network', facts: [
                        {
                            label: 'Web', value: '0.0.0.0:9211', variable: 'WEBSERVER_HOST, WEBSERVER_PORT', note: 'HTTP and WS, TLS terminated by proxy', mono: true,
                            title: 'TLS terminated by a trusted proxy (X-Forwarded-Proto: https from a connected web client or admin page)'
                        },
                        {
                            label: 'TCP', value: '0.0.0.0:9212', variable: 'TCP_HOST, TCP_PORT', note: 'unencrypted, proxy TLS undeclared', mono: true,
                            title: 'Set TCP_TLS_AT_PROXY=true if the proxy terminates TLS on this port. Unity apps tick \'Server supports SSL/TLS?\' whenever the proxy port uses TLS'
                        },
                        { label: 'Voice', value: '0.0.0.0:9213', variable: 'VOICE_HOST, VOICE_PORT', note: 'UDP', mono: true },
                        { label: 'Base URL', value: '/', variable: 'BASE_URL', mono: true },
                        {
                            label: 'TLS', value: 'Off', variable: 'TLS_CERT, TLS_KEY', note: 'terminated by proxy (HTTPS)', tone: 'off',
                            title: 'TLS terminated by a trusted proxy (X-Forwarded-Proto: https from a connected web client or admin page)'
                        },
                        { label: 'Trusted proxies', value: 'loopback', variable: 'TRUSTED_PROXIES', mono: true },
                        { label: 'PROXY protocol on TCP', value: 'On', variable: 'TCP_PROXY_PROTOCOL', tone: 'ok' },
                        { label: 'TCP TLS termination', value: 'Not declared', variable: 'TCP_TLS_AT_PROXY', tone: 'off' },
                        { label: 'Proxy TLS addresses', value: 'None', variable: 'PROXY_TLS_ADDRESSES', tone: 'off', mono: false }
                    ]
                },
                LIMITS, VOICE
            ]);
        });

        it('for the TCP port, declared without TCP_PROXY_PROTOCOL', () => {
            const s = snapshot({ settings: settings({ TRUSTED_PROXIES: [ 'loopback' ], TCP_TLS_AT_PROXY: true }) });
            expect(sections(s)).toEqual([
                SERVER, COUNTS,
                {
                    id: 'network', title: 'Network', facts: [
                        { label: 'Web', value: '0.0.0.0:9211', variable: 'WEBSERVER_HOST, WEBSERVER_PORT', note: 'HTTP and WS', mono: true },
                        { label: 'TCP', value: '0.0.0.0:9212', variable: 'TCP_HOST, TCP_PORT', note: 'unencrypted', mono: true },
                        { label: 'Voice', value: '0.0.0.0:9213', variable: 'VOICE_HOST, VOICE_PORT', note: 'UDP', mono: true },
                        { label: 'Base URL', value: '/', variable: 'BASE_URL', mono: true },
                        { label: 'TLS', value: 'Off', variable: 'TLS_CERT, TLS_KEY', tone: 'off' },
                        { label: 'Trusted proxies', value: 'loopback', variable: 'TRUSTED_PROXIES', mono: true },
                        { label: 'PROXY protocol on TCP', value: 'Off', variable: 'TCP_PROXY_PROTOCOL', tone: 'off' },
                        {
                            label: 'TCP TLS termination', value: 'Proxy', variable: 'TCP_TLS_AT_PROXY', note: 'needs TCP_PROXY_PROTOCOL', tone: 'warn',
                            title: 'No effect without TCP_PROXY_PROTOCOL: Unity clients through the proxy are not identified'
                        },
                        { label: 'Proxy TLS addresses', value: 'None', variable: 'PROXY_TLS_ADDRESSES', tone: 'off', mono: false }
                    ]
                },
                LIMITS, VOICE
            ]);
        });

        // The fact follows what the server reports in tlsAtProxy.tcp, not the settings.
        it('for the TCP port, declared and with the PROXY protocol, which the server reports as without effect', () => {
            const s = snapshot({ settings: settings({ ...behindProxy, TCP_TLS_AT_PROXY: true }) });
            expect(sections(s)).toEqual([
                SERVER, COUNTS,
                {
                    id: 'network', title: 'Network', facts: [
                        { label: 'Web', value: '0.0.0.0:9211', variable: 'WEBSERVER_HOST, WEBSERVER_PORT', note: 'HTTP and WS', mono: true },
                        {
                            label: 'TCP', value: '0.0.0.0:9212', variable: 'TCP_HOST, TCP_PORT', note: 'unencrypted, proxy TLS undeclared', mono: true,
                            title: 'Set TCP_TLS_AT_PROXY=true if the proxy terminates TLS on this port. Unity apps tick \'Server supports SSL/TLS?\' whenever the proxy port uses TLS'
                        },
                        { label: 'Voice', value: '0.0.0.0:9213', variable: 'VOICE_HOST, VOICE_PORT', note: 'UDP', mono: true },
                        { label: 'Base URL', value: '/', variable: 'BASE_URL', mono: true },
                        { label: 'TLS', value: 'Off', variable: 'TLS_CERT, TLS_KEY', tone: 'off' },
                        { label: 'Trusted proxies', value: 'loopback', variable: 'TRUSTED_PROXIES', mono: true },
                        { label: 'PROXY protocol on TCP', value: 'On', variable: 'TCP_PROXY_PROTOCOL', tone: 'ok' },
                        {
                            label: 'TCP TLS termination', value: 'Proxy', variable: 'TCP_TLS_AT_PROXY', note: 'needs TCP_PROXY_PROTOCOL', tone: 'warn',
                            title: 'No effect without TCP_PROXY_PROTOCOL: Unity clients through the proxy are not identified'
                        },
                        { label: 'Proxy TLS addresses', value: 'None', variable: 'PROXY_TLS_ADDRESSES', tone: 'off', mono: false }
                    ]
                },
                LIMITS, VOICE
            ]);
        });
    });

    describe('with PROXY_TLS_ADDRESSES', () => {
        const addresses = [ 'colibri.example.org:443', 'colibri.example.org:9212' ];
        const proxied = (proxyTls: ServerSnapshot['proxyTls'], overrides: Partial<ServerSnapshot> = {}) =>
            snapshot({ proxyTls, settings: settings({ PROXY_TLS_ADDRESSES: addresses }), ...overrides });
        const presented = (overrides: Partial<NonNullable<ProxyTlsInfo['certificate']>> = {}): NonNullable<ProxyTlsInfo['certificate']> => ({
            ...certificate({ names: 'DNS:colibri.example.org', issuer: 'CN=R11, O=Let\'s Encrypt, C=US', validFrom: 90 * DAY, validTo: 150 * DAY }),
            trusted: true, trustError: null, ...overrides
        });
        const checked = (address: string, result: Pick<ProxyTlsInfo, 'certificate' | 'error'>): ProxyTlsInfo =>
            ({ addresses: [ address ], checkedAt: 99 * DAY, ...result });

        it('before the first check has finished', () => {
            expect(sections(proxied([]))).toEqual([ SERVER, COUNTS, NETWORK_PROXY_ADDRESSES, PROXY_CHECKING, LIMITS, VOICE ]);
        });

        it('and a trusted certificate that two addresses present', () => {
            const s = proxied([ { addresses, checkedAt: 99 * DAY, certificate: presented(), error: null } ]);
            expect(sections(s)).toEqual([ SERVER, COUNTS, NETWORK_PROXY_ADDRESSES, PROXY_TRUSTED, LIMITS, VOICE ]);
        });

        it('and certificates that clients would refuse', () => {
            const s = proxied([
                checked(addresses[0]!, { certificate: presented({ validTo: 105 * DAY, trusted: false, trustError: 'CERT_HAS_EXPIRED', fingerprint256: '01:01' }), error: null }),
                checked(addresses[1]!, { certificate: presented({ trusted: false, fingerprint256: '02:02' }), error: null }),
                checked('colibri.example.org:8443', { certificate: presented({ validTo: 100 * DAY, fingerprint256: '03:03' }), error: null }),
                checked('colibri.example.org:8444', { certificate: presented({ validTo: 99 * DAY, trusted: false, trustError: 'CERT_HAS_EXPIRED', fingerprint256: '04:04' }), error: null })
            ]);
            expect(sections(s)).toEqual([
                SERVER, COUNTS, NETWORK_PROXY_ADDRESSES,
                {
                    id: 'proxy-certificate-0', title: 'Proxy TLS certificate', facts: [
                        { label: 'Addresses', value: 'colibri.example.org:443', variable: 'PROXY_TLS_ADDRESSES', mono: true },
                        {
                            label: 'Trusted', value: 'No', note: 'CERT_HAS_EXPIRED', tone: 'err',
                            title: 'Clients that check certificates refuse it at this address: the reason is OpenSSL\'s or Node\'s, checked against Node\'s certificate authorities and the address\'s host name'
                        },
                        { label: 'Names', value: 'DNS:colibri.example.org', mono: true },
                        { label: 'Issuer', value: 'CN=R11, O=Let\'s Encrypt, C=US' },
                        { label: 'Valid from', value: '1970-04-01T00:00:00.000Z' },
                        { label: 'Valid until', value: '1970-04-16T00:00:00.000Z', note: 'expires in 5 days', tone: 'warn' },
                        { label: 'SHA-256 fingerprint', value: '01:01', mono: true },
                        { label: 'Checked', value: '1970-04-10T00:00:00.000Z' }
                    ]
                },
                {
                    id: 'proxy-certificate-1', title: 'Proxy TLS certificate', facts: [
                        { label: 'Addresses', value: 'colibri.example.org:9212', variable: 'PROXY_TLS_ADDRESSES', mono: true },
                        {
                            label: 'Trusted', value: 'No', note: 'refused', tone: 'err',
                            title: 'Clients that check certificates refuse it at this address: the reason is OpenSSL\'s or Node\'s, checked against Node\'s certificate authorities and the address\'s host name'
                        },
                        { label: 'Names', value: 'DNS:colibri.example.org', mono: true },
                        { label: 'Issuer', value: 'CN=R11, O=Let\'s Encrypt, C=US' },
                        { label: 'Valid from', value: '1970-04-01T00:00:00.000Z' },
                        { label: 'Valid until', value: '1970-05-31T00:00:00.000Z', note: 'in 50 days' },
                        { label: 'SHA-256 fingerprint', value: '02:02', mono: true },
                        { label: 'Checked', value: '1970-04-10T00:00:00.000Z' }
                    ]
                },
                {
                    id: 'proxy-certificate-2', title: 'Proxy TLS certificate', facts: [
                        { label: 'Addresses', value: 'colibri.example.org:8443', variable: 'PROXY_TLS_ADDRESSES', mono: true },
                        {
                            label: 'Trusted', value: 'No', note: 'expired', tone: 'err',
                            title: 'Clients that check certificates refuse it at this address: the reason is OpenSSL\'s or Node\'s, checked against Node\'s certificate authorities and the address\'s host name'
                        },
                        { label: 'Names', value: 'DNS:colibri.example.org', mono: true },
                        { label: 'Issuer', value: 'CN=R11, O=Let\'s Encrypt, C=US' },
                        { label: 'Valid from', value: '1970-04-01T00:00:00.000Z' },
                        { label: 'Valid until', value: '1970-04-11T00:00:00.000Z', note: 'expired', tone: 'err' },
                        { label: 'SHA-256 fingerprint', value: '03:03', mono: true },
                        { label: 'Checked', value: '1970-04-10T00:00:00.000Z' }
                    ]
                },
                {
                    id: 'proxy-certificate-3', title: 'Proxy TLS certificate', facts: [
                        { label: 'Addresses', value: 'colibri.example.org:8444', variable: 'PROXY_TLS_ADDRESSES', mono: true },
                        {
                            label: 'Trusted', value: 'No', note: 'expired', tone: 'err',
                            title: 'Clients that check certificates refuse it at this address: the reason is OpenSSL\'s or Node\'s, checked against Node\'s certificate authorities and the address\'s host name'
                        },
                        { label: 'Names', value: 'DNS:colibri.example.org', mono: true },
                        { label: 'Issuer', value: 'CN=R11, O=Let\'s Encrypt, C=US' },
                        { label: 'Valid from', value: '1970-04-01T00:00:00.000Z' },
                        { label: 'Valid until', value: '1970-04-10T00:00:00.000Z', note: 'expired', tone: 'err' },
                        { label: 'SHA-256 fingerprint', value: '04:04', mono: true },
                        { label: 'Checked', value: '1970-04-10T00:00:00.000Z' }
                    ]
                },
                LIMITS, VOICE
            ]);
        });

        it('and addresses that could not be reached', () => {
            const s = proxied([
                checked(addresses[0]!, { certificate: null, error: 'connect ECONNREFUSED 10.20.0.1:443' }),
                checked(addresses[1]!, { certificate: null, error: null })
            ]);
            expect(sections(s)).toEqual([
                SERVER, COUNTS, NETWORK_PROXY_ADDRESSES,
                {
                    id: 'proxy-certificate-0', title: 'Proxy TLS certificate', facts: [
                        { label: 'Addresses', value: 'colibri.example.org:443', variable: 'PROXY_TLS_ADDRESSES', mono: true },
                        { label: 'Connection', value: 'Failed', note: 'connect ECONNREFUSED 10.20.0.1:443', tone: 'err' },
                        { label: 'Checked', value: '1970-04-10T00:00:00.000Z' }
                    ]
                },
                {
                    id: 'proxy-certificate-1', title: 'Proxy TLS certificate', facts: [
                        { label: 'Addresses', value: 'colibri.example.org:9212', variable: 'PROXY_TLS_ADDRESSES', mono: true },
                        { label: 'Connection', value: 'Failed', tone: 'err' },
                        { label: 'Checked', value: '1970-04-10T00:00:00.000Z' }
                    ]
                },
                LIMITS, VOICE
            ]);
        });

        it('and the server\'s own certificate next to the proxy\'s', () => {
            const own = certificate({ names: 'DNS:colibri-internal', selfSigned: true, issuer: 'CN=colibri-internal', fingerprint256: 'EF:01' });
            const s = proxied([ { addresses, checkedAt: 99 * DAY, certificate: presented(), error: null } ], { tls: own });
            expect(sections(s)).toEqual([
                SERVER, COUNTS, NETWORK_TLS_PROXY_ADDRESSES,
                {
                    id: 'certificate', title: 'TLS certificate (this server)', facts: [
                        { label: 'Names', value: 'DNS:colibri-internal', mono: true },
                        { label: 'Issuer', value: 'CN=colibri-internal', note: 'self-signed' },
                        { label: 'Valid from', value: '1970-01-01T00:00:00.000Z' },
                        { label: 'Valid until', value: '1970-07-20T00:00:00.000Z', note: 'in 100 days' },
                        { label: 'SHA-256 fingerprint', value: 'EF:01', mono: true }
                    ]
                },
                PROXY_TRUSTED, LIMITS, VOICE
            ]);
        });

        it('and the server\'s own certificate while the first check is running', () => {
            expect(sections(proxied([], { tls: certificate() }))).toEqual([
                SERVER, COUNTS, NETWORK_TLS_PROXY_ADDRESSES,
                {
                    id: 'certificate', title: 'TLS certificate (this server)', facts: [
                        { label: 'Names', value: 'colibri.example.org', mono: true },
                        { label: 'Issuer', value: 'Example CA' },
                        { label: 'Valid from', value: '1970-01-01T00:00:00.000Z' },
                        { label: 'Valid until', value: '1970-07-20T00:00:00.000Z', note: 'in 100 days' },
                        { label: 'SHA-256 fingerprint', value: 'AB:CD', mono: true }
                    ]
                },
                PROXY_CHECKING, LIMITS, VOICE
            ]);
        });
    });

    describe('with the limits', () => {
        it('all on', () => {
            const s = snapshot({ settings: settings({ APP_CLIENT_WARNING_THRESHOLD: 1, STORE_EXPIRY_DAYS: 1, STORE_MAX_MB: 512 }) });
            expect(sections(s)).toEqual([
                SERVER, COUNTS, NETWORK_PLAIN,
                {
                    id: 'limits', title: 'Load limits', facts: [
                        { label: 'Messages per client', value: '1,000 a second', variable: 'CLIENT_MESSAGE_RATE_LIMIT' },
                        { label: 'Burst', value: '2,000 messages', variable: 'CLIENT_MESSAGE_RATE_BURST' },
                        { label: 'TCP inbound backlog', value: '2,000 messages', variable: 'TCP_INBOUND_BACKLOG_LIMIT' },
                        { label: 'TCP idle timeout', value: '10 s', variable: 'TCP_IDLE_TIMEOUT_SECONDS' },
                        { label: 'App client warning', value: 'above 1 client', variable: 'APP_CLIENT_WARNING_THRESHOLD' },
                        { label: 'Deleted models kept', value: '600 s', variable: 'MODEL_TOMBSTONE_SECONDS' },
                        { label: 'REST store values kept', value: '1 day after their last write', variable: 'STORE_EXPIRY_DAYS' },
                        { label: 'REST store size', value: '512 MiB', variable: 'STORE_MAX_MB' }
                    ]
                },
                VOICE
            ]);
        });

        it('all off, which leaves the burst off whatever it is set to', () => {
            const s = snapshot({
                settings: settings({
                    CLIENT_MESSAGE_RATE_LIMIT: 0, TCP_INBOUND_BACKLOG_LIMIT: 0, TCP_IDLE_TIMEOUT_SECONDS: 0, APP_CLIENT_WARNING_THRESHOLD: 0,
                    MODEL_TOMBSTONE_SECONDS: 0, STORE_EXPIRY_DAYS: 0, STORE_MAX_MB: 0
                })
            });
            expect(sections(s)).toEqual([
                SERVER,
                {
                    id: 'counts', title: 'Clients and data', facts: [
                        { label: 'Unity clients', value: '3', note: 'TCP', link: '/clients' },
                        { label: 'Web clients', value: '2', note: 'Socket.IO', link: '/clients' },
                        { label: 'Apps', value: '2', note: 'with clients connected' },
                        { label: 'Admin pages', value: '1', note: 'open, this one included' },
                        { label: 'Synced models', value: '1,234', note: 'in 3 channels of 2 apps', link: '/models' },
                        { label: 'Recently deleted models', value: '4', note: 'kept for 0 s', link: '/models' },
                        { label: 'REST store', value: '7 values', note: 'in 1 app, 1.5 KiB' }
                    ]
                },
                NETWORK_PLAIN,
                {
                    id: 'limits', title: 'Load limits', facts: [
                        { label: 'Messages per client', value: 'Off', variable: 'CLIENT_MESSAGE_RATE_LIMIT', tone: 'off' },
                        { label: 'Burst', value: 'Off', variable: 'CLIENT_MESSAGE_RATE_BURST', tone: 'off' },
                        { label: 'TCP inbound backlog', value: 'Off', variable: 'TCP_INBOUND_BACKLOG_LIMIT', tone: 'off' },
                        { label: 'TCP idle timeout', value: 'Off', variable: 'TCP_IDLE_TIMEOUT_SECONDS', tone: 'off' },
                        { label: 'App client warning', value: 'Off', variable: 'APP_CLIENT_WARNING_THRESHOLD', tone: 'off' },
                        { label: 'Deleted models kept', value: 'Off', variable: 'MODEL_TOMBSTONE_SECONDS', tone: 'off' },
                        { label: 'REST store values kept', value: 'Off', variable: 'STORE_EXPIRY_DAYS', tone: 'off' },
                        { label: 'REST store size', value: 'Off', variable: 'STORE_MAX_MB', tone: 'off' }
                    ]
                },
                VOICE
            ]);
        });

        it('with only the burst off', () => {
            const s = snapshot({ settings: settings({ CLIENT_MESSAGE_RATE_BURST: 0 }) });
            expect(sections(s)).toEqual([
                SERVER, COUNTS, NETWORK_PLAIN,
                {
                    id: 'limits', title: 'Load limits', facts: [
                        { label: 'Messages per client', value: '1,000 a second', variable: 'CLIENT_MESSAGE_RATE_LIMIT' },
                        { label: 'Burst', value: 'Off', variable: 'CLIENT_MESSAGE_RATE_BURST', tone: 'off' },
                        { label: 'TCP inbound backlog', value: '2,000 messages', variable: 'TCP_INBOUND_BACKLOG_LIMIT' },
                        { label: 'TCP idle timeout', value: '10 s', variable: 'TCP_IDLE_TIMEOUT_SECONDS' },
                        { label: 'App client warning', value: 'above 8 clients', variable: 'APP_CLIENT_WARNING_THRESHOLD' },
                        { label: 'Deleted models kept', value: '600 s', variable: 'MODEL_TOMBSTONE_SECONDS' },
                        { label: 'REST store values kept', value: '30 days after their last write', variable: 'STORE_EXPIRY_DAYS' },
                        { label: 'REST store size', value: 'Off', variable: 'STORE_MAX_MB', tone: 'off' }
                    ]
                },
                VOICE
            ]);
        });

        it('that the server sends as text', () => {
            const s = snapshot({
                settings: settings({
                    CLIENT_MESSAGE_RATE_LIMIT: 'fast', CLIENT_MESSAGE_RATE_BURST: 'bursty', TCP_INBOUND_BACKLOG_LIMIT: 'many', TCP_IDLE_TIMEOUT_SECONDS: 'soon',
                    APP_CLIENT_WARNING_THRESHOLD: 'some', MODEL_TOMBSTONE_SECONDS: 'a while', STORE_EXPIRY_DAYS: 'later', STORE_MAX_MB: 'big'
                })
            });
            expect(sections(s)).toEqual([
                SERVER,
                {
                    id: 'counts', title: 'Clients and data', facts: [
                        { label: 'Unity clients', value: '3', note: 'TCP', link: '/clients' },
                        { label: 'Web clients', value: '2', note: 'Socket.IO', link: '/clients' },
                        { label: 'Apps', value: '2', note: 'with clients connected' },
                        { label: 'Admin pages', value: '1', note: 'open, this one included' },
                        { label: 'Synced models', value: '1,234', note: 'in 3 channels of 2 apps', link: '/models' },
                        { label: 'Recently deleted models', value: '4', note: 'kept for a while s', link: '/models' },
                        { label: 'REST store', value: '7 values', note: 'in 1 app, 1.5 KiB' }
                    ]
                },
                NETWORK_PLAIN,
                {
                    id: 'limits', title: 'Load limits', facts: [
                        { label: 'Messages per client', value: 'fast', variable: 'CLIENT_MESSAGE_RATE_LIMIT' },
                        { label: 'Burst', value: 'bursty', variable: 'CLIENT_MESSAGE_RATE_BURST' },
                        { label: 'TCP inbound backlog', value: 'many', variable: 'TCP_INBOUND_BACKLOG_LIMIT' },
                        { label: 'TCP idle timeout', value: 'soon', variable: 'TCP_IDLE_TIMEOUT_SECONDS' },
                        { label: 'App client warning', value: 'some', variable: 'APP_CLIENT_WARNING_THRESHOLD' },
                        { label: 'Deleted models kept', value: 'a while', variable: 'MODEL_TOMBSTONE_SECONDS' },
                        { label: 'REST store values kept', value: 'later', variable: 'STORE_EXPIRY_DAYS' },
                        { label: 'REST store size', value: 'big', variable: 'STORE_MAX_MB' }
                    ]
                },
                VOICE
            ]);
        });

        it('that a server without these settings does not send', () => {
            const s = snapshot({ settings: {}, build: { commit: null, dirty: false, builtAt: null }, voice: null });
            expect(sections(s)).toEqual([
                {
                    id: 'server', title: 'Server', facts: [
                        { label: 'Version', value: '2.0.0', mono: true },
                        { label: 'Commit', value: 'unknown', tone: 'off', title: 'Built without git information, e.g. a Docker build without COLIBRI_COMMIT' },
                        { label: 'Protocol version', value: '2', mono: true },
                        { label: 'Node.js', value: 'v24.21.0', mono: true },
                        { label: 'Started', value: '1970-04-10T22:57:55.000Z' },
                        { label: 'Uptime', value: '1 h 2 min' }
                    ]
                },
                {
                    id: 'counts', title: 'Clients and data', facts: [
                        { label: 'Unity clients', value: '3', note: 'TCP', link: '/clients' },
                        { label: 'Web clients', value: '2', note: 'Socket.IO', link: '/clients' },
                        { label: 'Apps', value: '2', note: 'with clients connected' },
                        { label: 'Admin pages', value: '1', note: 'open, this one included' },
                        { label: 'Synced models', value: '1,234', note: 'in 3 channels of 2 apps', link: '/models' },
                        { label: 'Recently deleted models', value: '4', note: 'kept for - s', link: '/models' },
                        { label: 'REST store', value: '7 values', note: 'in 1 app, 1.5 KiB' }
                    ]
                },
                {
                    id: 'network', title: 'Network', facts: [
                        { label: 'Web', value: '-:-', variable: 'WEBSERVER_HOST, WEBSERVER_PORT', note: 'HTTP and WS', mono: true },
                        { label: 'TCP', value: '-:-', variable: 'TCP_HOST, TCP_PORT', note: 'unencrypted', mono: true },
                        { label: 'Voice', value: '-:-', variable: 'VOICE_HOST, VOICE_PORT', note: 'UDP', mono: true },
                        { label: 'Base URL', value: '-', variable: 'BASE_URL', mono: true },
                        { label: 'TLS', value: 'Off', variable: 'TLS_CERT, TLS_KEY', tone: 'off' },
                        { label: 'Trusted proxies', value: 'None', variable: 'TRUSTED_PROXIES', tone: 'off', mono: false },
                        { label: 'PROXY protocol on TCP', value: 'Off', variable: 'TCP_PROXY_PROTOCOL', tone: 'off' },
                        { label: 'TCP TLS termination', value: 'Not declared', variable: 'TCP_TLS_AT_PROXY', tone: 'off' },
                        { label: 'Proxy TLS addresses', value: 'None', variable: 'PROXY_TLS_ADDRESSES', tone: 'off', mono: false }
                    ]
                },
                {
                    id: 'limits', title: 'Load limits', facts: [
                        { label: 'Messages per client', value: '-', variable: 'CLIENT_MESSAGE_RATE_LIMIT' },
                        { label: 'Burst', value: '-', variable: 'CLIENT_MESSAGE_RATE_BURST' },
                        { label: 'TCP inbound backlog', value: '-', variable: 'TCP_INBOUND_BACKLOG_LIMIT' },
                        { label: 'TCP idle timeout', value: '-', variable: 'TCP_IDLE_TIMEOUT_SECONDS' },
                        { label: 'App client warning', value: '-', variable: 'APP_CLIENT_WARNING_THRESHOLD' },
                        { label: 'Deleted models kept', value: '-', variable: 'MODEL_TOMBSTONE_SECONDS' },
                        { label: 'REST store values kept', value: '-', variable: 'STORE_EXPIRY_DAYS' },
                        { label: 'REST store size', value: '-', variable: 'STORE_MAX_MB' }
                    ]
                },
                VOICE_NOT_REPORTING
            ]);
        });
    });

    describe('with the voice server', () => {
        it('not listening', () => {
            const s = snapshot({ voice: { listening: false, recording: true, samplingRate: 16000, clients: 0 } });
            expect(sections(s)).toEqual([
                SERVER, COUNTS, NETWORK_PLAIN, LIMITS,
                {
                    id: 'voice', title: 'Voice', facts: [
                        { label: 'Voice server', value: 'Off', note: 'not listening', tone: 'off' },
                        { label: 'Recording', value: 'On', variable: 'VOICE_RECORDING', tone: 'ok' },
                        { label: 'Sampling rate', value: '16,000 Hz', variable: 'VOICE_SAMPLING_RATE' },
                        { label: 'Voice clients', value: '0' }
                    ]
                }
            ]);
        });

        it('listening, with clients', () => {
            const s = snapshot({ voice: { listening: true, recording: true, samplingRate: 44100, clients: 12 } });
            expect(sections(s)).toEqual([
                SERVER, COUNTS, NETWORK_PLAIN, LIMITS,
                {
                    id: 'voice', title: 'Voice', facts: [
                        { label: 'Voice server', value: 'On', tone: 'ok' },
                        { label: 'Recording', value: 'On', variable: 'VOICE_RECORDING', tone: 'ok' },
                        { label: 'Sampling rate', value: '44,100 Hz', variable: 'VOICE_SAMPLING_RATE' },
                        { label: 'Voice clients', value: '12' }
                    ]
                }
            ]);
        });

        it('not reporting, which leaves recording and the sampling rate to the settings', () => {
            const s = snapshot({ voice: null, settings: settings({ VOICE_RECORDING: true, VOICE_SAMPLING_RATE: 44100 }) });
            expect(sections(s)).toEqual([
                SERVER, COUNTS, NETWORK_PLAIN, LIMITS,
                {
                    id: 'voice', title: 'Voice', facts: [
                        { label: 'Voice server', value: 'Off', note: 'not listening', tone: 'off' },
                        { label: 'Recording', value: 'On', variable: 'VOICE_RECORDING', tone: 'ok' },
                        { label: 'Sampling rate', value: '44,100 Hz', variable: 'VOICE_SAMPLING_RATE' },
                        { label: 'Voice clients', value: '0' }
                    ]
                }
            ]);
        });

        it('not reporting, with a sampling rate that is no number', () => {
            const s = snapshot({ voice: null, settings: settings({ VOICE_SAMPLING_RATE: 'high' }) });
            expect(sections(s)).toEqual([ SERVER, COUNTS, NETWORK_PLAIN, LIMITS, VOICE_NOT_REPORTING ]);
        });
    });

    describe('with the build, the counts and the other settings', () => {
        it('built without git information, with a build time', () => {
            const s = snapshot({ build: { commit: null, dirty: false, builtAt: 99 * DAY } });
            expect(sections(s)).toEqual([
                {
                    id: 'server', title: 'Server', facts: [
                        { label: 'Version', value: '2.0.0', mono: true },
                        {
                            label: 'Commit', value: 'unknown', tone: 'off',
                            title: 'Built without git information, e.g. a Docker build without COLIBRI_COMMIT\nBuilt 1970-04-10T00:00:00.000Z'
                        },
                        { label: 'Protocol version', value: '2', mono: true },
                        { label: 'Node.js', value: 'v24.21.0', mono: true },
                        { label: 'Started', value: '1970-04-10T22:57:55.000Z' },
                        { label: 'Uptime', value: '1 h 2 min' }
                    ]
                },
                COUNTS, NETWORK_PLAIN, LIMITS, VOICE
            ]);
        });

        it('built with uncommitted changes, without a build time', () => {
            const s = snapshot({ build: { commit: '3e2855e0c1d2b3a4f5e6d7c8b9a0f1e2d3c4b5a6', dirty: true, builtAt: null } });
            expect(sections(s)).toEqual([
                {
                    id: 'server', title: 'Server', facts: [
                        { label: 'Version', value: '2.0.0', mono: true },
                        { label: 'Commit', value: '3e2855e0c1', note: 'uncommitted changes', mono: true, title: '3e2855e0c1d2b3a4f5e6d7c8b9a0f1e2d3c4b5a6' },
                        { label: 'Protocol version', value: '2', mono: true },
                        { label: 'Node.js', value: 'v24.21.0', mono: true },
                        { label: 'Started', value: '1970-04-10T22:57:55.000Z' },
                        { label: 'Uptime', value: '1 h 2 min' }
                    ]
                },
                COUNTS, NETWORK_PLAIN, LIMITS, VOICE
            ]);
        });

        it('with nothing synced, stored or connected', () => {
            const s = snapshot({
                counts: {
                    tcpClients: 0, webClients: 0, adminPages: 0, apps: 0, models: 0, modelApps: 0, modelChannels: 0,
                    deletedModels: 0, storeApps: 0, storeKeys: 0, storeBytes: 0
                }
            });
            expect(sections(s)).toEqual([
                SERVER,
                {
                    id: 'counts', title: 'Clients and data', facts: [
                        { label: 'Unity clients', value: '0', note: 'TCP', link: '/clients' },
                        { label: 'Web clients', value: '0', note: 'Socket.IO', link: '/clients' },
                        { label: 'Apps', value: '0', note: 'with clients connected' },
                        { label: 'Admin pages', value: '0', note: 'open, this one included' },
                        { label: 'Synced models', value: '0', note: 'in 0 channels of 0 apps', link: '/models' },
                        { label: 'Recently deleted models', value: '0', note: 'kept for 600 s', link: '/models' },
                        { label: 'REST store', value: '0 values', note: 'in 0 apps, 0 B' }
                    ]
                },
                NETWORK_PLAIN, LIMITS, VOICE
            ]);
        });

        it('with one channel, one app, one value and nothing deleted', () => {
            const s = snapshot({
                counts: {
                    tcpClients: 1, webClients: 0, adminPages: 1, apps: 1, models: 1, modelApps: 1, modelChannels: 1,
                    deletedModels: 0, storeApps: 1, storeKeys: 1, storeBytes: 0
                }
            });
            expect(sections(s)).toEqual([
                SERVER,
                {
                    id: 'counts', title: 'Clients and data', facts: [
                        { label: 'Unity clients', value: '1', note: 'TCP', link: '/clients' },
                        { label: 'Web clients', value: '0', note: 'Socket.IO', link: '/clients' },
                        { label: 'Apps', value: '1', note: 'with clients connected' },
                        { label: 'Admin pages', value: '1', note: 'open, this one included' },
                        { label: 'Synced models', value: '1', note: 'in 1 channel of 1 app', link: '/models' },
                        { label: 'Recently deleted models', value: '0', note: 'kept for 600 s', link: '/models' },
                        { label: 'REST store', value: '1 value', note: 'in 1 app, 0 B' }
                    ]
                },
                NETWORK_PLAIN, LIMITS, VOICE
            ]);
        });

        it('with settings it does not know, in order', () => {
            const s = snapshot({
                settings: settings({
                    ZETA: 'x', ALPHA: true, MID_LIST: [ 'a', 'b' ], EMPTY_LIST: [], COUNT: 5, BLANK: '', SWITCH: false
                })
            });
            expect(sections(s)).toEqual([
                SERVER, COUNTS, NETWORK_PLAIN, LIMITS, VOICE,
                {
                    id: 'other', title: 'Other settings', facts: [
                        { label: 'ALPHA', value: 'on', mono: true },
                        { label: 'BLANK', value: '', mono: true },
                        { label: 'COUNT', value: '5', mono: true },
                        { label: 'EMPTY_LIST', value: 'none', mono: true },
                        { label: 'MID_LIST', value: 'a, b', mono: true },
                        { label: 'SWITCH', value: 'off', mono: true },
                        { label: 'ZETA', value: 'x', mono: true }
                    ]
                }
            ]);
        });
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
