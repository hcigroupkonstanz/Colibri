import { Console } from 'console';
import { Observable, Subscription } from 'rxjs';
import { LogLevel, LogMessage, Metadata } from './log-message.js';

/** Metadata flag for a message its logger already wrote to stdout/stderr; {@link ConsoleLog} skips it. */
export const PRINTED_TO_CONSOLE = 'printedToConsole';

/** Longest message {@link ConsoleLog} prints in full; the rest is cut and counted. */
export const MAX_CONSOLE_MESSAGE_LENGTH = 8192;

export interface ConsoleLogOptions {
    /** Most verbose level printed: Info prints Error, Warn and Info. */
    minLevel: LogLevel;

    /**
     * Whether broadcast traffic (`metadata.broadcastTraffic`) is printed. It is logged at Debug,
     * many times a second per client, so only this decides, never {@link minLevel} (as in the admin UI).
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

// All control characters but tab and newline; a CR, backspace or ANSI escape in a client's log
// line would rewrite the terminal.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

const escapeControl = function (char: string): string {
    return `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`;
};

// Not the global console: RedirectConsole replaces console.* with functions that log back onto
// Service.output$.
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
 * Prints the log messages of `Service.output$` to stdout and stderr, so they reach `docker logs`.
 *
 * One line per message: `<ISO timestamp> <LEVEL> [<group>/<service>] <message>`. Errors and
 * warnings go to stderr, the rest to stdout. Further lines of a message (a stack trace) are
 * indented by four spaces, so nothing a client sends can look like a log line.
 */
export class ConsoleLog {
    public constructor(
        private readonly options: ConsoleLogOptions,
        private readonly writer: ConsoleLogWriter = getDefaultWriter()
    ) { }

    /**
     * Reads `CONSOLE_LOG_LEVEL` (error, warn, info or debug; default info) and
     * `CONSOLE_LOG_BROADCAST_TRAFFIC` (true or false; default false). Throws on an unknown level,
     * naming the variable.
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
        // A throwing subscriber becomes an uncaught exception and stops the server.
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
