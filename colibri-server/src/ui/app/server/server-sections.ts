import type { BuildInfo, ServerSnapshot, SettingValue, TlsInfo } from '../connection/admin.service';
import { bytes, count, duration } from '../format';

export interface Fact {
    label: string;
    value: string;
    /** The variable that sets it. */
    variable?: string;
    /** More about the value, after it. */
    note?: string;
    tone?: 'ok' | 'warn' | 'err' | 'off';
    mono?: boolean;
    /** Shown on hover. */
    title?: string;
    /** A page that shows more of it. */
    link?: string;
}

export interface Section {
    id: string;
    title: string;
    facts: Fact[];
}

/** A certificate this close to its end gets a warning, in days. */
const EXPIRY_WARNING_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

// The settings each section shows; the rest are listed under Other settings.
const SHOWN = new Set([
    'WEBSERVER_HOST', 'WEBSERVER_PORT', 'BASE_URL', 'TCP_HOST', 'TCP_PORT', 'VOICE_HOST', 'VOICE_PORT',
    'VOICE_SAMPLING_RATE', 'VOICE_RECORDING', 'TCP_IDLE_TIMEOUT_SECONDS', 'TCP_INBOUND_BACKLOG_LIMIT',
    'CLIENT_MESSAGE_RATE_LIMIT', 'CLIENT_MESSAGE_RATE_BURST', 'APP_CLIENT_WARNING_THRESHOLD',
    'MODEL_TOMBSTONE_SECONDS', 'STORE_EXPIRY_DAYS', 'STORE_MAX_MB', 'TRUSTED_PROXIES', 'TCP_PROXY_PROTOCOL', 'TCP_TLS_AT_PROXY', 'PROXY_TLS_ADDRESSES'
]);

const text = function (value: SettingValue | undefined): string {
    if (value === undefined) return '-';
    if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : 'none';
    if (typeof value === 'boolean') return value ? 'on' : 'off';
    return `${value}`;
};

// An IPv6 host in brackets, as in a URL: [::]:9211, not :::9211.
const hostPort = function (host: SettingValue | undefined, port: SettingValue | undefined): string {
    const name = text(host);
    return `${name.includes(':') ? `[${name}]` : name}:${text(port)}`;
};

const number = function (value: SettingValue | undefined): number | null {
    return typeof value === 'number' ? value : null;
};

const plural = function (n: number, one: string, many: string): string {
    return `${count(n)} ${n === 1 ? one : many}`;
};

/** A limit that 0 turns off. */
const limit = function (label: string, variable: string, value: SettingValue | undefined, format: (n: number) => string): Fact {
    const n = number(value);
    return n === 0
        ? { label, variable, value: 'Off', tone: 'off' }
        : { label, variable, value: n === null ? text(value) : format(n) };
};

// As the server's log names it: unique in the repository, and git takes it wherever it takes a hash.
const SHORT_COMMIT_LENGTH = 10;

/** The commit it was built from, for a build with its own changes; the full hash and the build time on hover. */
const commit = function (build: BuildInfo, format: (time: number) => string): Fact {
    const built = build.builtAt === null ? [] : [ `Built ${format(build.builtAt)}` ];
    if (build.commit === null) {
        return {
            label: 'Commit', value: 'unknown', tone: 'off',
            title: [ 'Built without git information, e.g. a Docker build without COLIBRI_COMMIT', ...built ].join('\n')
        };
    }
    return {
        label: 'Commit', value: build.commit.slice(0, SHORT_COMMIT_LENGTH), mono: true,
        note: build.dirty ? 'uncommitted changes' : undefined,
        title: [ build.commit, ...built ].join('\n')
    };
};

const onOff = function (label: string, on: boolean, variable?: string, note?: string): Fact {
    return { label, variable, value: on ? 'On' : 'Off', tone: on ? 'ok' : 'off', note };
};

/** On hover: why the web port counts as TLS terminated by a proxy. */
const WEB_TLS_AT_PROXY = 'TLS terminated by a trusted proxy (X-Forwarded-Proto: https from a connected web client or admin page)';
/** On hover: why the TCP port counts as TLS terminated by a proxy. */
const TCP_TLS_AT_PROXY = 'Declared by TCP_TLS_AT_PROXY; PROXY protocol v1 carries no TLS information';
/** On hover: TCP through a trusted proxy, TCP_TLS_AT_PROXY unset. */
const TCP_TLS_UNDECLARED = 'Set TCP_TLS_AT_PROXY=true if the proxy terminates TLS on this port. '
    + 'Unity apps tick \'Server supports SSL/TLS?\' whenever the proxy port uses TLS';
/** On hover: TCP_TLS_AT_PROXY set without TCP_PROXY_PROTOCOL. */
const TCP_TLS_NO_EFFECT = 'No effect without TCP_PROXY_PROTOCOL: Unity clients through the proxy are not identified';

/** On hover: a proxy certificate that clients would refuse. */
const PROXY_UNTRUSTED = 'Clients that check certificates refuse it at this address: the reason is OpenSSL\'s or Node\'s, '
    + 'checked against Node\'s certificate authorities and the address\'s host name';

/** A certificate's names, issuer, validity and fingerprint, with a warning when it is about to expire. */
const certificateFacts = function (cert: TlsInfo, at: number, format: (time: number) => string): Fact[] {
    const days = Math.floor((cert.validTo - at) / DAY);
    const expiry: Fact = { label: 'Valid until', value: format(cert.validTo) };
    if (cert.validTo <= at) Object.assign(expiry, { tone: 'err', note: 'expired' });
    else if (days < EXPIRY_WARNING_DAYS) Object.assign(expiry, { tone: 'warn', note: days === 0 ? 'expires today' : `expires in ${plural(days, 'day', 'days')}` });
    else expiry.note = `in ${plural(days, 'day', 'days')}`;

    return [
        { label: 'Names', value: cert.names, mono: true },
        { label: 'Issuer', value: cert.issuer, note: cert.selfSigned ? 'self-signed' : undefined },
        { label: 'Valid from', value: format(cert.validFrom), tone: cert.validFrom > at ? 'err' : undefined, note: cert.validFrom > at ? 'not yet valid' : undefined },
        expiry,
        { label: 'SHA-256 fingerprint', value: cert.fingerprint256, mono: true }
    ];
};

const serverSection = function (s: ServerSnapshot, format: (time: number) => string): Section {
    return {
        id: 'server', title: 'Server', facts: [
            { label: 'Version', value: s.version, mono: true },
            commit(s.build, format),
            { label: 'Protocol version', value: s.protocolVersion, mono: true },
            { label: 'Node.js', value: s.node, mono: true },
            { label: 'Started', value: format(s.startedAt) },
            { label: 'Uptime', value: duration(s.uptime) }
        ]
    };
};

const countsSection = function (s: ServerSnapshot): Section {
    const set = s.settings;
    return {
        id: 'counts', title: 'Clients and data', facts: [
            { label: 'Unity clients', value: count(s.counts.tcpClients), note: 'TCP', link: '/clients' },
            { label: 'Web clients', value: count(s.counts.webClients), note: 'Socket.IO', link: '/clients' },
            { label: 'Apps', value: count(s.counts.apps), note: 'with clients connected' },
            { label: 'Admin pages', value: count(s.counts.adminPages), note: 'open, this one included' },
            {
                label: 'Synced models', value: count(s.counts.models), link: '/models',
                note: `in ${plural(s.counts.modelChannels, 'channel', 'channels')} of ${plural(s.counts.modelApps, 'app', 'apps')}`
            },
            {
                label: 'Recently deleted models', value: count(s.counts.deletedModels),
                note: `kept for ${text(set['MODEL_TOMBSTONE_SECONDS'])} s`, link: '/models'
            },
            { label: 'REST store', value: plural(s.counts.storeKeys, 'value', 'values'), note: `in ${plural(s.counts.storeApps, 'app', 'apps')}, ${bytes(s.counts.storeBytes)}` }
        ]
    };
};

const webFact = function (s: ServerSnapshot, webTlsAtProxy: boolean): Fact {
    const set = s.settings;
    const scheme = s.tls ? 'HTTPS and WSS' : webTlsAtProxy ? 'HTTP and WS, TLS terminated by proxy' : 'HTTP and WS';
    return {
        label: 'Web', variable: 'WEBSERVER_HOST, WEBSERVER_PORT', value: hostPort(set['WEBSERVER_HOST'], set['WEBSERVER_PORT']), mono: true,
        note: scheme, title: webTlsAtProxy ? WEB_TLS_AT_PROXY : undefined
    };
};

const tcpFact = function (s: ServerSnapshot, tcpTlsAtProxy: boolean, proxies: string[]): Fact {
    const set = s.settings;
    const tls = s.tls;
    // Unity clients through a trusted proxy without TCP_TLS_AT_PROXY: "unencrypted" alone would read
    // as "no TLS", which the server cannot know.
    const tcpUndeclared = tls === null && !tcpTlsAtProxy && set['TCP_PROXY_PROTOCOL'] === true && proxies.length > 0;
    const tcpNote = tls ? 'TLS'
        : tcpTlsAtProxy ? 'TLS terminated by proxy'
        : tcpUndeclared ? 'unencrypted, proxy TLS undeclared'
        : 'unencrypted';
    const tcpTitle = tcpTlsAtProxy ? TCP_TLS_AT_PROXY : tcpUndeclared ? TCP_TLS_UNDECLARED : undefined;
    return {
        label: 'TCP', variable: 'TCP_HOST, TCP_PORT', value: hostPort(set['TCP_HOST'], set['TCP_PORT']), mono: true,
        note: tcpNote, title: tcpTitle
    };
};

const tlsFact = function (s: ServerSnapshot, webTlsAtProxy: boolean, tcpTlsAtProxy: boolean): Fact {
    const terminatedBy = [
        ...(webTlsAtProxy ? [ { port: 'HTTPS', why: WEB_TLS_AT_PROXY } ] : []),
        ...(tcpTlsAtProxy ? [ { port: 'TCP', why: TCP_TLS_AT_PROXY } ] : [])
    ];
    return terminatedBy.length > 0
        ? {
            ...onOff('TLS', false, 'TLS_CERT, TLS_KEY', `terminated by proxy (${terminatedBy.map(end => end.port).join(', ')})`),
            title: terminatedBy.map(end => end.why).join('\n')
        }
        : onOff('TLS', s.tls !== null, 'TLS_CERT, TLS_KEY');
};

// Unset is "Not declared", not a bare Off, which would read as "the proxy's TCP port has no TLS".
// Set without TCP_PROXY_PROTOCOL, it has no effect, as the server warns at startup.
const tcpTerminationFact = function (s: ServerSnapshot): Fact {
    const termination = { label: 'TCP TLS termination', variable: 'TCP_TLS_AT_PROXY' };
    return s.settings['TCP_TLS_AT_PROXY'] !== true
        ? { ...termination, value: 'Not declared', tone: 'off' }
        : s.tlsAtProxy.tcp
            ? { ...termination, value: 'Proxy', tone: 'ok' }
            : { ...termination, value: 'Proxy', tone: 'warn', note: 'needs TCP_PROXY_PROTOCOL', title: TCP_TLS_NO_EFFECT };
};

const networkSection = function (s: ServerSnapshot): Section {
    const set = s.settings;
    const tls = s.tls;
    const proxies = Array.isArray(set['TRUSTED_PROXIES']) ? set['TRUSTED_PROXIES'] : [];
    const proxyAddresses = Array.isArray(set['PROXY_TLS_ADDRESSES']) ? set['PROXY_TLS_ADDRESSES'] : [];

    // TLS terminated by a reverse proxy in front of this server, which then sees only the proxy's
    // unencrypted connections. Web: by what trusted proxies reported in X-Forwarded-Proto for the web
    // clients and admin pages connected now, this page included (tlsAtProxy.web). TCP: the PROXY
    // protocol header does not say, so the operator declares it with TCP_TLS_AT_PROXY
    // (tlsAtProxy.tcp). With the server's own certificate, that is what a direct connection uses,
    // and the rows say so instead.
    const webTlsAtProxy = tls === null && s.tlsAtProxy.web;
    const tcpTlsAtProxy = tls === null && s.tlsAtProxy.tcp;
    return {
        id: 'network', title: 'Network', facts: [
            webFact(s, webTlsAtProxy),
            tcpFact(s, tcpTlsAtProxy, proxies),
            { label: 'Voice', variable: 'VOICE_HOST, VOICE_PORT', value: hostPort(set['VOICE_HOST'], set['VOICE_PORT']), mono: true, note: 'UDP' },
            { label: 'Base URL', variable: 'BASE_URL', value: text(set['BASE_URL']) || '/', mono: true },
            tlsFact(s, webTlsAtProxy, tcpTlsAtProxy),
            {
                label: 'Trusted proxies', variable: 'TRUSTED_PROXIES', value: proxies.length > 0 ? proxies.join(', ') : 'None',
                mono: proxies.length > 0, tone: proxies.length > 0 ? undefined : 'off'
            },
            onOff('PROXY protocol on TCP', set['TCP_PROXY_PROTOCOL'] === true, 'TCP_PROXY_PROTOCOL'),
            tcpTerminationFact(s),
            {
                label: 'Proxy TLS addresses', variable: 'PROXY_TLS_ADDRESSES', value: proxyAddresses.length > 0 ? proxyAddresses.join(', ') : 'None',
                mono: proxyAddresses.length > 0, tone: proxyAddresses.length > 0 ? undefined : 'off'
            }
        ]
    };
};

// The server's own certificate, and the proxy's: both when the proxy starts TLS of its own to
// the server, and clients only ever see the proxy's.
const certificateSection = function (s: ServerSnapshot, format: (time: number) => string): Section | undefined {
    const tls = s.tls;
    const proxyTls = s.proxyTls;
    if (tls) {
        return {
            id: 'certificate', title: proxyTls ? 'TLS certificate (this server)' : 'TLS certificate',
            facts: certificateFacts(tls, s.at, format)
        };
    }
    return undefined;
};

const proxyCheckingSection = function (s: ServerSnapshot): Section | undefined {
    const set = s.settings;
    const proxyTls = s.proxyTls;
    const proxyAddresses = Array.isArray(set['PROXY_TLS_ADDRESSES']) ? set['PROXY_TLS_ADDRESSES'] : [];
    if (proxyTls && proxyTls.length === 0) {
        return {
            id: 'proxy-certificate-0', title: 'Proxy TLS certificate', facts: [
                { label: 'Addresses', variable: 'PROXY_TLS_ADDRESSES', value: proxyAddresses.join(', '), mono: true },
                { label: 'Status', value: 'Checking', tone: 'off' }
            ]
        };
    }
    return undefined;
};

const proxyCertificateSections = function (s: ServerSnapshot, format: (time: number) => string): Section[] {
    const proxyTls = s.proxyTls;
    const sections: Section[] = [];
    for (const [ i, entry ] of (proxyTls ?? []).entries()) {
        const cert = entry.certificate;
        const facts: Fact[] = [ { label: 'Addresses', variable: 'PROXY_TLS_ADDRESSES', value: entry.addresses.join(', '), mono: true } ];
        if (cert) {
            // The check runs once an hour; a certificate that has expired since is refused already.
            const trustError = cert.validTo <= s.at ? 'expired' : cert.trusted ? null : cert.trustError ?? 'refused';
            facts.push(trustError === null
                ? { label: 'Trusted', value: 'Yes', tone: 'ok' }
                : { label: 'Trusted', value: 'No', tone: 'err', note: trustError, title: PROXY_UNTRUSTED });
            facts.push(...certificateFacts(cert, s.at, format));
        } else {
            facts.push({ label: 'Connection', value: 'Failed', tone: 'err', note: entry.error ?? undefined });
        }
        facts.push({ label: 'Checked', value: format(entry.checkedAt) });
        sections.push({ id: `proxy-certificate-${i}`, title: 'Proxy TLS certificate', facts });
    }
    return sections;
};

const limitsSection = function (s: ServerSnapshot): Section {
    const set = s.settings;
    const rate = number(set['CLIENT_MESSAGE_RATE_LIMIT']);
    return {
        id: 'limits', title: 'Load limits', facts: [
            limit('Messages per client', 'CLIENT_MESSAGE_RATE_LIMIT', set['CLIENT_MESSAGE_RATE_LIMIT'], n => `${count(n)} a second`),
            rate === 0
                ? { label: 'Burst', variable: 'CLIENT_MESSAGE_RATE_BURST', value: 'Off', tone: 'off' }
                : limit('Burst', 'CLIENT_MESSAGE_RATE_BURST', set['CLIENT_MESSAGE_RATE_BURST'], n => `${count(n)} messages`),
            limit('TCP inbound backlog', 'TCP_INBOUND_BACKLOG_LIMIT', set['TCP_INBOUND_BACKLOG_LIMIT'], n => `${count(n)} messages`),
            limit('TCP idle timeout', 'TCP_IDLE_TIMEOUT_SECONDS', set['TCP_IDLE_TIMEOUT_SECONDS'], n => `${count(n)} s`),
            limit('App client warning', 'APP_CLIENT_WARNING_THRESHOLD', set['APP_CLIENT_WARNING_THRESHOLD'], n => `above ${plural(n, 'client', 'clients')}`),
            limit('Deleted models kept', 'MODEL_TOMBSTONE_SECONDS', set['MODEL_TOMBSTONE_SECONDS'], n => `${count(n)} s`),
            limit('REST store values kept', 'STORE_EXPIRY_DAYS', set['STORE_EXPIRY_DAYS'], n => `${plural(n, 'day', 'days')} after their last write`),
            limit('REST store size', 'STORE_MAX_MB', set['STORE_MAX_MB'], n => `${count(n)} MiB`)
        ]
    };
};

const voiceSection = function (s: ServerSnapshot): Section {
    const set = s.settings;
    const voice = s.voice;
    return {
        id: 'voice', title: 'Voice', facts: [
            onOff('Voice server', voice?.listening === true, undefined, voice?.listening ? undefined : 'not listening'),
            onOff('Recording', voice ? voice.recording : set['VOICE_RECORDING'] === true, 'VOICE_RECORDING'),
            { label: 'Sampling rate', variable: 'VOICE_SAMPLING_RATE', value: `${count(voice?.samplingRate ?? number(set['VOICE_SAMPLING_RATE']) ?? 0)} Hz` },
            { label: 'Voice clients', value: count(voice?.clients ?? 0) }
        ]
    };
};

const otherSection = function (s: ServerSnapshot): Section | undefined {
    const set = s.settings;
    const other = Object.keys(set).filter(name => !SHOWN.has(name)).sort();
    if (other.length > 0) {
        return {
            id: 'other', title: 'Other settings',
            facts: other.map(name => ({ label: name, value: text(set[name]), mono: true }))
        };
    }
    return undefined;
};

export const serverSections = function (s: ServerSnapshot, format: (time: number) => string): Section[] {
    return [
        serverSection(s, format),
        countsSection(s),
        networkSection(s),
        certificateSection(s, format),
        proxyCheckingSection(s),
        ...proxyCertificateSections(s, format),
        limitsSection(s),
        voiceSection(s),
        otherSection(s)
    ].filter(section => section !== undefined);
};
