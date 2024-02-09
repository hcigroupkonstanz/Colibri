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

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        console.debug = (...args: any[]) => {
            this.consoleDebug(...args);
            this.sendMessage('debug', args);
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        console.log = (...args: any[]) => {
            this.consoleLog(...args);
            this.sendMessage('info', args);
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        console.info = (...args: any[]) => {
            this.consoleInfo(...args);
            this.sendMessage('info', args);
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        console.warn = (...args: any[]) => {
            this.consoleWarn(...args);
            this.sendMessage('warn', args);
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        console.error = (...args: any[]) => {
            this.consoleError(...args);
            this.sendMessage('error', args);
        };
    }

    private sendMessage(
        level: 'error' | 'warn' | 'info' | 'debug',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        args: any[]
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
        return obj.message + '\n' + obj.stack;
    }

    if (typeof obj === 'string') return obj as string;

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
