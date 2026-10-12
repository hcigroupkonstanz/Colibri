import { Service } from './service.js';

/**
 * @deprecated No current caller reaches these static methods - use a `Service` subclass's
 * own `logError`/`logInfo`/etc. instead, which attaches the right `serviceName`/`groupName`
 * to the log entry. Note `ErrorHandler.initialize()` below still self-registers a `Service`
 * at import time regardless of whether any static method is ever called.
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

ErrorHandler.initialize();
