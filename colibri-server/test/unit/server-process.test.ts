import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Subscription } from 'rxjs';
import { ConsoleLog, LogLevel, LogMessage, ServerProcess, Service, ShutdownStep } from '../../src/server/modules/core/index.js';

describe('ServerProcess', () => {
    let logs: LogMessage[];
    let printed: { stream: 'out' | 'err'; line: string }[];
    let subscriptions: Subscription[];
    let exits: number[];
    let exited: Promise<number>;
    let onExit: (code: number) => void;

    beforeEach(() => {
        logs = [];
        printed = [];
        exits = [];
        exited = new Promise(resolve => onExit = resolve);
        // The sink main.ts attaches, at its default level, writing here instead of to the console.
        const sink = new ConsoleLog({ minLevel: LogLevel.Info, broadcastTraffic: false }, {
            out: line => printed.push({ stream: 'out', line }),
            err: line => printed.push({ stream: 'err', line }),
        });
        subscriptions = [
            Service.output$.subscribe(log => {
                if (log.origin === 'Server') logs.push(log);
            }),
            sink.attach(Service.output$),
        ];
    });

    afterEach(() => {
        for (const subscription of subscriptions) subscription.unsubscribe();
    });

    const create = (steps: ShutdownStep[], timeoutMillis = 5000) => new ServerProcess(steps, timeoutMillis, (code) => {
        exits.push(code);
        onExit(code);
    });

    const serverLines = () => printed.filter(({ line }) => line.includes('[core/Server]'));

    it('says which version and commit it is', () => {
        const server = create([]);
        server.reportStart('2.0.0', { commit: '3e2855e0c1d2b3a4f5e6d7c8b9a0f1e2d3c4b5a6', dirty: true, builtAt: 0 });
        server.reportStart('2.0.0', { commit: null, dirty: false, builtAt: null });

        expect(serverLines().map(({ stream, line }) => [ stream, line.replace(/^\S+ /, '') ])).toEqual([
            [ 'out', 'INFO  [core/Server] Colibri 2.0.0, commit 3e2855e0c1 (with uncommitted changes)' ],
            [ 'out', 'INFO  [core/Server] Colibri 2.0.0, commit unknown (built without git information)' ],
        ]);
    });

    it('warns about a setting that has no effect, in the console log format', () => {
        create([]).reportWarning('TCP_TLS_AT_PROXY is true, but TCP_PROXY_PROTOCOL is false');

        expect(serverLines().map(({ stream, line }) => [ stream, line.replace(/^\S+ /, '') ])).toEqual([
            [ 'err', 'WARN  [core/Server] TCP_TLS_AT_PROXY is true, but TCP_PROXY_PROTOCOL is false' ],
        ]);
        expect(logs.map(l => [ l.level, l.group ])).toEqual([ [ LogLevel.Warn, 'core' ] ]);
    });

    // main.ts printed this line with console.log: the one line in `docker logs` without a
    // timestamp, level or source, and missing from the admin UI's log.
    it('says it is shutting down in the console log format', async () => {
        await create([]).shutdown('Received SIGTERM', 0);

        expect(serverLines()).toHaveLength(1);
        expect(serverLines()[0]!.stream).toBe('out');
        expect(serverLines()[0]!.line).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z INFO {2}\[core\/Server\] Received SIGTERM, shutting down\.\.\.$/);
        expect(logs.map(l => [ l.level, l.group, l.message ])).toEqual([ [ LogLevel.Info, 'core', 'Received SIGTERM, shutting down...' ] ]);
        expect(exits).toEqual([ 0 ]);
    });

    it('says so as an error when a crash shuts it down', async () => {
        await create([]).shutdown('Uncaught exception', 1);

        expect(serverLines().map(({ stream, line }) => [ stream, line.replace(/^\S+ /, '') ]))
            .toEqual([ [ 'err', 'ERROR [core/Server] Uncaught exception, shutting down...' ] ]);
        expect(exits).toEqual([ 1 ]);
    });

    it('runs every step in order, waiting for each, and exits only after the last', async () => {
        const order: string[] = [];
        const steps = [ 'WebServer', 'TCPServer', 'RestAPI', 'VoiceServer' ].map(name => ({
            name,
            stop: async () => {
                order.push(`${name} started`);
                await new Promise(resolve => setTimeout(resolve, 5));
                order.push(`${name} done`);
            },
        }));
        const serverProcess = create(steps);

        await serverProcess.shutdown('Received SIGINT', 0);

        expect(order).toEqual(steps.flatMap(({ name }) => [ `${name} started`, `${name} done` ]));
        expect(exits).toEqual([ 0 ]);
    });

    it('logs a step that fails, with its stack, and still runs the steps after it', async () => {
        const ran: string[] = [];
        const serverProcess = create([
            { name: 'WebServer', stop: () => { throw new Error('boom'); } },
            { name: 'TCPServer', stop: () => Promise.reject(new Error('worker gone')) },
            { name: 'RestAPI', stop: () => void ran.push('RestAPI') },
        ]);

        await serverProcess.shutdown('Received SIGTERM', 0);

        expect(ran).toEqual([ 'RestAPI' ]);
        const errors = logs.filter(l => l.level === LogLevel.Error);
        expect(errors.map(l => l.message.split('\n')[0])).toEqual([ 'Error stopping WebServer: Error: boom', 'Error stopping TCPServer: Error: worker gone' ]);
        expect(errors[0]!.message).toMatch(/\n\s+at /);
        expect(exits).toEqual([ 0 ]);
    });

    it('exits anyway when a step does not finish in time, and only once', async () => {
        let finish!: () => void;
        const serverProcess = create([ { name: 'VoiceServer', stop: () => new Promise<void>(resolve => finish = resolve) } ], 50);

        void serverProcess.shutdown('Received SIGTERM', 0);

        expect(await exited).toBe(0);
        expect(logs.filter(l => l.level === LogLevel.Error).map(l => l.message)).toEqual([ 'Shutdown did not complete within 50ms, exiting' ]);
        expect(serverLines().map(({ line }) => line.replace(/^\S+ /, ''))).toContain('ERROR [core/Server] Shutdown did not complete within 50ms, exiting');

        // A step that finishes after all must not exit a second time.
        finish();
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(exits).toEqual([ 0 ]);
    });

    it('shuts down once, however often it is asked', async () => {
        let stops = 0;
        const serverProcess = create([ { name: 'RestAPI', stop: () => void stops++ } ]);

        await Promise.all([ serverProcess.shutdown('Received SIGTERM', 0), serverProcess.shutdown('Received SIGINT', 0), serverProcess.shutdown('Uncaught exception', 1) ]);

        expect(stops).toBe(1);
        expect(exits).toEqual([ 0 ]);
        expect(logs.map(l => l.message)).toEqual([ 'Received SIGTERM, shutting down...' ]);
    });

    it('reports an error in the console log format, stack included', () => {
        create([]).reportError('Uncaught exception', new TypeError('x is not a function'));
        create([]).reportError('Unhandled rejection', 'just a string');

        const lines = serverLines().map(({ stream, line }) => [ stream, line.replace(/^\S+ /, '') ]);
        expect(lines[0]![0]).toBe('err');
        expect(lines[0]![1]).toMatch(/^ERROR \[core\/Server\] Uncaught exception: TypeError: x is not a function\n {4}\s+at /);
        expect(lines[1]).toEqual([ 'err', 'ERROR [core/Server] Unhandled rejection: just a string' ]);
    });
});
