import { ColibriError } from './ColibriError';

// The "dom" lib declares these as non-optional, but under plain Node (samples, e2e) they are
// absent. Shadowed so the types say so.
declare const window: Window | undefined;

// The default server: the host that served the page. `typeof` rather than `window?.`, since under
// Node `window` is undeclared and reading it throws a ReferenceError.
export const pageHostname = (): string =>
    typeof window !== 'undefined' ? ((window.location as Location | undefined)?.hostname ?? '') : '';

// Every scheme a server address may use, mapped to the socket and REST schemes, which have to
// agree on TLS. http(s) is accepted because a browser's address bar shows it for the same server.
const SCHEMES: Partial<Record<string, { socket: string; rest: string }>> = {
    ws: { socket: 'ws', rest: 'http' },
    http: { socket: 'ws', rest: 'http' },
    wss: { socket: 'wss', rest: 'https' },
    https: { socket: 'wss', rest: 'https' }
};

const parseServerAddress = (server: string) => {
    const address = server.trim();
    const match = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(address);
    const schemes = match ? SCHEMES[match[1].toLowerCase()] : SCHEMES.ws;
    if (!schemes) {
        throw new ColibriError(
            `Unsupported scheme in server address '${server}' - use ws://, wss://, http://, https:// or none.`
        );
    }

    // Trailing slashes come from copying an address bar; they would put the port after the slash.
    const authority = (match ? match[2] : address).replace(/\/+$/, '');
    if (authority.length === 0) {
        throw new ColibriError('Server Address missing or empty!');
    }

    // Rejected rather than dropped: the URLs are host and port only, so a path would land before
    // the port, and dropping it would connect to something other than what was asked for.
    if (/[/?#]/.test(authority)) {
        throw new ColibriError(
            `Server address '${server}' has a path or query after the host - pass only the host and, optionally, the port, e.g. 'http://example.com:9211'.`
        );
    }

    // Host, then an optional port. An IPv6 host is bracketed to tell its colons from the port's.
    const hostAndPort = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(authority);
    if (!hostAndPort) {
        throw new ColibriError(
            `Server address '${server}' is not a host, or a host and a numeric port - an IPv6 address goes in brackets.`
        );
    }

    // `at`: an optional group that did not match is undefined, which indexing's type hides.
    const portText = hostAndPort.at(2);
    return { ...schemes, host: hostAndPort[1], port: portText === undefined ? undefined : Number(portText) };
};

// colibri-server 2.x's default web port. 1.x's was 9011: they differ so that a client of one
// version does not reach a server of the other by default.
const DEFAULT_PORT = 9211;

const checkPort = (port: number) => {
    // isInteger also rejects NaN, which passes the range check below.
    if (!Number.isInteger(port)) {
        throw new ColibriError(`Port must be a whole number (1 - 65535): ${port}`);
    }
    if (port < 1 || port > 65535) {
        throw new ColibriError(`Port out of allowed range (1 - 65535): ${port}`);
    }
};

// Plain JavaScript callers, query strings and environment variables give the port as a string.
// 1.x accepted '9011', so a digit string still means that port; anything else is left for
// checkPort to refuse.
const coercePort = (port: unknown): number | undefined =>
    typeof port === 'string' && /^\s*\d+\s*$/.test(port) ? Number(port) : (port as number | undefined);

// The port may come from the address, from the argument, or from both if they agree. Two
// different ports are a mistake, and picking either would hide it.
const resolvePort = (server: string, fromAddress: number | undefined, given: number | undefined): number => {
    if (given !== undefined) checkPort(given);
    if (fromAddress === undefined) return given ?? DEFAULT_PORT;

    checkPort(fromAddress);
    if (given !== undefined && given !== fromAddress) {
        throw new ColibriError(
            `Server address '${server}' has port ${fromAddress}, but port ${given} was passed as well - give the port once.`
        );
    }
    return fromAddress;
};

export const resolveServer = (app: string, server: string, port: number | undefined) => {
    const address = parseServerAddress(server);
    const resolvedPort = resolvePort(server, address.port, coercePort(port));
    const uri = `${address.socket}://${address.host}:${resolvedPort}`;
    // Encoded like the key in getRestUri; the server decodes it back to the handshake's app name.
    const uriRestApi = `${address.rest}://${address.host}:${resolvedPort}/api/store/${encodeURIComponent(app)}/`;
    return { port: resolvedPort, uri, uriRestApi };
};
