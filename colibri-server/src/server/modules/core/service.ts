import { Observable, Subject } from 'rxjs';
import { LogMessage, LogLevel, Metadata } from './log-message.js';

export abstract class Service {
    public static readonly Current: Service[] = [];

    // Every instance's log calls publish here directly, instead of a consumer (WebLog)
    // snapshotting Service.Current at its own init() time and merging each instance's own
    // output$ - that snapshot missed any service constructed after the consumer's init()
    // ran. A single static bus makes coverage independent of construction order.
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
