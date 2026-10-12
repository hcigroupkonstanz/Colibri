import { readFileSync } from 'fs';

// The server's release version, from its package.json: the one file both a checkout and the Docker
// image have next to dist/. 'unknown' if it cannot be read.
export const readServerVersion = function (packageJsonPath: string): string {
    try {
        const version: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8')).version;
        return typeof version === 'string' ? version : 'unknown';
    } catch {
        return 'unknown';
    }
};
