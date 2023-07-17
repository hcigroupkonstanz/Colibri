import { Service } from './service';

export class RedirectConsole extends Service {
    public serviceName = 'NodeJS';
    public groupName = 'core';

    public constructor() {
        super();

        const oldDebug = console.debug;
        console.debug = (msg) => {
            this.logDebug(msg);
            oldDebug(msg);
        };

        const oldLog = console.log;
        console.log = (msg) => {
            this.logInfo(msg);
            oldLog(msg);
        };

        const oldWarn = console.warn;
        console.warn = (msg) => {
            this.logWarning(msg);
            oldWarn(msg);
        };

        const oldError = console.error;
        console.error = (msg) => {
            this.logError(msg);
            oldError(msg);
        };
    }
}
