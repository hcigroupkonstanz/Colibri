import type { LogMessage } from '../../services/log.service';

export const LEVEL_TAGS: ReadonlyArray<string> = [ 'ERR', 'WRN', 'INF', 'DBG' ];

// Nord frost and aurora, lightened so an app's name keeps 4.5:1 on its 10% tint over the log rows.
// No red or yellow: those mean errors and warnings.
const APP_COLORS = [ '#96cad8', '#b6cda3', '#d4b9cf', '#ebb7a2', '#abc3dc' ];

export interface LogSource {
    /** The client's app, for a client's line or a server line about a client. */
    app?: string;
    /** The client's name, which is the IP address for a Socket.IO client. */
    client?: string;
    /** The server part that logged the line, as the console shows it: group/service. */
    server: string;
}

const text = function (value: unknown): string | undefined {
    return typeof value === 'string' && value !== '' && value !== 'UNKNOWN' ? value : undefined;
};

/**
 * Whether a client's name is an IP address, as a web client's is. Web clients on one machine, or
 * behind one Docker port with no trusted proxy, all share the address.
 */
export const isAddress = function (name: string): boolean {
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(name) || (name.includes(':') && /^[\da-f:.]+$/i.test(name));
};

/** The start of a client's id, enough to tell apart the clients of one app. */
export const shortId = function (id: string): string {
    return id.slice(0, 6);
};

export const sourceOf = function (log: LogMessage): LogSource {
    return {
        app: text(log.metadata?.['clientApp']),
        client: text(log.metadata?.['clientName']),
        server: log.group && log.origin ? `${log.group}/${log.origin}` : log.group || log.origin
    };
};

/**
 * The line without the `[name] ` the server puts in front of a client's line: the page shows the
 * client in a column of its own.
 */
export const messageText = function (log: LogMessage): string {
    const name = log.metadata?.['clientName'];
    if (typeof name === 'string') {
        const prefix = `[${name}] `;
        if (log.message.startsWith(prefix)) return log.message.slice(prefix.length);
    }
    return log.message;
};

/** Hashed from the name, so every view gives an app the same colour. */
export const appColor = function (app: string): string {
    // FNV-1a: names that differ in one character get different hashes.
    // Five colours means some apps still share one.
    let hash = 0x811c9dc5;
    for (let i = 0; i < app.length; i++) {
        hash = Math.imul(hash ^ app.charCodeAt(i), 0x01000193);
    }
    return APP_COLORS[(hash >>> 0) % APP_COLORS.length];
};

/** Whether the line contains `search` in its message, source or client id. `search` must be lower case. */
export const matchesSearch = function (log: LogMessage, search: string): boolean {
    if (log.reconnect) return false;
    if (log.message.toLowerCase().includes(search)) return true;
    const source = sourceOf(log);
    return [ source.app, source.client, source.server, text(log.metadata?.['clientId']) ].some(part => part?.toLowerCase().includes(search));
};

export interface TextPart {
    text: string;
    match: boolean;
}

/** Splits `value` around each match of `search`, which must be lower case. */
export const highlight = function (value: string, search: string): TextPart[] {
    const lower = value.toLowerCase();
    // toLowerCase changes the length of a few characters, which would shift every later index.
    if (!search || lower.length !== value.length) return [ { text: value, match: false } ];

    const parts: TextPart[] = [];
    let from = 0;
    for (let at = lower.indexOf(search); at !== -1; at = lower.indexOf(search, at + search.length)) {
        if (at > from) parts.push({ text: value.slice(from, at), match: false });
        parts.push({ text: value.slice(at, at + search.length), match: true });
        from = at + search.length;
    }
    if (from < value.length) parts.push({ text: value.slice(from), match: false });
    return parts;
};
