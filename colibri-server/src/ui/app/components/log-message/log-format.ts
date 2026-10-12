import { LogMessage } from '../../services';

export const LEVEL_TAGS: ReadonlyArray<string> = [ 'ERR', 'WRN', 'INF', 'DBG' ];

// Nord frost and aurora, lightened for 4.5:1 on their own tint over every row and card background.
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
 * Whether a client's name is an IP address, as a web client's is. Every web client on one host,
 * or behind one Docker port, has the same.
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

/** The same colour for an app wherever it appears. */
export const appColor = function (app: string): string {
    // FNV-1a: names that differ in one character still get different colours
    let hash = 0x811c9dc5;
    for (let i = 0; i < app.length; i++) {
        hash = Math.imul(hash ^ app.charCodeAt(i), 0x01000193);
    }
    return APP_COLORS[(hash >>> 0) % APP_COLORS.length];
};

/** Whether a line contains the search text, lower case, in its message, source or client id. */
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

/** Splits a text around each occurrence of the search text, ignoring case. */
export const highlight = function (value: string, search: string): TextPart[] {
    const lower = value.toLowerCase();
    // a few characters change length in lower case, which would shift every index after them
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
