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

    // Retained so restartWorker() can rebuild the thread after an unexpected exit.
    private workerPath: string | undefined;
    private workerData: unknown;
    // Distinguishes "we asked it to go away" from "it died", so a deliberate shutdown
    // doesn't look like a crash worth restarting.
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

        // Without this, a worker that died took its whole transport down silently: the
        // 'error' log above was the only trace, the process stayed up, and every
        // postMessage from then on went nowhere.
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

    // Called when the worker thread exits without having been asked to. Subclasses that can
    // rebuild their state override this (see TCPServerProxy) and decide whether to
    // restartWorker(); the default is to do nothing beyond the error logged above.
    protected onWorkerExited(): void {
        return;
    }

    // Replaces a dead worker thread with a fresh one on the same path. Any state the worker
    // held is gone - the caller is responsible for re-issuing whatever start message the
    // worker needs and for reconciling whatever the old thread was tracking.
    protected restartWorker(): boolean {
        if (this.workerPath === undefined) return false;

        this.initWorker(this.workerPath, this.workerData);
        return true;
    }

    // Docker's `stop` sends SIGTERM and, after a grace period, SIGKILL - if the worker
    // thread is never explicitly terminated, the process can outlive its own shutdown
    // handler (a worker_threads.Worker keeps the event loop alive on its own).
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
