import { mkdir, rm, writeFile } from 'fs/promises';
import * as path from 'path';
import { PRINTED_TO_CONSOLE } from './console-log.js';
import { Service } from './service.js';

const RULE = '='.repeat(80);

// The uid of the Docker image's node user, which owns /srv/colibri/data in the image.
const IMAGE_UID = 1000;

/**
 * Checks once, at startup, that the server can write to DATA_ROOT, and says so loudly on stderr
 * when it cannot.
 *
 * Nothing else would: the REST store answers `PUT` with 201 from memory and only fails when the
 * debounced save runs, and a voice recording only fails when it is saved. In Docker this is the
 * normal way to get it wrong - the server runs as uid 1000, while a host directory that Docker
 * creates for a bind mount, or the data/ that colibri-server 1.x left behind, belongs to root.
 * The server keeps running either way; it just cannot keep anything past a restart.
 */
export class DataRootCheck extends Service {
    public get serviceName(): string { return 'DataRoot'; }
    public get groupName(): string { return 'core'; }

    private readonly dataRoot: string;

    public constructor(
        dataRoot: string,
        private readonly printError: (text: string) => void = text => console.error(text)
    ) {
        super();
        // Config.DATA_ROOT keeps the trailing slash of its default; the advice reads better without.
        this.dataRoot = path.resolve(dataRoot);
    }

    /** Whether DATA_ROOT can be written. Creates it if it is missing; never throws. */
    public async check(): Promise<boolean> {
        const error = await DataRootCheck.probe(this.dataRoot);
        if (!error) return true;

        this.printError(DataRootCheck.describe(this.dataRoot, error, process.getuid?.(), process.getgid?.()));
        // The banner above is for `docker logs`; this line is for the admin UI's log, so the
        // console sink is told to leave it out rather than print the same news twice.
        this.logError(
            `DATA_ROOT is not writable: ${this.dataRoot} (${error.message}). Nothing will be saved: ` +
            'store.json and voice recordings stay in memory until the server stops.',
            false,
            { [PRINTED_TO_CONSOLE]: true }
        );
        return false;
    }

    /** Writes and removes a file in `dir`, returning what went wrong, if anything. */
    public static async probe(dir: string): Promise<Error | undefined> {
        const probeFile = path.join(dir, `.colibri-write-check-${process.pid}`);
        try {
            await mkdir(dir, { recursive: true });
            await writeFile(probeFile, '');
        } catch (err) {
            return err instanceof Error ? err : new Error(String(err));
        }
        // It could be written, which is all that was asked; a leftover probe file is harmless.
        await rm(probeFile, { force: true }).catch(() => undefined);
        return undefined;
    }

    public static describe(dir: string, error: Error, uid: number | undefined, gid: number | undefined): string {
        const lines = [
            RULE,
            `DATA_ROOT is not writable: ${dir}`,
            `  ${error.message}`,
            '',
        ];

        if (uid === undefined) {
            lines.push(
                'This server cannot save anything there: store.json and voice recordings stay in',
                'memory and are lost when it stops. It keeps running anyway.',
            );
        } else {
            lines.push(
                `This server runs as uid ${uid} (gid ${gid ?? '?'}) and cannot save anything there:`,
                'store.json and voice recordings stay in memory and are lost when it stops.',
                'It keeps running anyway.',
            );
        }

        lines.push('', ...DataRootCheck.advise(dir, (error as NodeJS.ErrnoException).code, uid, gid), RULE);
        return lines.join('\n');
    }

    // By error code: this used to advise `chown -R` whatever went wrong, which does nothing for
    // a read-only mount, a file where the directory should be, or a full disk.
    private static advise(dir: string, code: string | undefined, uid: number | undefined, gid: number | undefined): string[] {
        switch (code) {
            case 'EACCES':
            case 'EPERM':
                if (uid === undefined) {
                    return [ 'Fix: make that directory writable for the user running the server, then restart it.' ];
                }
                return [
                    `Fix: give the directory to uid ${uid}, then restart the server:`,
                    `    chown -R ${uid}:${gid ?? uid} ${dir}`,
                    // A new named volume takes the owner of what the image has at the mount
                    // point, the node user. It used to be offered to every uid, but for any other
                    // (docker run --user 1001, say) it is just as unwritable as the directory.
                    ...(uid === IMAGE_UID ? [
                        `With Docker, run that on the host directory mounted at ${dir}, or mount a`,
                        'named volume there instead of a host directory (-v colibri-data:<that path>).',
                    ] : [
                        `With Docker, run that on the host directory mounted at ${dir}.`,
                        `A named volume would not help: a new one belongs to uid ${IMAGE_UID} (the image's`,
                        `node user), not to uid ${uid}.`,
                    ]),
                ];
            case 'EROFS':
                return [
                    'Fix: it is on a read-only file system. Mount something writable there (with',
                    'Docker: drop ":ro" from the volume mounted there), or point DATA_ROOT at a',
                    'writable directory, then restart the server.',
                ];
            case 'ENOTDIR':
            case 'EEXIST':
                return [
                    'Fix: that path, or one of the directories above it, is a file, not a directory.',
                    'Move the file out of the way or point DATA_ROOT at a directory, then restart the',
                    'server. With Docker, check that what is mounted there is a directory.',
                ];
            case 'ENOSPC':
            case 'EDQUOT':
                return [
                    'Fix: the disk (or the disk quota) it is on is full. Free some space there, then',
                    'restart the server. Voice recordings (rec_*.wav) are saved there too.',
                ];
            default:
                return [
                    'Fix: make sure that path is a directory, and that the user running the server',
                    'can write to it, or point DATA_ROOT at one that is. Then restart the server.',
                ];
        }
    }
}
