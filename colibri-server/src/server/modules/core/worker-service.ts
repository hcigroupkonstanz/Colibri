import { WorkerMessage } from './worker-message';
import { LogLevel, Metadata } from './log-message';
import * as threads from 'worker_threads';
import { Subject } from 'rxjs';

export interface WorkerLogMessage {
    level: LogLevel;
    msg: string;
    metadata: Metadata;
}

export abstract class WorkerService {
    private readonly parentMessages = new Subject<WorkerMessage>();
    protected readonly parentMessages$ = this.parentMessages.asObservable();

    protected logDebug(msg: string, metadata: Metadata = {}): void {
        this.postMessage('log', {
            level: LogLevel.Debug,
            msg, metadata
        });
    }

    protected logInfo(msg: string, metadata: Metadata = {}): void {
        this.postMessage('log', {
            level: LogLevel.Info,
            msg, metadata
        });
    }

    protected logWarning(msg: string, metadata: Metadata = {}): void {
        this.postMessage('log', {
            level: LogLevel.Warn,
            msg, metadata
        });
    }

    protected logError(msg: string, printStacktrace: boolean = true, metadata: Metadata = {}): void {
        if (printStacktrace) {
            msg += '\n' + new Error().stack;
        }

        this.postMessage('log', {
            level: LogLevel.Error,
            msg, metadata
        });
    }


    protected postMessage(channel: string, content: { [key: string]: unknown }) {
        const msg: WorkerMessage = {
            channel: channel,
            content: content
        };

        if (this.useWorkers) {
            threads.parentPort?.postMessage(msg);
        } else if (process.send) {
            process.send(msg);
        }
    }

    public constructor(private useWorkers: boolean) {
        if (useWorkers) {
            threads.parentPort?.on('message', (msg: WorkerMessage) => {
                this.parentMessages.next(msg);
            });
        } else {
            process.on('message', (msg: WorkerMessage) => {
                this.parentMessages.next(msg);
            });
        }
    }
}
