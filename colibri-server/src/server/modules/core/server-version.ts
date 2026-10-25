import { readFileSync } from 'fs';

// Read from package.json: a checkout and the Docker image both have it next to dist/.
// 'unknown' if the file cannot be read or its version is not a string.
export const readServerVersion = function (packageJsonPath: string): string {
    try {
        const version: unknown = (JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: unknown }).version;
        return typeof version === 'string' ? version : 'unknown';
    } catch {
        return 'unknown';
    }
};
