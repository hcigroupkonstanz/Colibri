import { afterEach, describe, it, expect, vi } from 'vitest';
import { Subject } from 'rxjs';
import type {
    ConsoleLogOptions,
} from '../../src/server/modules/core/console-log.js';
import {
    ConsoleLog,
    MAX_CONSOLE_MESSAGE_LENGTH,
    PRINTED_TO_CONSOLE,
} from '../../src/server/modules/core/console-log.js';
import type { LogMessage, Metadata } from '../../src/server/modules/core/log-message.js';
import { LogLevel } from '../../src/server/modules/core/log-message.js';
import { Service } from '../../src/server/modules/core/service.js';

const CREATED = new Date('2026-10-19T08:30:00.123Z');

const message = function (level: LogLevel, text: string, metadata: Metadata = {}): LogMessage {
    return { origin: 'RestAPI', group: 'web', level, message: text, created: CREATED, metadata };
};

interface Captured { out: string[]; err: string[] }

const capture = function (options: Partial<ConsoleLogOptions> = {}): { log: ConsoleLog; lines: Captured } {
    const lines: Captured = { out: [], err: [] };
    const log = new ConsoleLog(
        { minLevel: LogLevel.Info, broadcastTraffic: false, ...options },
        { out: line => lines.out.push(line), err: line => lines.err.push(line) }
    );
    return { log, lines };
};

class SampleService extends Service {
    public get serviceName(): string { return 'SampleService'; }
    public get groupName(): string { return 'test'; }

    public fail(msg: string): void {
        this.logError(msg, false);
    }
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('ConsoleLog', () => {
    // The admin UI's in-memory WebLog used to be the bus's only subscriber, so a failed
    // store.json write or a crashed TCP worker never reached `docker logs` at all.
    it('prints what a service logs on Service.output$', () => {
        const { log, lines } = capture();
        const subscription = log.attach(Service.output$);

        new SampleService().fail('EACCES: permission denied, open \'/srv/colibri/data/store.json.tmp\'');
        subscription.unsubscribe();

        expect(lines.err).toHaveLength(1);
        expect(lines.err[0]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z ERROR \[test\/SampleService\] EACCES: permission denied/);
    });

    it('formats one line with timestamp, level, group, service and message', () => {
        expect(ConsoleLog.format(message(LogLevel.Warn, 'Refusing client c1'))).toBe(
            '2026-10-19T08:30:00.123Z WARN  [web/RestAPI] Refusing client c1'
        );
    });

    it('sends errors and warnings to stderr, info and debug to stdout', () => {
        const { log, lines } = capture({ minLevel: LogLevel.Debug });

        log.write(message(LogLevel.Error, 'e'));
        log.write(message(LogLevel.Warn, 'w'));
        log.write(message(LogLevel.Info, 'i'));
        log.write(message(LogLevel.Debug, 'd'));

        expect(lines.err.map(line => line.slice(-1))).toEqual([ 'e', 'w' ]);
        expect(lines.out.map(line => line.slice(-1))).toEqual([ 'i', 'd' ]);
    });

    it('drops messages more verbose than the minimum level', () => {
        const info = capture({ minLevel: LogLevel.Info });
        info.log.write(message(LogLevel.Debug, 'd'));
        info.log.write(message(LogLevel.Info, 'i'));
        expect(info.lines.out).toHaveLength(1);

        const warn = capture({ minLevel: LogLevel.Warn });
        warn.log.write(message(LogLevel.Info, 'i'));
        warn.log.write(message(LogLevel.Warn, 'w'));
        warn.log.write(message(LogLevel.Error, 'e'));
        expect(warn.lines.out).toEqual([]);
        expect(warn.lines.err).toHaveLength(2);
    });

    // BroadcastLogger logs every broadcast:: message of every client, many times a second.
    it('leaves broadcast traffic out unless it is switched on, whatever the level', () => {
        const traffic = message(LogLevel.Debug, '[quest-1] broadcast cube (broadcast::transform)', { broadcastTraffic: true });

        const off = capture({ minLevel: LogLevel.Debug });
        off.log.write(traffic);
        expect(off.lines.out).toEqual([]);

        const on = capture({ minLevel: LogLevel.Error, broadcastTraffic: true });
        on.log.write(traffic);
        expect(on.lines.out).toHaveLength(1);
    });

    it('does not print a message a second time that was already written to the console', () => {
        const { log, lines } = capture({ minLevel: LogLevel.Debug });
        log.write(message(LogLevel.Error, 'already printed', { [PRINTED_TO_CONSOLE]: true }));
        expect(lines).toEqual({ out: [], err: [] });
    });

    // A stack trace keeps its shape, and nothing a client sends in a log line can start a new,
    // unindented line that reads like the server's own output.
    it('indents the continuation lines of a multi-line message', () => {
        const line = ConsoleLog.format(message(LogLevel.Error, '[quest-1] boom\r\n2026-10-19T08:30:00.000Z ERROR [web/RestAPI] forged\n  at Foo.bar'));
        expect(line.split('\n')).toEqual([
            '2026-10-19T08:30:00.123Z ERROR [web/RestAPI] [quest-1] boom',
            '    2026-10-19T08:30:00.000Z ERROR [web/RestAPI] forged',
            '      at Foo.bar',
        ]);
    });

    it('escapes control characters instead of passing them to the terminal', () => {
        const line = ConsoleLog.format(message(LogLevel.Info, 'a\u001b[2Jb\rc\u0007d\u009be\tf'));
        expect(line).toBe('2026-10-19T08:30:00.123Z INFO  [web/RestAPI] a\\x1b[2Jb\\x0dc\\x07d\\x9be\tf');
    });

    it('cuts an oversized message and says how much is missing', () => {
        const line = ConsoleLog.format(message(LogLevel.Info, 'x'.repeat(MAX_CONSOLE_MESSAGE_LENGTH + 500)));
        expect(line.endsWith(' [... 500 more characters]')).toBe(true);
        expect(line.length).toBeLessThan(MAX_CONSOLE_MESSAGE_LENGTH + 100);
    });

    it('never throws into the bus, which would take the server down', () => {
        const log = new ConsoleLog(
            { minLevel: LogLevel.Debug, broadcastTraffic: false },
            { out: () => { throw new Error('EPIPE'); }, err: () => { throw new Error('EPIPE'); } }
        );
        const bus = new Subject<LogMessage>();
        log.attach(bus);

        expect(() => bus.next(message(LogLevel.Error, 'e'))).not.toThrow();
        expect(() => log.write({ ...message(LogLevel.Info, 'i'), created: new Date(NaN) })).not.toThrow();
    });

    it('writes to the real stdout and stderr by default', () => {
        const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const log = new ConsoleLog({ minLevel: LogLevel.Info, broadcastTraffic: false });

        log.write(message(LogLevel.Info, 'to stdout'));
        log.write(message(LogLevel.Error, 'to stderr'));

        expect(stdout.mock.calls.map(call => String(call[0]))).toEqual([ '2026-10-19T08:30:00.123Z INFO  [web/RestAPI] to stdout\n' ]);
        expect(stderr.mock.calls.map(call => String(call[0]))).toEqual([ '2026-10-19T08:30:00.123Z ERROR [web/RestAPI] to stderr\n' ]);
    });

    describe('optionsFromEnv', () => {
        it('defaults to info, without broadcast traffic', () => {
            expect(ConsoleLog.optionsFromEnv({})).toEqual({ minLevel: LogLevel.Info, broadcastTraffic: false });
            expect(ConsoleLog.optionsFromEnv({ CONSOLE_LOG_LEVEL: '' }).minLevel).toBe(LogLevel.Info);
        });

        it('reads the level, in any case', () => {
            expect(ConsoleLog.optionsFromEnv({ CONSOLE_LOG_LEVEL: 'debug' }).minLevel).toBe(LogLevel.Debug);
            expect(ConsoleLog.optionsFromEnv({ CONSOLE_LOG_LEVEL: 'WARN' }).minLevel).toBe(LogLevel.Warn);
            expect(ConsoleLog.optionsFromEnv({ CONSOLE_LOG_LEVEL: 'warning' }).minLevel).toBe(LogLevel.Warn);
            expect(ConsoleLog.optionsFromEnv({ CONSOLE_LOG_LEVEL: ' error ' }).minLevel).toBe(LogLevel.Error);
        });

        it('turns broadcast traffic on only for "true"', () => {
            expect(ConsoleLog.optionsFromEnv({ CONSOLE_LOG_BROADCAST_TRAFFIC: 'TRUE' }).broadcastTraffic).toBe(true);
            expect(ConsoleLog.optionsFromEnv({ CONSOLE_LOG_BROADCAST_TRAFFIC: '1' }).broadcastTraffic).toBe(false);
        });

        it('refuses a level it does not know, naming the variable', () => {
            expect(() => ConsoleLog.optionsFromEnv({ CONSOLE_LOG_LEVEL: 'verbose' })).toThrow(/CONSOLE_LOG_LEVEL: "verbose"/);
        });
    });
});
