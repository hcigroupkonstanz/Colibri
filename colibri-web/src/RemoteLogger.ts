import { Colibri } from './Colibri';
import { whenColibriCreated } from './lifecycle';

type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/**
 * How many lines logged before `new Colibri()` are kept, to be sent once it exists. The first ones
 * are kept rather than the latest, since the first thing that went wrong at startup is usually
 * the cause of the rest; past this, lines are only counted, and the count is sent instead.
 */
const MAX_EARLY_LINES = 100;

export class RemoteLogger {
    // The instance whose patches are on the console. Every later instance shares it rather than
    // patching again: a second set of patches wrapped the first, so every line was forwarded once
    // per RemoteLogger - and React's StrictMode, a hot reload or a component's constructor creates
    // one more without anyone meaning to. Static rather than per instance so that there is one for
    // the whole page, as there is one console.
    private static patched: RemoteLogger | null = null;

    // The RemoteLogger that forwards for this one: itself, or the one that patched the console.
    private readonly forwarder: RemoteLogger;
    // Whether the console was already patched when another RemoteLogger was created; said once.
    private hasWarnedOfAnotherInstance = false;

    private readonly consoleDebug = console.debug;
    private readonly consoleLog = console.log;
    private readonly consoleInfo = console.info;
    private readonly consoleWarn = console.warn;
    private readonly consoleError = console.error;

    // Set while a line is being forwarded. Anything logged in the meantime - by Colibri, by a
    // getter JSON.stringify ran - goes to the console only. Forwarding that as well is how
    // `new RemoteLogger()` before `new Colibri()` overflowed the stack on the first line: the
    // forward warned that Colibri did not exist yet, through console.warn, which forwarded...
    private forwarding = false;

    private readonly earlyLines: { level: LogLevel; message: string }[] = [];
    private droppedEarlyLines = 0;
    private waitingForColibri = false;

    /**
     * @deprecated use new class constructor directly
     */
    public static init(enabled: boolean = true) {
        return new RemoteLogger(enabled);
    }

    /**
     * Forwards everything logged through `console` to the server's log. Create one, at startup.
     *
     * A second one does not patch the console again: it warns once, and from then on controls the
     * first - its `enabled`, `enable()` and `disable()` switch the one forwarding there is.
     * @param enabled whether to forward from the start
     */
    public constructor(private enabled: boolean = true) {
        const patched = RemoteLogger.patched;
        if (patched) {
            this.forwarder = patched;
            patched.enabled = enabled;
            if (!patched.hasWarnedOfAnotherInstance) {
                patched.hasWarnedOfAnotherInstance = true;
                console.warn(
                    'RemoteLogger: the console is already forwarded by an earlier new RemoteLogger(), so this ' +
                        'one controls that instead of forwarding every line a second time. Create one, at startup.'
                );
            }
            return;
        }

        RemoteLogger.patched = this;
        this.forwarder = this;

        // intercept calls from console

        console.debug = (...args: unknown[]) => {
            this.consoleDebug(...args);
            this.sendMessage('debug', args);
        };

        console.log = (...args: unknown[]) => {
            this.consoleLog(...args);
            this.sendMessage('info', args);
        };

        console.info = (...args: unknown[]) => {
            this.consoleInfo(...args);
            this.sendMessage('info', args);
        };

        console.warn = (...args: unknown[]) => {
            this.consoleWarn(...args);
            this.sendMessage('warn', args);
        };

        console.error = (...args: unknown[]) => {
            this.consoleError(...args);
            this.sendMessage('error', args);
        };
    }

    private sendMessage(level: LogLevel, args: unknown[]) {
        if (!this.enabled || this.forwarding) return;

        this.forwarding = true;
        try {
            const message = [...args].map(stringify).join().trim();

            // Not SendMessage: without an instance it warns through console.warn, which is us.
            const colibri = Colibri.getInstance(false);
            if (colibri) colibri.sendMessage('log', level, message);
            else this.keepUntilColibriExists(level, message);
        } catch (error) {
            // Forwarding is a side effect of logging. It must never be the reason a console.log
            // throws into the code that called it - the line itself has already been printed.
            this.consoleError('RemoteLogger: could not forward a log line.', error);
        } finally {
            this.forwarding = false;
        }
    }

    private keepUntilColibriExists(level: LogLevel, message: string) {
        if (this.earlyLines.length >= MAX_EARLY_LINES) {
            this.droppedEarlyLines++;
            return;
        }

        this.earlyLines.push({ level, message });
        if (!this.waitingForColibri) {
            this.waitingForColibri = true;
            whenColibriCreated(colibri => {
                this.sendEarlyLines(colibri);
            });
        }
    }

    // Socket.IO holds whatever is sent before the connection is up and sends it on connect, so
    // these go out once connected without waiting for that here.
    private sendEarlyLines(colibri: Colibri) {
        this.waitingForColibri = false;

        for (const { level, message } of this.earlyLines.splice(0)) {
            colibri.sendMessage('log', level, message);
        }

        if (this.droppedEarlyLines > 0) {
            colibri.sendMessage(
                'log',
                'warn',
                `RemoteLogger: ${this.droppedEarlyLines} more line(s) logged before new Colibri() were not kept, only the first ${MAX_EARLY_LINES}.`
            );
            this.droppedEarlyLines = 0;
        }
    }

    public enable() {
        this.forwarder.enabled = true;
    }

    public disable() {
        this.forwarder.enabled = false;
    }
}

const stringify = (obj: unknown): string => {
    if (obj instanceof Error) {
        return obj.message + '\n' + (obj.stack ?? '');
    }

    if (typeof obj === 'string') return obj;

    const cache: unknown[] = [];
    let str: string;
    try {
        str = JSON.stringify(
            obj,
            (_, value: unknown) => {
                // JSON has no BigInt, and JSON.stringify throws on one rather than skipping it.
                if (typeof value === 'bigint') return value.toString();
                if (typeof value === 'object' && value !== null) {
                    if (cache.indexOf(value) !== -1) {
                        // Circular reference found, discard key
                        return;
                    }
                    // Store value in our collection
                    cache.push(value);
                }
                return value;
            },
            2
        );
    } catch {
        // Whatever else JSON cannot encode, such as a toJSON() that throws: say what it is.
        str = String(obj);
    }
    return str;
};
