import { format } from 'util';
import { BuildInfo, describeBuild } from './build-info.js';
import { Service } from './service.js';

export interface ShutdownStep {
    /** Named in the log if stopping it fails. */
    name: string;
    stop: () => void | Promise<void>;
}

/**
 * What main.ts says about the process itself, and how it shuts it down: logs why, runs each
 * shutdown step in order, then exits.
 *
 * Its lines go through the service log like any other service's, so the console shows them as
 * `<timestamp> <LEVEL> [core/Server] ...` and the admin UI's log has them too. main.ts used to
 * print them with console.log and console.error: 'Received SIGTERM, shutting down...' was the
 * one line in `docker logs` without a timestamp, level or source.
 */
export class ServerProcess extends Service {
    public get serviceName(): string { return 'Server'; }
    public get groupName(): string { return 'core'; }

    private shuttingDown = false;
    private exited = false;

    /**
     * @param steps run in this order by {@link shutdown}.
     * @param timeoutMillis how long the steps may take together. If one wedges (a socket that
     * will not close, a hung fs write) the process must still go away, or `docker stop` waits
     * out its grace period and kills it anyway.
     * @param exit ends the process; tests pass something else.
     */
    public constructor(
        private readonly steps: ShutdownStep[],
        private readonly timeoutMillis: number,
        private readonly exit: (code: number) => void = code => process.exit(code)
    ) {
        super();
    }

    /** Logs which server this is: `Colibri 2.0.0, commit 1a2b3c4d5e (with uncommitted changes)`. */
    public reportStart(version: string, build: BuildInfo): void {
        this.logInfo(`Colibri ${version}, ${describeBuild(build)}`);
    }

    /** Logs a warning about the process, such as a setting that has no effect. */
    public reportWarning(text: string): void {
        this.logWarning(text);
    }

    /** Logs `err` (with its stack, if it has one) as an error, after `what: `. */
    public reportError(what: string, err: unknown): void {
        this.logError(format('%s:', what, err), false);
    }

    /**
     * Logs `<reason>, shutting down...`, runs every step, and exits with `exitCode`. Only the
     * first call does anything: SIGTERM and SIGINT can both arrive (an operator pressing Ctrl+C
     * right after `docker stop`), and a crash can follow a signal.
     *
     * Each step is isolated: a signal or crash arriving before startup finished leaves some
     * services unstarted, and one failing step must not skip the steps behind it, least of all
     * the one that writes the store's pending changes.
     */
    public async shutdown(reason: string, exitCode: number): Promise<void> {
        if (this.shuttingDown) return;
        this.shuttingDown = true;

        if (exitCode === 0) {
            this.logInfo(`${reason}, shutting down...`);
        } else {
            this.logError(`${reason}, shutting down...`, false);
        }

        const watchdog = setTimeout(() => {
            this.logError(`Shutdown did not complete within ${this.timeoutMillis}ms, exiting`, false);
            this.end(exitCode);
        }, this.timeoutMillis);
        watchdog.unref();

        for (const step of this.steps) {
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
