import { WorkerMessage } from './worker-message.js';
import { Service } from './service.js';
import * as threads from 'worker_threads';
import { Subject } from 'rxjs';
import { LogLevel } from './log-message.js';
import cluster, { Worker } from 'cluster';
import { WorkerLogMessage } from './worker-service.js';

export abstract class WorkerServiceProxy extends Service {
    private threadWorker!: threads.Worker;
    private clusterWorker!: Worker;

    // For restartWorker().
    private workerPath: string | undefined;
    private workerData: unknown;
    // Set by terminateWorker() so a deliberate exit is not treated as a crash.
    private terminating = false;


    private readonly workerMessages = new Subject<WorkerMessage>();
    protected readonly workerMessages$ = this.workerMessages.asObservable();

    public constructor() {
        super();
    }

    protected initCluster(path: string, env?: unknown): void {
        cluster.setupPrimary({
            exec: path
        });
        this.clusterWorker = cluster.fork(env);

        this.clusterWorker.on('online', () => {
            this.logInfo(`Cluster ${path} online`);
        });

        this.clusterWorker.on('close', () => {
            this.logInfo(`Cluster ${path} closed`);
        });

        this.clusterWorker.on('exit', () => {
            this.logInfo(`Cluster ${path} exited`);
        });

        this.clusterWorker.on('message', (data: WorkerMessage) => {
            if (data.channel === 'log') {
                this.handleLogMessage(data.content as unknown as WorkerLogMessage);
            } else {
                this.workerMessages.next(data);
            }
        });
    }

    protected initWorker(path: string, workerData?: unknown): void {
        this.workerPath = path;
        this.workerData = workerData;
        this.terminating = false;
        this.threadWorker = new threads.Worker(path, { workerData: workerData });

        this.threadWorker.on('error', err => {
            this.logError(err.message + '\n' + err.stack, false);
        });

        this.threadWorker.on('exit', code => {
            if (this.terminating) return;

            this.logError(`Worker ${path} exited unexpectedly with code ${code}`, false);
            this.onWorkerExited();
        });

        this.threadWorker.on('online', () => {
            this.logInfo(`Worker ${path} online`);
        });

        this.threadWorker.on('close', () => {
            this.logInfo(`Worker ${path} closed`);
        });

        this.threadWorker.on('message', (data: WorkerMessage) => {
            if (data.channel === 'log') {
                this.handleLogMessage(data.content as unknown as WorkerLogMessage);
            } else {
                this.workerMessages.next(data);
            }
        });
    }

    // Called when the worker exits without terminateWorker(). Override to call restartWorker().
    protected onWorkerExited(): void {
        return;
    }

    // Respawns the worker with the original path and data. The new thread starts without the
    // old one's state, so the caller re-sends its start message. False if initWorker() never ran.
    protected restartWorker(): boolean {
        if (this.workerPath === undefined) return false;

        this.initWorker(this.workerPath, this.workerData);
        return true;
    }

    // A live worker thread keeps the event loop running, so shutdown has to terminate it.
    protected async terminateWorker(): Promise<void> {
        this.terminating = true;
        if (this.threadWorker) {
            await this.threadWorker.terminate();
        }
    }

    protected postMessage(channel: string, content?: { [key: string]: unknown }) {
        const msg: WorkerMessage = {
            channel: channel,
            content: content || {}
        };

        if (this.threadWorker) {
            this.threadWorker.postMessage(msg);
        } else if (this.clusterWorker) {
            this.clusterWorker.send(msg);
        }
    }

    private handleLogMessage(log: WorkerLogMessage): void {
        switch (log.level) {
            case LogLevel.Debug:
                this.logDebug(log.msg, log.metadata);
                break;

            case LogLevel.Info:
                this.logInfo(log.msg, log.metadata);
                break;

            case LogLevel.Warn:
                this.logWarning(log.msg, log.metadata);
                break;

            case LogLevel.Error:
                this.logError(log.msg, false, log.metadata);
                break;

            default:
                this.logWarning('Unknown log level!');
                this.logDebug(log.msg);
                break;
        }
    }
}
