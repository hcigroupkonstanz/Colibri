import type { Observable } from 'rxjs';
import { Subject } from 'rxjs';
import type { LogMessage, Metadata } from './log-message.js';
import { LogLevel } from './log-message.js';

export abstract class Service {
    public static readonly Current: Service[] = [];

    // One static bus, so a subscriber to output$ also gets logs from services built after it subscribed.
    private static readonly logBus$ = new Subject<LogMessage>();
    public static readonly output$: Observable<LogMessage> = Service.logBus$.asObservable();

    protected logDebug(msg: string, metadata: Metadata = {}): void {
        this.outputMsg(LogLevel.Debug, msg, metadata);
    }

    protected logInfo(msg: string, metadata: Metadata = {}): void {
        this.outputMsg(LogLevel.Info, msg, metadata);
    }

    protected logWarning(msg: string, metadata: Metadata = {}): void {
        this.outputMsg(LogLevel.Warn, msg, metadata);
    }

    protected logError(msg: string, printStacktrace: boolean = true, metadata: Metadata = {}): void {
        if (printStacktrace) {
            msg += '\n' + new Error().stack;
        }
        this.outputMsg(LogLevel.Error, msg, metadata);
    }

    public abstract get serviceName(): string;
    public abstract get groupName(): string;

    public constructor() {
        Service.Current.push(this);
    }

    // eslint-disable-next-line no-empty-function
    public async init() { }

    private outputMsg(lvl: LogLevel, msg: string, metadata: Metadata): void {
        Service.logBus$.next({
            origin: this.serviceName,
            group: this.groupName,
            level: lvl,
            message: msg,
            created: new Date(),
            metadata
        });
    }
}
