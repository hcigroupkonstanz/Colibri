import { Service } from './service.js';

/**
 * Logs through one shared service, 'Internal Error' in group 'core'.
 *
 * @deprecated Use the log methods of your own `Service` subclass instead. Its entries carry
 * its own serviceName and groupName.
 */
export class ErrorHandler extends Service {
    private static _instance: ErrorHandler;

    public serviceName = 'Internal Error';
    public groupName = 'core';

    static initialize(): void {
        this._instance = new ErrorHandler();
    }

    public static logInfo(msg: string): void {
        this._instance.logInfo(msg);
    }

    public static logDebug(msg: string): void {
        this._instance.logDebug(msg);
    }

    public static logWarning(msg: string): void {
        this._instance.logWarning(msg);
    }

    public static logError(msg: string): void {
        this._instance.logError(msg);
    }
}

// Runs on import. The constructor adds the instance to Service.Current, even if no static
// method is ever called.
ErrorHandler.initialize();
