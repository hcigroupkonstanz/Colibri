import { Colibri } from './Colibri';
import { whenColibriCreated } from './lifecycle';

type LogLevel = 'error' | 'warn' | 'info' | 'debug';

// Lines logged before `new Colibri()` are kept up to this many and sent once it exists. The first
// ones are kept, since the first error at startup is usually the cause of the rest; later ones are only counted.
const MAX_EARLY_LINES = 100;

export class RemoteLogger {
    // The instance that patched the console. Later instances delegate to it, since patching again
    // would forward every line once per instance (StrictMode and hot reload create extras).
    private static patched: RemoteLogger | null = null;

    // Itself, or the instance that patched the console.
    private readonly forwarder: RemoteLogger;
    private hasWarnedOfAnotherInstance = false;

    private readonly consoleDebug = console.debug;
    private readonly consoleLog = console.log;
    private readonly consoleInfo = console.info;
    private readonly consoleWarn = console.warn;
    private readonly consoleError = console.error;

    // Recursion guard: lines logged while forwarding (by Colibri, or by a getter that JSON.stringify
    // runs) go to the console only.
    private forwarding = false;

    // Lines logged before `new Colibri()`.
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
     * A further instance warns once and does not patch again; its `enabled` argument, `enable()` and
     * `disable()` act on the first one.
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

            // Not SendMessage(), which warns when there is no instance.
            const colibri = Colibri.getInstance(false);
            if (colibri) colibri.sendMessage('log', level, message);
            else this.keepUntilColibriExists(level, message);
        } catch (error) {
            // Forwarding must not make console.log throw into the caller; the line is already printed.
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

    // Socket.IO buffers emits until connected, so there is no need to wait for the connection.
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

    /** Starts forwarding console output to the server's log. */
    public enable() {
        this.forwarder.enabled = true;
    }

    /** Stops forwarding to the server's log; the console still prints. */
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
                // JSON.stringify throws on a BigInt.
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
        // Anything else JSON cannot encode, e.g. a toJSON() that throws.
        str = String(obj);
    }
    return str;
};
