import type { BuildInfo } from '../../core/build-info.js';
import type { DataStore } from '../../models/data-store.js';
import type { NetworkClient } from '../../protocol/network.js';
import { PROTOCOL_VERSION } from '../../protocol/protocol.js';
import type { SocketIoClient } from '../../socket-io/socket-io-server.js';
import type { CertificateInfo } from '../../tls/tls-files.js';
import type { ProxyCertificateResult } from '../../tls/proxy-certificate.js';
import { ADMIN_APP } from '../admin-app.js';

// The settings in effect, by the names of the variables that set them. TLS_CERT and TLS_KEY are
// left out: `tls` says what they hold, never where they are or what is in them.
export type ServerSettings = Record<string, string | number | boolean | string[]>;

export interface VoiceStatus {
    listening: boolean;
    recording: boolean;
    samplingRate: number;
    clients: number;
}

export interface ServerSources {
    version: string;
    build: BuildInfo;
    // Date.now() of the start.
    startedAt: number;
    settings: ServerSettings;
    // The certificate served now, if TLS is on.
    tls: CertificateInfo | undefined;
    // The latest check of PROXY_TLS_ADDRESSES; undefined without them.
    proxyTls: ReadonlyArray<ProxyCertificateResult> | undefined;
    // Whether TCP_TLS_AT_PROXY applies: it is on, and so is TCP_PROXY_PROTOCOL.
    tcpTlsAtProxy: boolean;
    voice: VoiceStatus | undefined;
    store: DataStore;
    restStore: { apps: number; keys: number; bytes: number } | undefined;
    tcpClients: ReadonlyArray<NetworkClient>;
    webClients: ReadonlyArray<SocketIoClient>;
}

// A certificate's names (its subject alternative names, or its subject), issuer and validity.
export interface TlsSnapshot {
    names: string;
    issuer: string;
    selfSigned: boolean;
    validFrom: number;
    validTo: number;
    fingerprint256: string;
}

const tlsSnapshot = (info: CertificateInfo): TlsSnapshot => ({
    names: info.names,
    issuer: info.issuer,
    selfSigned: info.selfSigned,
    validFrom: info.validFrom.getTime(),
    validTo: info.validTo.getTime(),
    fingerprint256: info.fingerprint256,
});

export interface ServerSnapshot {
    at: number;
    version: string;
    // The commit it was built from, whether colibri-server had uncommitted changes then, and
    // Date.now() of the build; commit and time null if the build did not record them.
    build: BuildInfo;
    protocolVersion: string;
    node: string;
    startedAt: number;
    // Seconds.
    uptime: number;
    settings: ServerSettings;
    tls: TlsSnapshot | null;
    // The certificates the proxy presents at PROXY_TLS_ADDRESSES, one entry per certificate with the
    // addresses that presented it, and one per address that could not be checked. Empty until the
    // first check has finished; null without PROXY_TLS_ADDRESSES.
    proxyTls: Array<{
        addresses: string[];
        checkedAt: number;
        certificate: (TlsSnapshot & { trusted: boolean; trustError: string | null }) | null;
        error: string | null;
    }> | null;
    // TLS that ends at a trusted proxy, which this server only sees as the proxy's connections.
    // `web`: a web client or admin page connected now, the one asking included, reached the proxy
    // over TLS (see ClientRow.tlsAtProxy). `tcp`: TCP_TLS_AT_PROXY applies, so every Unity client
    // through the proxy counts as TLS at the proxy, connected now or not.
    tlsAtProxy: { web: boolean; tcp: boolean };
    voice: VoiceStatus | null;
    counts: {
        tcpClients: number;
        webClients: number;
        adminPages: number;
        // Apps with at least one client.
        apps: number;
        // The synchronized models the server holds, in how many apps and channels, and the ids
        // deleted within the tombstone time.
        models: number;
        modelApps: number;
        modelChannels: number;
        deletedModels: number;
        // The REST store's apps and values, and the bytes of JSON they take.
        storeApps: number;
        storeKeys: number;
        storeBytes: number;
    };
}

const proxyTlsSnapshot = function (results: ReadonlyArray<ProxyCertificateResult> | undefined): ServerSnapshot['proxyTls'] {
    if (!results) return null;
    return results.map(result => ({
        addresses: [ ...result.addresses ],
        checkedAt: result.checkedAt,
        certificate: result.certificate
            ? { ...tlsSnapshot(result.certificate), trusted: result.certificate.trusted, trustError: result.certificate.trustError ?? null }
            : null,
        error: result.error ?? null,
    }));
};

interface ModelCounts {
    models: number;
    modelApps: number;
    modelChannels: number;
    deletedModels: number;
}

const modelCounts = function (store: DataStore): ModelCounts {
    let models = 0;
    let modelChannels = 0;
    const modelApps = new Set<string>();
    for (const { app, models: entries } of store.channels()) {
        if (entries.size === 0) continue;
        models += entries.size;
        modelChannels += 1;
        modelApps.add(app);
    }
    let deletedModels = 0;
    for (const app of store.tombstoneApps()) {
        const tombstones = store.liveTombstones(app);
        while (!tombstones.next().done) deletedModels += 1;
    }
    return { models, modelApps: modelApps.size, modelChannels, deletedModels };
};

interface ClientCounts {
    webClients: number;
    adminPages: number;
    apps: number;
    // A web client or admin page connected now reached the proxy over TLS.
    webTlsAtProxy: boolean;
}

const clientCounts = function (sources: ServerSources): ClientCounts {
    const apps = new Set<string>(sources.tcpClients.map(client => client.app));
    let webClients = 0;
    let adminPages = 0;
    let webTlsAtProxy = false;
    for (const client of sources.webClients) {
        if (client.tlsAtProxy) webTlsAtProxy = true;
        if (client.app === ADMIN_APP) {
            adminPages += 1;
        } else {
            webClients += 1;
            apps.add(client.app);
        }
    }
    return { webClients, adminPages, apps: apps.size, webTlsAtProxy };
};

export const serverSnapshot = function (sources: ServerSources): ServerSnapshot {
    const now = Date.now();
    const models = modelCounts(sources.store);
    const clients = clientCounts(sources);

    const tls = sources.tls;
    return {
        at: now,
        version: sources.version,
        build: sources.build,
        protocolVersion: PROTOCOL_VERSION,
        node: process.version,
        startedAt: sources.startedAt,
        uptime: Math.max(0, Math.round((now - sources.startedAt) / 1000)),
        settings: sources.settings,
        tls: tls ? tlsSnapshot(tls) : null,
        proxyTls: proxyTlsSnapshot(sources.proxyTls),
        tlsAtProxy: { web: clients.webTlsAtProxy, tcp: sources.tcpTlsAtProxy },
        voice: sources.voice ?? null,
        counts: {
            tcpClients: sources.tcpClients.length,
            webClients: clients.webClients,
            adminPages: clients.adminPages,
            apps: clients.apps,
            models: models.models,
            modelApps: models.modelApps,
            modelChannels: models.modelChannels,
            deletedModels: models.deletedModels,
            storeApps: sources.restStore?.apps ?? 0,
            storeKeys: sources.restStore?.keys ?? 0,
            storeBytes: sources.restStore?.bytes ?? 0,
        },
    };
};
