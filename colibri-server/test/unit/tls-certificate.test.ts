import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { copyFile, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { Subscription, firstValueFrom } from 'rxjs';
import { LogLevel, LogMessage, Service } from '../../src/server/modules/core/index.js';
import { TlsCertificate } from '../../src/server/modules/core/tls-certificate.js';
import { TlsCredentials } from '../../src/server/modules/core/tls-files.js';
import { TestCertificate, createTestCertificate } from '../tls-test-certificate.js';

const HOUR = 60 * 60 * 1000;

describe('TlsCertificate', () => {
    let fixtures: string;
    let first: TestCertificate;
    let second: TestCertificate;
    // first and second have EC keys.
    let rsa: TestCertificate;

    // The files the server is pointed at; each test starts with `first` in them.
    let dir: string;
    let certPath: string;
    let keyPath: string;

    let logs: LogMessage[];
    let logSubscription: Subscription;
    let certificate: TlsCertificate | undefined;

    const logged = (level: LogLevel): string[] =>
        logs.filter(l => l.origin === 'TLS' && l.level === level).map(l => l.message);

    const install = async (cert: TestCertificate | Buffer, key: TestCertificate | Buffer): Promise<void> => {
        await writeFile(certPath, Buffer.isBuffer(cert) ? cert : cert.cert);
        await writeFile(keyPath, Buffer.isBuffer(key) ? key : key.key);
    };

    beforeAll(async () => {
        fixtures = await mkdtemp(path.join(tmpdir(), 'colibri-tls-certificate-'));
        first = createTestCertificate(fixtures, 'first');
        second = createTestCertificate(fixtures, 'second', { commonName: 'second.localhost' });
        rsa = createTestCertificate(fixtures, 'rsa', { keyType: 'rsa' });
    });

    afterAll(async () => {
        await rm(fixtures, { recursive: true, force: true });
    });

    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'colibri-tls-files-'));
        certPath = path.join(dir, 'fullchain.pem');
        keyPath = path.join(dir, 'privkey.pem');
        await copyFile(first.certPath, certPath);
        await copyFile(first.keyPath, keyPath);

        logs = [];
        logSubscription = Service.output$.subscribe(log => logs.push(log));
    });

    afterEach(async () => {
        certificate?.stop();
        certificate = undefined;
        logSubscription.unsubscribe();
        await rm(dir, { recursive: true, force: true });
    });

    const open = (options: ConstructorParameters<typeof TlsCertificate>[2] = {}): TlsCertificate => {
        certificate = new TlsCertificate(certPath, keyPath, options);
        return certificate;
    };

    describe('at startup', () => {
        it('logs the certificate\'s SHA-256 fingerprint as openssl computes it, and where it is from', () => {
            open().start();

            const [line] = logged(LogLevel.Info);
            expect(line).toContain(`SHA-256 fingerprint ${first.fingerprint256}`);
            expect(first.fingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
            expect(line).toContain(certPath);
            expect(line).toContain(keyPath);
            expect(line).toContain('DNS:localhost, IP Address:127.0.0.1');
        });

        it('says how a Unity app and a browser come to accept a self-signed certificate', () => {
            open().start();

            const [line] = logged(LogLevel.Info);
            expect(line).toContain('self-signed');
            expect(line).toContain('Allow self-signed certificate');
            expect(line).toContain('Server certificate SHA-256');
        });

        it('calls a self-signed certificate self-signed even when it may not sign others', async () => {
            const serverOnly = createTestCertificate(dir, 'server-only', { serverOnly: true });
            await install(serverOnly, serverOnly);

            open().start();

            const [line] = logged(LogLevel.Info);
            expect(line).toContain('self-signed');
            expect(line).toContain('Allow self-signed certificate');
            expect(line).not.toContain('issued by');
        });

        it('names the authority that signed a certificate, and gives no advice for a self-signed one', async () => {
            const authority = createTestCertificate(dir, 'authority', { commonName: 'Colibri Test CA' });
            const signed = createTestCertificate(dir, 'signed', { signedBy: authority });
            await install(Buffer.concat([ signed.cert, authority.cert ]), signed);

            open().start();

            const [line] = logged(LogLevel.Info);
            expect(line).toContain('issued by CN=Colibri Test CA');
            expect(line).toContain(`SHA-256 fingerprint ${signed.fingerprint256}`);
            expect(line).not.toContain('self-signed');
        });

        it('warns about a certificate that has expired', () => {
            open({ now: () => first.validTo + HOUR }).start();

            expect(logged(LogLevel.Warn)).toEqual([ expect.stringContaining(`expired on ${new Date(first.validTo).toISOString()}`) ]);
        });

        it('warns about a certificate that expires soon', () => {
            open({ now: () => first.validTo - HOUR }).start();

            expect(logged(LogLevel.Warn)).toEqual([ expect.stringContaining(`expires on ${new Date(first.validTo).toISOString()}`) ]);
        });

        it('warns about a certificate that is not valid yet', () => {
            open({ now: () => first.validFrom - HOUR }).start();

            expect(logged(LogLevel.Warn)).toEqual([ expect.stringContaining('is not valid before') ]);
        });

        it('does not warn about a certificate well within its validity', () => {
            open({ now: () => first.validFrom + HOUR }).start();

            expect(logged(LogLevel.Warn)).toEqual([]);
        });
    });

    describe('a renewed certificate', () => {
        it('is taken up once two reads in a row have found it, and handed on', async () => {
            const tls = open();
            const changes: TlsCredentials[] = [];
            tls.changes$.subscribe(c => changes.push(c));
            await install(second, second);

            await tls.check();
            expect(changes).toEqual([]);
            expect(tls.credentials.cert.equals(first.cert)).toBe(true);

            await tls.check();
            expect(changes).toHaveLength(1);
            expect(changes[0]!.cert.equals(second.cert)).toBe(true);
            expect(changes[0]!.key.equals(second.key)).toBe(true);
            expect(tls.credentials).toBe(changes[0]);
            expect(tls.info.fingerprint256).toBe(second.fingerprint256);

            const [reloaded] = logged(LogLevel.Info).filter(l => l.startsWith('Reloaded'));
            expect(reloaded).toContain(`SHA-256 fingerprint ${second.fingerprint256}`);
            expect(reloaded).toContain(`(was ${first.fingerprint256})`);
        });

        it('is not handed on twice', async () => {
            const tls = open();
            const changes: TlsCredentials[] = [];
            tls.changes$.subscribe(c => changes.push(c));
            await install(second, second);

            for (let i = 0; i < 5; i++) await tls.check();

            expect(changes).toHaveLength(1);
        });

        it('is not taken up while it keeps changing', async () => {
            const tls = open();
            const changes: TlsCredentials[] = [];
            tls.changes$.subscribe(c => changes.push(c));

            // Half of it written, then the rest.
            await install(second.cert.subarray(0, 100), first);
            await tls.check();
            await install(second, first);
            await tls.check();

            expect(changes).toEqual([]);
            expect(logged(LogLevel.Warn)).toEqual([]);
        });

        // Between the certificate and its key being written, the two do not belong together.
        it('is taken up once its key has followed, with at most one warning if that took a while', async () => {
            const tls = open();
            const changes: TlsCredentials[] = [];
            tls.changes$.subscribe(c => changes.push(c));

            await install(second, first);
            for (let i = 0; i < 4; i++) await tls.check();
            expect(changes).toEqual([]);
            expect(logged(LogLevel.Warn)).toEqual([ expect.stringContaining('is not the private key of the certificate') ]);
            expect(logged(LogLevel.Warn)[0]).toContain(`Still serving the certificate with SHA-256 fingerprint ${first.fingerprint256}`);

            await install(second, second);
            await tls.check();
            await tls.check();
            expect(changes).toHaveLength(1);
            expect(tls.info.fingerprint256).toBe(second.fingerprint256);
        });

        // OpenSSL itself takes a certificate with a key of another type without a word, and then fails
        // every handshake.
        it('is not taken up while the key is still the old one of another type, and is once it has followed', async () => {
            const tls = open();
            const changes: TlsCredentials[] = [];
            tls.changes$.subscribe(c => changes.push(c));

            await install(rsa, first);
            for (let i = 0; i < 4; i++) await tls.check();
            expect(changes).toEqual([]);
            expect(tls.info.fingerprint256).toBe(first.fingerprint256);
            expect(tls.credentials.cert.equals(first.cert)).toBe(true);
            expect(logged(LogLevel.Warn)).toEqual([ expect.stringContaining('is not the private key of the certificate') ]);
            expect(logged(LogLevel.Info).filter(l => l.startsWith('Reloaded'))).toEqual([]);

            await install(rsa, rsa);
            await tls.check();
            await tls.check();
            expect(changes).toHaveLength(1);
            expect(tls.info.fingerprint256).toBe(rsa.fingerprint256);
        });

        it('warns once while the files cannot be read, keeps the certificate it has, and says when they can again', async () => {
            const tls = open();
            await rm(keyPath);

            for (let i = 0; i < 3; i++) await tls.check();
            expect(logged(LogLevel.Warn)).toEqual([ expect.stringContaining(`Cannot read TLS_KEY (${keyPath})`) ]);
            expect(tls.credentials.key.equals(first.key)).toBe(true);

            await install(first, first);
            await tls.check();
            expect(logged(LogLevel.Info)).toEqual([ expect.stringContaining('can be read again') ]);
        });

        it('is looked for every few seconds once started', async () => {
            const tls = open({ checkMillis: 20 });
            tls.start();
            const changed = firstValueFrom(tls.changes$);

            await install(second, second);

            expect((await changed).cert.equals(second.cert)).toBe(true);
        });

        it('is not looked for any more once stopped', async () => {
            const tls = open({ checkMillis: 20 });
            tls.start();
            tls.stop();
            const changes: TlsCredentials[] = [];
            tls.changes$.subscribe(c => changes.push(c));

            await install(second, second);
            await new Promise(resolve => setTimeout(resolve, 200));

            expect(changes).toEqual([]);
        });
    });
});
