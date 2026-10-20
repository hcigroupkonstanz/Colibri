import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { once } from 'events';
import { mkdtemp, rm } from 'fs/promises';
import * as net from 'net';
import { networkInterfaces, tmpdir } from 'os';
import * as path from 'path';
import * as tls from 'tls';
import { Subscription } from 'rxjs';
import { LogLevel, LogMessage, Service } from '../../src/server/modules/core/index.js';
import {
    ProxyCertificateCheck,
    ProxyTlsAddress,
    formatProxyTlsAddress,
    parseProxyTlsAddresses,
} from '../../src/server/modules/core/proxy-certificate.js';
import { TestCertificate, createTestCertificate } from '../tls-test-certificate.js';

const hasIPv6Loopback = Object.values(networkInterfaces()).some(addresses => addresses?.some(a => a.address === '::1'));

describe('parseProxyTlsAddresses', () => {
    it('reads host names and IP addresses, with port 443 unless one is given', () => {
        expect(parseProxyTlsAddresses(' colibri.example.org , colibri.example.org:9212,192.0.2.1:8443, [2001:db8::1], [::1]:9443 '))
            .toEqual([
                { host: 'colibri.example.org', port: 443 },
                { host: 'colibri.example.org', port: 9212 },
                { host: '192.0.2.1', port: 8443 },
                { host: '2001:db8::1', port: 443 },
                { host: '::1', port: 9443 },
            ]);
    });

    // SNI may not carry the trailing dot, and Go's TLS servers (Traefik, Caddy) refuse it.
    it('drops a host name\'s trailing dot', () => {
        expect(parseProxyTlsAddresses('colibri.example.org.:9212')).toEqual([ { host: 'colibri.example.org', port: 9212 } ]);
    });

    it('is empty when unset or blank', () => {
        expect(parseProxyTlsAddresses(undefined)).toEqual([]);
        expect(parseProxyTlsAddresses(' , ')).toEqual([]);
    });

    it.each([ 'https://colibri.example.org', 'colibri.example.org:0', 'colibri.example.org:65536', '2001:db8::1', '[colibri]:443',
        'colibri_example.org', 'host:port' ])('refuses "%s", naming it', (entry) => {
        expect(() => parseProxyTlsAddresses(`colibri.example.org, ${entry}`)).toThrow(`Invalid PROXY_TLS_ADDRESSES: "${entry}"`);
    });

    it('writes an address back as host:port, an IPv6 host in brackets', () => {
        expect(formatProxyTlsAddress({ host: 'colibri.example.org', port: 443 })).toBe('colibri.example.org:443');
        expect(formatProxyTlsAddress({ host: '2001:db8::1', port: 9212 })).toBe('[2001:db8::1]:9212');
    });
});

describe('ProxyCertificateCheck', () => {
    let dir: string;
    let ca: TestCertificate;
    let signed: TestCertificate;
    let selfSigned: TestCertificate;
    let logs: LogMessage[];
    let subscription: Subscription;
    const servers: net.Server[] = [];
    const checks: ProxyCertificateCheck[] = [];

    beforeAll(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'colibri-proxy-certificate-'));
        ca = createTestCertificate(dir, 'ca', { commonName: 'Colibri Test CA' });
        signed = createTestCertificate(dir, 'signed', { signedBy: ca });
        selfSigned = createTestCertificate(dir, 'self-signed', { serverOnly: true });
    });

    afterAll(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    beforeEach(() => {
        logs = [];
        subscription = Service.output$.subscribe(log => {
            if (log.origin === 'ProxyTLS') logs.push(log);
        });
    });

    afterEach(async () => {
        subscription.unsubscribe();
        for (const check of checks.splice(0)) check.stop();
        for (const server of servers.splice(0)) {
            const closed = once(server, 'close');
            server.close();
            await closed;
        }
    });

    // A TLS server on the loopback, as a proxy would be, presenting `certificate`.
    const serve = async (certificate: TestCertificate, host = '127.0.0.1'): Promise<number> => {
        const server = tls.createServer({ cert: certificate.cert, key: certificate.key }, socket => socket.end());
        server.on('tlsClientError', () => undefined);
        servers.push(server);
        server.listen(0, host);
        await once(server, 'listening');
        return (server.address() as net.AddressInfo).port;
    };

    const create = (addresses: ProxyTlsAddress[], options: ConstructorParameters<typeof ProxyCertificateCheck>[1] = {}) => {
        const check = new ProxyCertificateCheck(addresses, { ca: ca.cert, ...options });
        checks.push(check);
        return check;
    };

    const warnings = () => logs.filter(l => l.level === LogLevel.Warn).map(l => l.message);
    const infos = () => logs.filter(l => l.level === LogLevel.Info).map(l => l.message);

    it('reads the certificate a trusted proxy presents, by host name and by IP address', async () => {
        const port = await serve(signed);
        const check = create([ { host: 'localhost', port }, { host: '127.0.0.1', port } ]);

        await check.check();

        expect(check.results).toEqual([ {
            addresses: [ `localhost:${port}`, `127.0.0.1:${port}` ],
            checkedAt: expect.any(Number),
            certificate: expect.objectContaining({
                fingerprint256: signed.fingerprint256, issuer: 'CN=Colibri Test CA', selfSigned: false, trusted: true, trustError: undefined,
                names: 'DNS:localhost, IP Address:127.0.0.1',
                validFrom: new Date(signed.validFrom), validTo: new Date(signed.validTo),
            }),
        } ]);
        expect(infos()).toEqual([
            expect.stringMatching(new RegExp(`^Proxy TLS certificate at localhost:${port}: for DNS:localhost`)),
            expect.stringMatching(new RegExp(`^Proxy TLS certificate at 127\\.0\\.0\\.1:${port}: for DNS:localhost`)),
        ]);
        expect(warnings()).toEqual([]);
    });

    it('reports a certificate clients would refuse, and why', async () => {
        const port = await serve(selfSigned);
        const check = create([ { host: 'localhost', port } ]);

        await check.check();

        expect(check.results[0]!.certificate).toMatchObject({ fingerprint256: selfSigned.fingerprint256, selfSigned: true, trusted: false,
            trustError: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
        expect(warnings()).toEqual([ expect.stringContaining('Clients that check certificates refuse it: DEPTH_ZERO_SELF_SIGNED_CERT.') ]);
    });

    // The test certificates are for localhost and 127.0.0.1 only.
    it.skipIf(!hasIPv6Loopback)('reports a certificate that is not for the address\'s host', async () => {
        const port = await serve(signed, '::1');
        const check = create([ { host: '::1', port } ]);

        await check.check();

        expect(check.results[0]).toMatchObject({ addresses: [ `[::1]:${port}` ],
            certificate: { trusted: false, trustError: 'ERR_TLS_CERT_ALTNAME_INVALID' } });
    });

    it('reports an address it cannot reach, once until that changes', async () => {
        const closed = net.createServer();
        closed.listen(0, '127.0.0.1');
        await once(closed, 'listening');
        const port = (closed.address() as net.AddressInfo).port;
        closed.close();
        await once(closed, 'close');
        const check = create([ { host: '127.0.0.1', port } ]);

        await check.check();
        await check.check();

        expect(check.results).toEqual([ { addresses: [ `127.0.0.1:${port}` ], checkedAt: expect.any(Number), error: expect.stringContaining('ECONNREFUSED') } ]);
        expect(warnings()).toEqual([ expect.stringMatching(new RegExp(`^Could not check the proxy's TLS certificate at 127\\.0\\.0\\.1:${port} \\(PROXY_TLS_ADDRESSES\\): .*ECONNREFUSED`)) ]);
    });

    // A name with an IPv4 and an IPv6 address is tried on both, and Node reports their failures in
    // an AggregateError whose own message is empty.
    it('says why it could not reach a host name with several addresses', async () => {
        const closed = net.createServer();
        closed.listen(0, '127.0.0.1');
        await once(closed, 'listening');
        const port = (closed.address() as net.AddressInfo).port;
        closed.close();
        await once(closed, 'close');
        const check = create([ { host: 'localhost', port } ]);

        await check.check();

        expect(check.results[0]!.error).toMatch(/ECONNREFUSED/);
        expect(warnings()[0]).toMatch(/\(PROXY_TLS_ADDRESSES\): .*ECONNREFUSED/);
    });

    // Say the proxy served its certificate without the intermediate one, and then with it: the
    // same certificate, trusted from then on.
    it('says when a certificate it reported as refused is trusted', () => {
        const check = create([]);
        const report = (check as unknown as { report(name: string, probe: object): void }).report.bind(check);
        const certificate = { fingerprint256: 'AB:CD', names: 'DNS:colibri.example.org', issuer: 'CN=R11', selfSigned: false,
            validFrom: new Date(signed.validFrom), validTo: new Date(signed.validTo) };

        report('colibri.example.org:443', { certificate: { ...certificate, trusted: false, trustError: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } });
        report('colibri.example.org:443', { certificate: { ...certificate, trusted: false, trustError: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } });
        report('colibri.example.org:443', { certificate: { ...certificate, trusted: true } });

        expect(warnings()).toEqual([ expect.stringContaining('refuse it: UNABLE_TO_VERIFY_LEAF_SIGNATURE.') ]);
        expect(infos()).toEqual([
            'The proxy\'s TLS certificate at colibri.example.org:443 is trusted now (was refused: UNABLE_TO_VERIFY_LEAF_SIGNATURE).',
        ]);
    });

    it('gives up on an address that accepts the connection but never answers', async () => {
        const accepted: net.Socket[] = [];
        const silent = net.createServer(socket => accepted.push(socket));
        servers.push(silent);
        silent.listen(0, '127.0.0.1');
        await once(silent, 'listening');
        const port = (silent.address() as net.AddressInfo).port;
        const check = create([ { host: '127.0.0.1', port } ], { connectTimeoutMillis: 200 });

        await check.check();

        expect(check.results[0]!.error).toBe('no TLS handshake within 0.2 s');
        for (const socket of accepted) socket.destroy();
    });

    it('lists the addresses that present one certificate together, and others apart', async () => {
        const first = await serve(signed);
        const second = await serve(signed);
        const other = await serve(selfSigned);
        const check = create([ { host: 'localhost', port: first }, { host: 'localhost', port: other }, { host: 'localhost', port: second } ]);

        await check.check();

        expect(check.results.map(result => [ result.addresses, result.certificate?.fingerprint256 ])).toEqual([
            [ [ `localhost:${first}`, `localhost:${second}` ], signed.fingerprint256 ],
            [ [ `localhost:${other}` ], selfSigned.fingerprint256 ],
        ]);
    });

    it('warns once when the certificate is about to expire, and again when it has', async () => {
        const port = await serve(signed);
        let now = signed.validTo - 60 * 60 * 1000;
        const check = create([ { host: 'localhost', port } ], { now: () => now });

        await check.check();
        await check.check();
        now = signed.validTo + 1;
        await check.check();

        expect(warnings()).toEqual([
            expect.stringContaining(`The proxy's TLS certificate at localhost:${port} expires on ${new Date(signed.validTo).toISOString()}`),
            expect.stringContaining(`The proxy's TLS certificate at localhost:${port} expired on ${new Date(signed.validTo).toISOString()}`),
        ]);
    });

    it('checks at start and then every checkMillis, until stopped', async () => {
        const port = await serve(signed);
        const check = create([ { host: 'localhost', port } ], { checkMillis: 50 });

        check.start();
        await new Promise(resolve => setTimeout(resolve, 200));
        check.stop();
        // A check under way when it was stopped still finishes.
        await new Promise(resolve => setTimeout(resolve, 150));
        const checkedAt = check.results[0]!.checkedAt;
        await new Promise(resolve => setTimeout(resolve, 150));

        expect(check.results[0]!.checkedAt).toBe(checkedAt);
        expect(infos()).toHaveLength(1);
    });
});
