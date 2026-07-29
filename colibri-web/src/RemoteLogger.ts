import { SendMessage } from './Colibri';

export class RemoteLogger {
    private readonly consoleDebug = console.debug;
    private readonly consoleLog = console.log;
    private readonly consoleInfo = console.info;
    private readonly consoleWarn = console.warn;
    private readonly consoleError = console.error;

    /**
     * @deprecated use new class constructor directly
     */
    public static init(enabled: boolean = true) {
        return new RemoteLogger(enabled);
    }

    public constructor(private enabled: boolean = true) {
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

    private sendMessage(
        level: 'error' | 'warn' | 'info' | 'debug',
        args: unknown[]
    ) {
        if (!this.enabled) return;
        SendMessage('log', level, [...args].map(stringify).join().trim());
    }

    public enable() {
        this.enabled = true;
    }

    public disable() {
        this.enabled = false;
    }
}

const stringify = (obj: unknown): string => {
    if (obj instanceof Error) {
        return obj.message + '\n' + (obj.stack ?? '');
    }

    if (typeof obj === 'string') return obj;

    const cache: unknown[] = [];
    const str = JSON.stringify(
        obj,
        (_, value: unknown) => {
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
    return str;
};
