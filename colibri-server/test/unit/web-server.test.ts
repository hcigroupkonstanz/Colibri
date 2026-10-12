import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { once } from 'events';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import * as http from 'http';
import * as https from 'https';
import { AddressInfo } from 'net';
import { networkInterfaces, tmpdir } from 'os';
import * as path from 'path';
import * as tls from 'tls';
import { Subject, Subscription, filter, firstValueFrom } from 'rxjs';
import { io as connectClient, Socket as ClientSocket } from 'socket.io-client';
import { gzipSync } from 'zlib';
import { ConsoleLog, LogLevel, LogMessage, Service, TlsCredentials } from '../../src/server/modules/core/index.js';
import { WebServer } from '../../src/server/modules/web/web-server.js';
import { RestAPI } from '../../src/server/modules/web/rest-api.js';
import { SocketIOServer } from '../../src/server/modules/networking/socket-io-server.js';
import { MAX_FRAME_LENGTH, PROTOCOL_VERSION } from '../../src/server/modules/networking/protocol.js';
import { TrustProxy, compileTrustedProxies } from '../../src/server/modules/networking/trusted-proxies.js';
import { TestCertificate, createTestCertificate } from '../tls-test-certificate.js';

// Unlike rest-api.test.ts, which drives the router directly, these go through the real
// express app over HTTP - body parser, middleware order and error handling included.
describe('WebServer over HTTP', () => {
    let dataPath: string;
    let webRoot: string;
    let webServer: WebServer;
    let restApi: RestAPI;
    let httpServer: http.Server;
    let baseUrl: string;
    let logs: LogMessage[];
    let logSubscription: Subscription;

    beforeEach(async () => {
        logs = [];
        logSubscription = Service.output$.subscribe(log => logs.push(log));

        dataPath = await mkdtemp(path.join(tmpdir(), 'colibri-web-server-data-'));
        webRoot = await mkdtemp(path.join(tmpdir(), 'colibri-web-server-root-'));
        await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>Colibri</title>', 'utf8');

        webServer = new WebServer('127.0.0.1', 0, webRoot, '');
        restApi = new RestAPI(dataPath, webServer);
        await restApi.init();
        // A route with a bug in it, for the error handling tests.
        webServer.addApi('/fails', () => {
            throw new Error(`secret detail in ${webRoot}`);
        });

        httpServer = webServer.start();
        await once(httpServer, 'listening');
        baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
        logSubscription.unsubscribe();
        const closed = once(httpServer, 'close');
        webServer.stop();
        httpServer.closeAllConnections();
        await closed;
        // A pending debounced save would otherwise recreate dataPath after it is removed.
        await restApi.flush();
        await rm(dataPath, { recursive: true, force: true });
        await rm(webRoot, { recursive: true, force: true });
    });

    const storeUrl = (app: string, name: string) => `${baseUrl}/api/store/${app}/${name}`;

    // Store.cs: UnityWebRequest.Put(url, JsonConvert.SerializeObject(value)) with
    // Content-Type and Accept set to application/json; Get hands the response text to
    // JsonConvert.DeserializeObject<T>. For these values Json.NET writes the same text as
    // JSON.stringify.
    const unityPut = (name: string, json: string) => fetch(storeUrl('UnityApp', name), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: json,
    });
    const unityGet = async (name: string) => {
        const response = await fetch(storeUrl('UnityApp', name), { headers: { 'Accept': 'application/json' } });
        return { status: response.status, text: await response.text() };
    };

    // Colibri.ts: setRestObject PUTs JSON.stringify(data) as application/json, and
    // getRestObject returns response.json().
    const webPut = (key: string, data: unknown) => fetch(storeUrl('WebApp', key), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    const webGet = async (key: string) => {
        const response = await fetch(storeUrl('WebApp', key), { method: 'GET', headers: { 'Content-Type': 'application/json' } });
        return { status: response.status, value: response.status >= 400 ? null : await response.json() as unknown };
    };

    const VALUES: [string, unknown][] = [
        [ 'an integer', 42 ],
        [ 'zero', 0 ],
        [ 'a float', 1.5 ],
        [ 'a string', 'text' ],
        [ 'an empty string', '' ],
        [ 'true', true ],
        [ 'false', false ],
        [ 'null', null ],
        [ 'an array', [ 1, 'two', { three: 3 } ] ],
        [ 'an object', { Id: 1234, Name: 'Charly Sharp', nested: { list: [ 1, 2 ] } } ],
    ];

    describe('stores any JSON value', () => {
        it.each(VALUES)('round-trips %s as Unity sends it', async (_, value) => {
            const json = JSON.stringify(value);

            const put = await unityPut('value', json);
            expect(put.status).toBe(201);
            expect(await put.json()).toMatchObject({ data: value });

            // Byte for byte the JSON text Unity sent, which is what JsonConvert parses.
            await expect(unityGet('value')).resolves.toEqual({ status: 200, text: json });
        });

        it.each(VALUES)('round-trips %s as the web client sends it', async (_, value) => {
            expect((await webPut('value', value)).status).toBe(201);
            await expect(webGet('value')).resolves.toEqual({ status: 200, value });

            // Overwriting an existing value, even a falsy one, is an update.
            expect((await webPut('value', value)).status).toBe(200);
            await expect(webGet('value')).resolves.toEqual({ status: 200, value });
        });
    });

    // express.json() only parses a body sent as application/json, and leaves req.body
    // undefined otherwise. That undefined used to be stored: the name was listed under its
    // app, while GET and DELETE of it answered 404. Both clients send JSON (see above).
    describe('a PUT without a JSON body', () => {
        const putRaw = (name: string, init: { headers?: Record<string, string>; body?: string }) =>
            fetch(storeUrl('RawApp', name), { method: 'PUT', ...init });

        const expectRefused = async (response: Response) => {
            expect(response.status).toBe(400);
            expect(response.headers.get('content-type')).toMatch(/^application\/json/);
            expect(await response.json()).toEqual({ error: expect.stringMatching(/JSON body.*Content-Type: application\/json/) });
        };

        it.each([
            [ 'no body and no Content-Type', {} ],
            [ 'a text/plain body', { headers: { 'Content-Type': 'text/plain' }, body: '"text"' } ],
            [ 'a body without a Content-Type of its own', { body: '42' } ],
            [ 'an empty application/json body', { headers: { 'Content-Type': 'application/json' }, body: '' } ],
        ])('answers 400 for %s, and stores nothing', async (_, init) => {
            await expectRefused(await putRaw('value', init));

            expect((await fetch(`${baseUrl}/api/store/RawApp`)).status).toBe(404);
            expect((await fetch(storeUrl('RawApp', 'value'))).status).toBe(404);
            expect(logs.filter(l => l.origin === 'RestAPI' && l.level === LogLevel.Warn)).toHaveLength(1);
        });

        it('leaves a value that is already stored as it was', async () => {
            expect((await unityPut('value', '42')).status).toBe(201);

            await expectRefused(await putRaw('value', { headers: { 'Content-Type': 'text/plain' }, body: '43' }));

            await expect(unityGet('value')).resolves.toEqual({ status: 200, text: '42' });
        });

        // body-parser makes {} of an empty application/json body. The check for that looked
        // at Content-Length: 0, which a chunked request does not have, so an empty chunked
        // body was stored as {} and answered 201.
        describe('framed without a Content-Length', () => {
            // A PUT with exactly these headers and body chunks, over a plain http.request so
            // the framing is what the test says (fetch picks its own).
            const putFramed = (name: string, headers: Record<string, string>, chunks: (string | Buffer)[]) =>
                new Promise<{ status: number; body: unknown; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
                    const request = http.request(storeUrl('RawApp', name), { method: 'PUT', headers }, (response) => {
                        let text = '';
                        response.setEncoding('utf8');
                        response.on('data', chunk => text += chunk);
                        response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(text) as unknown, headers: response.headers }));
                    });
                    request.on('error', reject);
                    for (const chunk of chunks) request.write(chunk);
                    request.end();
                });
            const chunked = { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' };

            it('answers 400 for an empty chunked application/json body, and stores nothing', async () => {
                const response = await putFramed('value', chunked, []);

                expect(response.status).toBe(400);
                expect(response.headers['content-type']).toMatch(/^application\/json/);
                expect(response.body).toEqual({ error: expect.stringMatching(/JSON body.*Content-Type: application\/json/) });
                expect((await fetch(`${baseUrl}/api/store/RawApp`)).status).toBe(404);
                expect(logs.filter(l => l.origin === 'RestAPI' && l.level === LogLevel.Warn)).toHaveLength(1);
            });

            it('answers 400 for a gzip body that inflates to nothing', async () => {
                const response = await putFramed('value', { ...chunked, 'Content-Encoding': 'gzip' }, [ gzipSync(Buffer.alloc(0)) ]);

                expect(response.status).toBe(400);
                expect((await fetch(`${baseUrl}/api/store/RawApp`)).status).toBe(404);
            });

            it('leaves a value that is already stored as it was', async () => {
                expect((await putFramed('value', chunked, [ '42' ])).status).toBe(201);

                expect((await putFramed('value', chunked, [])).status).toBe(400);

                await expect(fetch(storeUrl('RawApp', 'value')).then(r => r.text())).resolves.toBe('42');
            });

            // An empty object is a value like any other, and has to stay storable.
            it.each([
                [ 'chunked', [ '{', '}' ] ],
                [ 'with a Content-Length', [ '{}' ] ],
            ])('stores an explicit {} sent %s', async (framing, chunks) => {
                const headers = framing === 'chunked' ? chunked : { 'Content-Type': 'application/json', 'Content-Length': '2' };

                const response = await putFramed('empty', headers, chunks);

                expect(response.status).toBe(201);
                expect(response.body).toMatchObject({ data: {} });
                const stored = await fetch(storeUrl('RawApp', 'empty'));
                expect(stored.status).toBe(200);
                expect(await stored.text()).toBe('{}');
            });
        });

        // What setRestObject(key, undefined) sends: JSON.stringify(undefined) is no body at all.
        it('answers 400 to the web client for an undefined value, so setRestObject returns false', async () => {
            const response = await fetch(storeUrl('WebApp', 'value'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(undefined),
            });

            expect(response.status).toBe(400);
            expect((await webGet('value')).status).toBe(404);
        });
    });

    describe('body size', () => {
        // A JSON string literal whose encoded body is exactly `length` bytes.
        const jsonStringOfLength = (length: number) => JSON.stringify('x'.repeat(length - 2));

        it('accepts a body of exactly the TCP frame limit (5 MiB), and returns it unchanged', async () => {
            const json = jsonStringOfLength(MAX_FRAME_LENGTH);
            expect(Buffer.byteLength(json)).toBe(5 * 1024 * 1024);

            expect((await unityPut('large', json)).status).toBe(201);
            const got = await unityGet('large');
            expect(got.status).toBe(200);
            expect(got.text).toBe(json);
        });

        it('refuses a body over the limit with 413, and keeps serving', async () => {
            const response = await unityPut('huge', jsonStringOfLength(MAX_FRAME_LENGTH + 1));
            expect(response.status).toBe(413);

            await expect(unityGet('huge')).resolves.toMatchObject({ status: 404 });
            expect((await unityPut('small', '1')).status).toBe(201);
        });
    });

    // Express's default error handler wrote the stack trace, with absolute paths into the
    // install, into the response whenever NODE_ENV wasn't "production" - as it isn't for a
    // server started from a checkout, and wasn't in the Docker image either until it set it.
    describe('error responses', () => {
        const expectNoInternals = (text: string) => {
            expect(text).not.toMatch(/\n\s+at /);
            expect(text).not.toContain(webRoot);
            expect(text).not.toContain(process.cwd());
            expect(text).not.toContain('node_modules');
        };

        const read = async (response: Response) => {
            const text = await response.text();
            expect(response.headers.get('content-type')).toMatch(/^application\/json/);
            return { status: response.status, text, body: JSON.parse(text) as unknown };
        };

        it('answers an error thrown by a route with a generic JSON 500, and logs it', async () => {
            const { status, text, body } = await read(await fetch(`${baseUrl}/api/fails`));

            expect(status).toBe(500);
            expect(body).toEqual({ error: 'Internal server error' });
            expect(text).not.toContain('secret detail');
            expectNoInternals(text);

            const logged = logs.filter(l => l.origin === 'WebServer' && l.level === LogLevel.Error);
            expect(logged).toHaveLength(1);
            expect(logged[0]!.message).toContain('GET /api/fails');
            expect(logged[0]!.message).toContain('secret detail');
        });

        it('keeps the status of a client error, with only the message meant for the client', async () => {
            const malformed = await read(await fetch(storeUrl('UnityApp', 'x'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: '{not json',
            }));
            expect(malformed.status).toBe(400);
            expect(malformed.body).toEqual({ error: expect.stringMatching(/JSON/) });
            expectNoInternals(malformed.text);

            const tooLarge = await read(await fetch(storeUrl('UnityApp', 'x'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify('x'.repeat(MAX_FRAME_LENGTH)),
            }));
            expect(tooLarge.status).toBe(413);
            expect(tooLarge.body).toEqual({ error: 'request entity too large' });

            const undecodable = await read(await fetch(`${baseUrl}/api/store/%E0%A4%A/x`));
            expect(undecodable.status).toBe(400);
            expectNoInternals(undecodable.text);

            expect(logs.filter(l => l.origin === 'WebServer' && l.level === LogLevel.Warn)).toHaveLength(3);
        });

        // A browser only lets a web client read a cross-origin response that carries
        // Access-Control-Allow-Origin. Without it, setRestObject's fetch rejects with a bare
        // network error instead of resolving to false on the 413.
        it('carries the CORS headers, even for a body the parser refuses', async () => {
            const origin = 'http://dev-laptop.local:5173';

            const tooLarge = await fetch(storeUrl('WebApp', 'x'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Origin': origin },
                body: JSON.stringify('x'.repeat(MAX_FRAME_LENGTH)),
            });
            expect(tooLarge.status).toBe(413);
            expect(tooLarge.headers.get('access-control-allow-origin')).toBe('*');

            const malformed = await fetch(storeUrl('WebApp', 'x'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Origin': origin },
                body: '{not json',
            });
            expect(malformed.status).toBe(400);
            expect(malformed.headers.get('access-control-allow-origin')).toBe('*');

            const failed = await fetch(`${baseUrl}/api/fails`, { headers: { 'Origin': origin } });
            expect(failed.status).toBe(500);
            expect(failed.headers.get('access-control-allow-origin')).toBe('*');
        });

        it('does not name the path on disk when the admin UI files are missing', async () => {
            await rm(path.join(webRoot, 'index.html'));

            const { status, text, body } = await read(await fetch(`${baseUrl}/log`));

            expect(status).toBe(404);
            expect(body).toEqual({ error: 'Not Found' });
            expectNoInternals(text);
        });
    });

    // The admin UI's SPA fallback answered every path nothing else did, /api/... included, with
    // 200 and index.html: a REST store write sent with the wrong method or path stored nothing,
    // and the script that sent it saw success.
    describe('a request no API route answers', () => {
        const expectNoRoute = async (response: Response, method: string, url: string) => {
            expect(response.status).toBe(404);
            expect(response.headers.get('content-type')).toMatch(/^application\/json/);
            expect(await response.json()).toEqual({ error: `No API route for ${method} ${url}` });
        };

        it('answers a store write with the wrong method 404, and stores nothing', async () => {
            const post = await fetch(storeUrl('app1', 'v1'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '42',
            });

            await expectNoRoute(post, 'POST', '/api/store/app1/v1');
            expect((await fetch(storeUrl('app1', 'v1'))).status).toBe(404);
            expect((await fetch(`${baseUrl}/api/store/app1`)).status).toBe(404);
        });

        it('answers a store write without a value name 404', async () => {
            const put = await fetch(`${baseUrl}/api/store/app1`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: '42',
            });

            await expectNoRoute(put, 'PUT', '/api/store/app1');
        });

        it.each([ '/api', '/api/', '/api/nope', '/api/stores/app1/v1?x=1' ])('answers GET %s 404', async (url) => {
            await expectNoRoute(await fetch(`${baseUrl}${url}`), 'GET', url);
        });

        it('carries the CORS headers, and logs a warning', async () => {
            const response = await fetch(`${baseUrl}/api/nope`, { headers: { 'Origin': 'http://dev-laptop.local:5173' } });

            expect(response.status).toBe(404);
            expect(response.headers.get('access-control-allow-origin')).toBe('*');
            const warnings = logs.filter(l => l.origin === 'WebServer' && l.level === LogLevel.Warn);
            expect(warnings).toHaveLength(1);
            expect(warnings[0]!.message).toContain('GET /api/nope answered 404');
        });

        it('still serves the admin UI for every other path', async () => {
            for (const url of [ '/', '/log', '/statistics', '/apiary', '/log/api/x' ]) {
                const response = await fetch(`${baseUrl}${url}`);
                expect(response.status, url).toBe(200);
                expect(await response.text(), url).toContain('<title>Colibri</title>');
            }
        });
    });
});

// The API is at /api whatever BASE_URL is; only the admin UI moves.
describe('WebServer with a BASE_URL', () => {
    it('answers an unknown /api path 404 in JSON, and serves the admin UI under BASE_URL', async () => {
        const webRoot = await mkdtemp(path.join(tmpdir(), 'colibri-web-server-base-url-'));
        await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>Colibri</title>', 'utf8');
        const webServer = new WebServer('127.0.0.1', 0, webRoot, '/colibri');
        const httpServer = webServer.start();
        try {
            await once(httpServer, 'listening');
            const url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

            const api = await fetch(`${url}/api/nope`);
            expect(api.status).toBe(404);
            expect(await api.json()).toEqual({ error: 'No API route for GET /api/nope' });

            const page = await fetch(`${url}/colibri/log`);
            expect(page.status).toBe(200);
            expect(await page.text()).toContain('<title>Colibri</title>');
        } finally {
            const closed = once(httpServer, 'close');
            webServer.stop();
            httpServer.closeAllConnections();
            await closed;
            await rm(webRoot, { recursive: true, force: true });
        }
    });
});

const hasIPv6Loopback = Object.values(networkInterfaces()).some(addresses => addresses?.some(a => a.address === '::1'));

// WEBSERVER_HOST=:: for a server reached over IPv6, where clients on IPv4 still connect.
describe.skipIf(!hasIPv6Loopback)('WebServer on an IPv6 WEBSERVER_HOST', () => {
    it('serves the admin UI over IPv6, and over IPv4 too on ::', async () => {
        const webRoot = await mkdtemp(path.join(tmpdir(), 'colibri-web-server-ipv6-'));
        await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>Colibri</title>', 'utf8');
        const webServer = new WebServer('::', 0, webRoot, '');
        const httpServer = webServer.start();
        try {
            await once(httpServer, 'listening');
            const { port, family } = httpServer.address() as AddressInfo;
            expect(family).toBe('IPv6');

            for (const host of [ '[::1]', '127.0.0.1' ]) {
                const page = await fetch(`http://${host}:${port}/`);
                expect(page.status, host).toBe(200);
                expect(await page.text(), host).toContain('<title>Colibri</title>');
            }
        } finally {
            const closed = once(httpServer, 'close');
            webServer.stop();
            httpServer.closeAllConnections();
            await closed;
            await rm(webRoot, { recursive: true, force: true });
        }
    });
});

// req.ip has to name the same client as SocketIOServer does. The requests come from 127.0.0.1,
// standing in for the proxy.
describe('WebServer behind a reverse proxy', () => {
    const ipOf = async function (trustProxy: TrustProxy | undefined, forwardedFor: string): Promise<unknown> {
        const webRoot = await mkdtemp(path.join(tmpdir(), 'colibri-web-server-proxy-'));
        const webServer = new WebServer('127.0.0.1', 0, webRoot, '', undefined, trustProxy);
        webServer.addApi('/ip', (req, res) => {
            res.json({ ip: req.ip });
        });
        const httpServer = webServer.start();
        try {
            await once(httpServer, 'listening');
            const response = await fetch(`http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/api/ip`, {
                headers: { 'X-Forwarded-For': forwardedFor },
            });
            return (await response.json() as { ip: unknown }).ip;
        } finally {
            const closed = once(httpServer, 'close');
            webServer.stop();
            httpServer.closeAllConnections();
            await closed;
            await rm(webRoot, { recursive: true, force: true });
        }
    };

    it('takes req.ip from a trusted proxy\'s X-Forwarded-For, right-most untrusted entry first', async () => {
        expect(await ipOf(compileTrustedProxies(['loopback']), '6.6.6.6, 198.51.100.7')).toBe('198.51.100.7');
    });

    it('ignores X-Forwarded-For from a peer it does not trust, and by default', async () => {
        expect(await ipOf(compileTrustedProxies(['10.0.0.1']), '198.51.100.7')).toBe('127.0.0.1');
        expect(await ipOf(undefined, '198.51.100.7')).toBe('127.0.0.1');
    });
});

describe('WebServer startup', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    // The constructor used to console.log 'Web server listening on ...' before listen() had
    // even been called, and start() then logged the same line once it was true - which the
    // console sink prints as well. Every start printed it twice, the first time too early.
    it('says it is listening exactly once, and only once it is', async () => {
        const printed: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void printed.push(args.map(String).join(' ')));
        // The sink main.ts attaches, writing here instead of to stdout/stderr.
        const sink = new ConsoleLog({ minLevel: LogLevel.Debug, broadcastTraffic: false }, {
            out: line => printed.push(line),
            err: line => printed.push(line),
        });
        const subscription = sink.attach(Service.output$);
        const listening = () => printed.filter(line => line.includes('Web server listening on'));

        const webRoot = await mkdtemp(path.join(tmpdir(), 'colibri-web-server-startup-'));
        const webServer = new WebServer('127.0.0.1', 0, webRoot, '');
        try {
            expect(listening()).toEqual([]);

            const httpServer = webServer.start();
            await once(httpServer, 'listening');

            expect(listening()).toHaveLength(1);
            expect(listening()[0]).toMatch(/ INFO {2}\[web\/WebServer\] Web server listening on 127\.0\.0\.1:/);
        } finally {
            subscription.unsubscribe();
            webServer.stop();
            await rm(webRoot, { recursive: true, force: true });
        }
    });
});

// With TLS_CERT and TLS_KEY set, the admin UI, the REST API and Socket.IO are served over HTTPS
// and WSS, and only so.
describe('WebServer over HTTPS', () => {
    let fixtures: string;
    let first: TestCertificate;
    let second: TestCertificate;

    let webRoot: string;
    let tlsChanges: Subject<TlsCredentials>;
    let webServer: WebServer;
    let socketIo: SocketIOServer;
    let server: http.Server;
    let port: number;
    let logs: LogMessage[];
    let logSubscription: Subscription;
    let clients: ClientSocket[];
    let agents: https.Agent[];

    // Either certificate is trusted, so a connection succeeds whichever one it is served.
    const ca = (): Buffer[] => [ first.cert, second.cert ];

    interface Answer { status: number; body: string; fingerprint: string | undefined; socket: tls.TLSSocket }

    const get = function (urlPath: string, agent?: https.Agent): Promise<Answer> {
        return new Promise((resolve, reject) => {
            const req = https.get({ host: '127.0.0.1', port, path: urlPath, servername: 'localhost', ca: ca(), agent }, res => {
                const socket = res.socket as tls.TLSSocket;
                const fingerprint = socket.getPeerX509Certificate()?.fingerprint256;
                let body = '';
                res.setEncoding('utf8');
                res.on('data', chunk => (body += chunk));
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body, fingerprint, socket }));
            });
            req.on('error', reject);
        });
    };

    // The certificate a new connection is served.
    const servedFingerprint = function (): Promise<string | undefined> {
        return new Promise((resolve, reject) => {
            const socket = tls.connect({ host: '127.0.0.1', port, servername: 'localhost', ca: ca() }, () => {
                resolve(socket.getPeerX509Certificate()?.fingerprint256);
                socket.end();
            });
            socket.on('error', reject);
        });
    };

    const connectSocketIo = async function (transport: 'websocket' | 'polling'): Promise<ClientSocket> {
        const socket = connectClient(`https://localhost:${port}`, {
            query: { app: 'tls-test', version: PROTOCOL_VERSION },
            transports: [ transport ],
            reconnection: false,
            forceNew: true,
            // socket.io-client's types take PEM text only, unlike tls.connect.
            ca: ca().map(pem => pem.toString()),
        });
        clients.push(socket);
        await new Promise<void>((resolve, reject) => {
            socket.once('connect', resolve);
            socket.once('connect_error', reject);
        });
        return socket;
    };

    beforeAll(async () => {
        fixtures = await mkdtemp(path.join(tmpdir(), 'colibri-web-server-tls-'));
        first = createTestCertificate(fixtures, 'first');
        second = createTestCertificate(fixtures, 'second');
    });

    afterAll(async () => {
        await rm(fixtures, { recursive: true, force: true });
    });

    beforeEach(async () => {
        logs = [];
        logSubscription = Service.output$.subscribe(log => logs.push(log));
        clients = [];
        agents = [];

        webRoot = await mkdtemp(path.join(tmpdir(), 'colibri-web-server-tls-root-'));
        await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>Colibri</title>', 'utf8');

        tlsChanges = new Subject<TlsCredentials>();
        webServer = new WebServer('127.0.0.1', 0, webRoot, '', { credentials: { cert: first.cert, key: first.key }, changes$: tlsChanges });
        server = webServer.start();
        socketIo = new SocketIOServer();
        socketIo.start(server);
        await once(server, 'listening');
        port = (server.address() as AddressInfo).port;
    });

    afterEach(async () => {
        logSubscription.unsubscribe();
        for (const client of clients) client.disconnect();
        for (const agent of agents) agent.destroy();
        const closed = once(server, 'close');
        // Closes the web server too.
        socketIo.stop();
        webServer.stop();
        server.closeAllConnections();
        await closed;
        await rm(webRoot, { recursive: true, force: true });
    });

    it('serves the admin UI and the REST API with the certificate', async () => {
        const page = await get('/log');
        expect(page.status).toBe(200);
        expect(page.body).toContain('<title>Colibri</title>');
        expect(page.fingerprint).toBe(first.fingerprint256);

        const api = await get('/api/nope');
        expect(api.status).toBe(404);
        expect(JSON.parse(api.body)).toEqual({ error: 'No API route for GET /api/nope' });
    });

    it('does not serve unencrypted HTTP', async () => {
        await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    });

    it('says it serves HTTPS and WSS only', () => {
        expect(logs.map(l => l.message)).toContain('Web server listening on 127.0.0.1:0, HTTPS and WSS only');
    });

    it.each([ 'websocket', 'polling' ] as const)('carries Socket.IO over %s', async (transport) => {
        const socket = await connectSocketIo(transport);

        expect(socket.connected).toBe(true);
    });

    it('serves a renewed certificate to new connections, and keeps open ones working', async () => {
        const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
        agents.push(agent);
        const before = await get('/log', agent);
        expect(before.fingerprint).toBe(first.fingerprint256);
        const webSocket = await connectSocketIo('websocket');

        tlsChanges.next({ cert: second.cert, key: second.key });

        expect(await servedFingerprint()).toBe(second.fingerprint256);

        // The same keep-alive connection, still on the TLS session it started with. (Node does
        // not report the peer's certificate again on a reused connection, so that is not checked.)
        const after = await get('/log', agent);
        expect(after.socket).toBe(before.socket);
        expect(after.status).toBe(200);

        // The WebSocket, too.
        const received = firstValueFrom(socketIo.messages$.pipe(filter(m => m.channel === 'after-reload')));
        webSocket.emit('after-reload', { command: 'ping', payload: {} });
        expect((await received).origin?.id).toBe(webSocket.id);
    });

    it('keeps the certificate it has when it cannot switch to a renewed one, and says so', async () => {
        tlsChanges.next({ cert: Buffer.from('not a certificate'), key: second.key });

        expect(logs.filter(l => l.level === LogLevel.Error).map(l => l.message))
            .toEqual([ expect.stringContaining('Could not switch the web server to the renewed TLS certificate') ]);
        expect(await servedFingerprint()).toBe(first.fingerprint256);
    });
});
