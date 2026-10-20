import { Service } from './service.js';
import { PRINTED_TO_CONSOLE } from './console-log.js';

// The original console function prints these lines already; ConsoleLog skips them.
const ECHO = Object.freeze({ [PRINTED_TO_CONSOLE]: true });

/**
 * @deprecated Not instantiated (see the commented-out line in `main.ts`). Kept for redirecting
 * raw `console.*` calls from third-party code to the log stream.
 */
export class RedirectConsole extends Service {
    public serviceName = 'NodeJS';
    public groupName = 'core';

    public constructor() {
        super();

        const oldDebug = console.debug;
        console.debug = (msg) => {
            this.logDebug(msg, ECHO);
            oldDebug(msg);
        };

        const oldLog = console.log;
        console.log = (msg) => {
            this.logInfo(msg, ECHO);
            oldLog(msg);
        };

        const oldWarn = console.warn;
        console.warn = (msg) => {
            this.logWarning(msg, ECHO);
            oldWarn(msg);
        };

        const oldError = console.error;
        console.error = (msg) => {
            // No stack trace: console.error prints the stack of an Error argument itself.
            this.logError(msg, false, ECHO);
            oldError(msg);
        };
    }
}
