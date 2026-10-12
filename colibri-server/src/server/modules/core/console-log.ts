import { Console } from 'console';
import { Observable, Subscription } from 'rxjs';
import { LogLevel, LogMessage, Metadata } from './log-message.js';

/**
 * Set on a log message whose text has already been written to stdout/stderr by whoever logged
 * it, so {@link ConsoleLog} does not print it a second time. The admin UI still shows it.
 */
export const PRINTED_TO_CONSOLE = 'printedToConsole';

/** Most of a message {@link ConsoleLog} prints; the rest is cut and counted. */
export const MAX_CONSOLE_MESSAGE_LENGTH = 8192;

export interface ConsoleLogOptions {
    /** The most verbose level printed: Info prints Error, Warn and Info, and drops Debug. */
    minLevel: LogLevel;

    /**
     * Whether broadcast/sync traffic (`metadata.broadcastTraffic`) is printed. Decided by this
     * alone and never by {@link minLevel}, the same way the admin UI's "show broadcast traffic"
     * toggle works: it is logged at Debug, many times a second per client.
     */
    broadcastTraffic: boolean;
}

export interface ConsoleLogWriter {
    out(line: string): void;
    err(line: string): void;
}

const LEVELS: { [name: string]: LogLevel } = {
    error: LogLevel.Error,
    warn: LogLevel.Warn,
    warning: LogLevel.Warn,
    info: LogLevel.Info,
    debug: LogLevel.Debug,
};

const LABELS: { [level: number]: string } = {
    [LogLevel.Error]: 'ERROR',
    [LogLevel.Warn]: 'WARN ',
    [LogLevel.Info]: 'INFO ',
    [LogLevel.Debug]: 'DEBUG',
};

// Everything but tab and newline: a carriage return, a backspace or an ANSI escape in a client's
// log line would otherwise rewrite what an operator sees in a terminal.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

const escapeControl = function (char: string): string {
    return `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`;
};

// A private Console rather than the global one: it ignores a broken stdout/stderr pipe instead
// of throwing, and it keeps writing to the real streams even if something (RedirectConsole)
// has replaced console.log/console.error with a function that logs back onto the bus.
let defaultWriter: ConsoleLogWriter | undefined;
const getDefaultWriter = function (): ConsoleLogWriter {
    if (!defaultWriter) {
        const sink = new Console({ stdout: process.stdout, stderr: process.stderr });
        defaultWriter = {
            out: line => sink.log('%s', line),
            err: line => sink.error('%s', line),
        };
    }
    return defaultWriter;
};

/**
 * Prints the services' log messages to stdout and stderr, so they reach `docker logs`.
 *
 * Every `Service` log call publishes on `Service.output$`, and until this existed the admin UI's
 * in-memory `WebLog` was the only thing listening - a refused client, a failed store.json write
 * or a crashed TCP worker never reached the container's output, and was gone with the process.
 *
 * One line per message: `<ISO timestamp> <LEVEL> [<group>/<service>] <message>`. Errors and
 * warnings go to stderr, the rest to stdout. A message that spans several lines (a stack trace)
 * continues on lines indented by four spaces, so nothing a client sends can start a line that
 * looks like one of these.
 */
export class ConsoleLog {
    public constructor(
        private readonly options: ConsoleLogOptions,
        private readonly writer: ConsoleLogWriter = getDefaultWriter()
    ) { }

    /**
     * Reads `CONSOLE_LOG_LEVEL` (error, warn, info or debug; default info) and
     * `CONSOLE_LOG_BROADCAST_TRAFFIC` (true or false; default false). Throws on a level it does
     * not know, naming the variable, rather than guessing what was meant.
     */
    public static optionsFromEnv(env: NodeJS.ProcessEnv): ConsoleLogOptions {
        return {
            minLevel: ConsoleLog.parseLevel('CONSOLE_LOG_LEVEL', env.CONSOLE_LOG_LEVEL, LogLevel.Info),
            broadcastTraffic: env.CONSOLE_LOG_BROADCAST_TRAFFIC?.toLowerCase() === 'true',
        };
    }

    public static parseLevel(name: string, raw: string | undefined, fallback: LogLevel): LogLevel {
        if (raw === undefined || raw.trim() === '') return fallback;
        const level = LEVELS[raw.trim().toLowerCase()];
        if (level === undefined) {
            throw new Error(`Invalid ${name}: "${raw}" is not a log level (expected error, warn, info or debug)`);
        }
        return level;
    }

    public static shouldPrint(msg: LogMessage, options: ConsoleLogOptions): boolean {
        const metadata: Metadata = msg.metadata ?? {};
        if (metadata[PRINTED_TO_CONSOLE] === true) return false;
        if (metadata['broadcastTraffic'] === true) return options.broadcastTraffic;
        return msg.level <= options.minLevel;
    }

    public static format(msg: LogMessage): string {
        const created = msg.created instanceof Date && !Number.isNaN(msg.created.getTime()) ? msg.created : new Date();
        const label = LABELS[msg.level] ?? 'LOG  ';

        let text = String(msg.message);
        if (text.length > MAX_CONSOLE_MESSAGE_LENGTH) {
            text = `${text.slice(0, MAX_CONSOLE_MESSAGE_LENGTH)} [... ${text.length - MAX_CONSOLE_MESSAGE_LENGTH} more characters]`;
        }
        const lines = text
            .replace(/\r\n/g, '\n')
            .replace(CONTROL_CHARACTERS, escapeControl)
            .split('\n');

        const head = `${created.toISOString()} ${label} [${msg.group}/${msg.origin}] ${lines[0]}`;
        return lines.length === 1 ? head : [ head, ...lines.slice(1).map(line => `    ${line}`) ].join('\n');
    }

    public write(msg: LogMessage): void {
        // A subscriber that throws is rethrown by RxJS as an uncaught exception, which shuts
        // the server down - printing a log line is never worth that.
        try {
            if (!ConsoleLog.shouldPrint(msg, this.options)) return;
            const line = ConsoleLog.format(msg);
            if (msg.level <= LogLevel.Warn) {
                this.writer.err(line);
            } else {
                this.writer.out(line);
            }
        } catch {
            // Nowhere left to report it.
        }
    }

    public attach(source: Observable<LogMessage>): Subscription {
        return source.subscribe(msg => this.write(msg));
    }
}
