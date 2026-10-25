import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import express from 'express';
import cors from 'cors';
import type { Subscription } from 'rxjs';

import { errorMessage } from '../core/error-message.js';
import { Service } from '../core/service.js';
import type { TlsCredentialSource } from '../tls/tls-certificate.js';
import type { TlsCredentials } from '../tls/tls-files.js';
import { MAX_FRAME_LENGTH, REST_MEDIA_TYPE } from '../protocol/protocol.js';
import type { TrustProxy } from '../net/trusted-proxies.js';
import { trustNoProxy } from '../net/trusted-proxies.js';
import { fellBackToIPv4, hostPort, ipv4OnlyWarning, listenHost } from '../net/addresses.js';

// Filled by the verify hook of express.json() below.
const emptyJsonBodies = new WeakSet<http.IncomingMessage>();

/** Whether the request's JSON body was zero bytes, which express.json() hands on as `{}`. */
export const hasEmptyJsonBody = function (req: http.IncomingMessage): boolean {
    return emptyJsonBodies.has(req);
};

/** Whether the request's Content-Type is the REST store's media type, parameters aside. */
export const hasRestMediaType = function (req: http.IncomingMessage): boolean {
    const contentType = req.headers['content-type'];
    return typeof contentType === 'string' && contentType.split(';')[0]!.trim().toLowerCase() === REST_MEDIA_TYPE;
};

export interface WebServerOptions {
    hostname: string;
    webPort: number;
    webRoot: string;
    baseUrl: string;
    // Serve HTTPS (and Socket.IO's WSS) only, with this certificate and each renewed one.
    tls?: TlsCredentialSource;
    // The proxies whose X-Forwarded-For names the client; see TRUSTED_PROXIES. None if left out.
    trustProxy?: TrustProxy;
}

export class WebServer extends Service {
    public get serviceName(): string {
        return 'WebServer';
    }
    public get groupName(): string {
        return 'web';
    }

    private readonly hostname: string;
    private readonly webPort: number;
    private readonly webRoot: string;
    private readonly baseUrl: string;
    private readonly tls?: TlsCredentialSource;
    private readonly app: express.Application;
    private server!: http.Server | https.Server;
    private isRunning = false;
    private tlsChanges: Subscription | undefined;

    public constructor(options: WebServerOptions) {
        super();
        const { trustProxy = trustNoProxy } = options;
        this.hostname = options.hostname;
        this.webPort = options.webPort;
        this.webRoot = options.webRoot;
        this.baseUrl = options.baseUrl;
        this.tls = options.tls;

        this.app = express();
        this.app.set('port', this.webPort);
        // So that req.ip names the same client as SocketIOServer does.
        this.app.set('trust proxy', trustProxy);

        // enable CORS
        // First, so that the errors of the body parsers below carry the headers too.
        this.app.use(cors());

        // Every answer under /api, errors included, is in the REST store's media type. A request
        // whose Accept rules it out gets 406 before its body is read.
        this.app.use('/api', (req, res, next) => {
            res.type(REST_MEDIA_TYPE);
            if (req.accepts(REST_MEDIA_TYPE)) {
                next();
                return;
            }
            next(Object.assign(new Error(`Not acceptable: the REST store answers in ${REST_MEDIA_TYPE} only, which Accept leaves out`),
                { status: 406, expose: true }));
        });

        // Not strict: both clients send a bare value as its JSON text (Store.Put(name, 42) sends `42`). The
        // limit is the TCP frame limit, so the same data fits over HTTP. `verify` sees the raw body, the only
        // place that can tell an empty body from `{}`. Other media types are left unread; the store refuses
        // them with 415.
        this.app.use(express.json({
            type: REST_MEDIA_TYPE,
            strict: false,
            limit: MAX_FRAME_LENGTH,
            verify: (req, _res, body) => {
                if (body.length === 0) emptyJsonBodies.add(req);
            },
        }));

        // set up default routes
        this.app.use(this.baseUrl, express.static(path.join(this.webRoot)));
    }

    public start(): http.Server {
        // Whatever reached /api without an API route answering it: a mistyped path, or a method the
        // route does not have. Otherwise the SPA fallback below could answer 200 with index.html.
        // Mounted at /api whatever BASE_URL is, as addApi does.
        this.app.use('/api', (req, _res, next) => {
            next(Object.assign(new Error(`No API route for ${req.method} ${req.originalUrl}`), { status: 404, expose: true }));
        });

        // SPA fallback, added last: the Angular router owns every path that isn't a static asset or
        // an API route (/log, /statistics), so this fires on every page load, not only on 404s.
        // It must not log: opening the log viewer would add an entry to it.
        this.app.use(this.baseUrl, (req, res) => {
            res.sendFile(path.join(this.webRoot, 'index.html'));
        });

        // Last, so it handles the errors of every route above. Express's default handler puts the
        // stack trace into the response unless NODE_ENV is "production", which a server started
        // from a checkout usually lacks.
        this.app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
            this.handleError(err, req, res, next);
        });

        // lock server so no more route changes are allowed
        this.isRunning = true;

        // start server
        this.server = this.tls ? this.createHttpsServer(this.tls) : http.createServer(this.app);
        this.server.listen(this.webPort, listenHost(this.hostname), () => {
            const ipv4Only = fellBackToIPv4(this.hostname, this.server.address());
            this.logInfo(
                `Web server listening on ${hostPort(ipv4Only ? '0.0.0.0' : this.hostname, this.webPort)}${this.tls ? ', HTTPS and WSS only' : ''}`
            );
            if (ipv4Only) this.logWarning(ipv4OnlyWarning('WEBSERVER_HOST', 'web port'));
        });

        return this.server;
    }

    // A renewed certificate is used for every connection from then on. Open ones, a keep-alive
    // HTTP connection or a Socket.IO WebSocket, keep the certificate they started with.
    private createHttpsServer(tls: TlsCredentialSource): https.Server {
        const server = https.createServer(this.secureContextOptions(tls.credentials), this.app);
        this.tlsChanges = tls.changes$.subscribe(credentials => {
            // TlsCertificate hands on only checked credentials, so this should not throw. If it
            // does, keep the one in use.
            try {
                server.setSecureContext(this.secureContextOptions(credentials));
            } catch (err) {
                this.logError(`Could not switch the web server to the renewed TLS certificate: ${errorMessage(err)}`, false);
            }
        });
        return server;
    }

    private secureContextOptions(credentials: TlsCredentials): { cert: Buffer; key: Buffer } {
        return { cert: credentials.cert, key: credentials.key };
    }

    public stop(): void {
        this.tlsChanges?.unsubscribe();
        this.tlsChanges = undefined;
        if (this.isRunning) {
            this.server.close();
            this.isRunning = false;
        }
    }

    private handleError(err: unknown, req: express.Request, res: express.Response, next: express.NextFunction): void {
        // Too late to answer with anything else; express's own handler closes the connection.
        if (res.headersSent) {
            next(err);
            return;
        }

        // Besides the 406 and 404 above, 4xx errors come from body-parser (400, 413), send (404) and the
        // router (400). http-errors' `expose` marks messages meant for the client; send's errors name the path
        // on disk and the router's URIError is not exposed, so those get the plain status text.
        const { status, statusCode, expose, message } = (err ?? {}) as { status?: unknown; statusCode?: unknown; expose?: unknown; message?: unknown };
        const clientStatus = status ?? statusCode;
        if (typeof clientStatus === 'number' && clientStatus >= 400 && clientStatus < 500) {
            this.logWarning(`${req.method} ${req.originalUrl} answered ${clientStatus}: ${typeof message === 'string' ? message : String(err)}`);
            res.status(clientStatus).json({
                error: expose === true && typeof message === 'string' ? message : (http.STATUS_CODES[clientStatus] ?? 'Bad request')
            });
            return;
        }

        this.logError(`${req.method} ${req.originalUrl} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`, false);
        res.status(500).json({ error: 'Internal server error' });
    }

    public addRoute(
        url: string,
        requestHandler: express.RequestHandler | express.Router
    ): void {
        if (this.isRunning) {
            this.logError(`Could not add route ${url}: Server already running`, false);
        } else {
            this.app.use(url, requestHandler);
        }
    }

    public addApi(
        url: string,
        requestHandler: express.RequestHandler | express.Router
    ): void {
        this.addRoute(
            path.join('/api/', url).replace(/\\/g, '/'),
            requestHandler
        );
    }
}
