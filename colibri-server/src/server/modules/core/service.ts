import { Observable, Subject } from 'rxjs';
import { LogMessage, LogLevel, Metadata } from './log-message';

export abstract class Service {
    public static readonly Current: Service[] = [];

    protected outputStream$: Subject<LogMessage> = new Subject<LogMessage>();

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

    public get output$(): Observable<LogMessage> {
        return this.outputStream$.asObservable();
    }

    public abstract get serviceName(): string;
    public abstract get groupName(): string;

    public constructor() {
        Service.Current.push(this);
    }

    // eslint-disable-next-line no-empty-function
    public async init() { }

    private outputMsg(lvl: LogLevel, msg: string, metadata: Metadata): void {
        this.outputStream$.next({
            origin: this.serviceName,
            group: this.groupName,
            level: lvl,
            message: msg,
            created: new Date(),
            metadata
        });
    }
}
