import { format } from 'util';
import type { BuildInfo } from './build-info.js';
import { describeBuild } from './build-info.js';
import { Service } from './service.js';

export interface ShutdownStep {
    /** Named in the log if stopping it fails. */
    name: string;
    stop: () => void | Promise<void>;
}

/** Logs process-level events through the service log and runs the shutdown steps in order before exiting. */
export class ServerProcess extends Service {
    public get serviceName(): string { return 'Server'; }
    public get groupName(): string { return 'core'; }

    private shuttingDown = false;
    private exited = false;

    /**
     * @param steps run in this order by {@link shutdown}.
     * @param timeoutMillis how long the steps may take together before the process exits anyway.
     * @param exit ends the process; tests pass something else.
     */
    public constructor(
        private readonly steps: ShutdownStep[],
        private readonly timeoutMillis: number,
        private readonly exit: (code: number) => void = code => process.exit(code)
    ) {
        super();
    }

    /** Logs version and build, e.g. `Colibri 2.0.0, commit 1a2b3c4d5e (with uncommitted changes)`. */
    public reportStart(version: string, build: BuildInfo): void {
        this.logInfo(`Colibri ${version}, ${describeBuild(build)}`);
    }

    public reportWarning(text: string): void {
        this.logWarning(text);
    }

    /** Logs `err`, with its stack if it has one, as an error after `what: `. */
    public reportError(what: string, err: unknown): void {
        this.logError(format('%s:', what, err), false);
    }

    /** Logs `<reason>, shutting down...`, runs every step and exits with `exitCode`. Only the first call does anything. */
    public async shutdown(reason: string, exitCode: number): Promise<void> {
        // A second signal, or a crash after a signal.
        if (this.shuttingDown) return;
        this.shuttingDown = true;

        if (exitCode === 0) {
            this.logInfo(`${reason}, shutting down...`);
        } else {
            this.logError(`${reason}, shutting down...`, false);
        }

        // A wedged step must not keep the process alive until `docker stop` kills it.
        const watchdog = setTimeout(() => {
            this.logError(`Shutdown did not complete within ${this.timeoutMillis}ms, exiting`, false);
            this.end(exitCode);
        }, this.timeoutMillis);
        watchdog.unref();

        for (const step of this.steps) {
            // A failing step must not skip the steps behind it, least of all the store flush.
            try {
                await step.stop();
            } catch (err) {
                this.reportError(`Error stopping ${step.name}`, err);
            }
        }

        clearTimeout(watchdog);
        this.end(exitCode);
    }

    private end(exitCode: number): void {
        if (this.exited) return;
        this.exited = true;
        this.exit(exitCode);
    }
}
