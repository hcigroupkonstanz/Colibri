import { Service } from '../core/service.js';
import type { ConnectionPool } from './connection-pool.js';
import type { NetworkMessage } from '../protocol/network.js';

// Per-line cap: RemoteLogger sends whatever the app logs, and every line is printed and kept in
// the admin UI history (WebLog).
export const MAX_CLIENT_LOG_CHARS = 8 * 1024;

const truncate = function (text: string): string {
    if (text.length <= MAX_CLIENT_LOG_CHARS) return text;
    return `${text.slice(0, MAX_CLIENT_LOG_CHARS)} [... ${text.length - MAX_CLIENT_LOG_CHARS} more characters]`;
};

export class ClientLogger extends Service {
    public get serviceName(): string { return 'ClientLogger'; }
    public get groupName(): string { return 'hook'; }

    /**
     * The text of a log message. Unity sends the log channel as raw utf8; a Socket.IO client sends a
     * JS value, whose asString() is JSON with quotes and escaped newlines, so a string value is unwrapped.
     */
    public static readLogText(msg: NetworkMessage): string {
        try {
            const value = msg.payload?.asValue();
            if (typeof value === 'string') return value;
        } catch {
            // Not JSON: raw text from a TCP client, which asString() returns as is.
        }
        return msg.payload?.asString() ?? '';
    }

    public constructor(pool: ConnectionPool) {
        super();

        pool.onMessage(m => m.channel === 'log', m => {
            const name = m.origin?.name || 'UNKNOWN';
            const metadata = {
                clientApp: m.origin?.app || 'UNKNOWN',
                clientName: m.origin?.name || 'UNKNOWN',
                clientId: m.origin?.id || 'UNKNOWN',
            };

            const text = truncate(ClientLogger.readLogText(m));

            switch (m.command) {
                case 'info':
                    this.logInfo(`[${name}] ${text}`, metadata);
                    break;

                case 'warn':
                case 'warning':
                    this.logWarning(`[${name}] ${text}`, metadata);
                    break;

                case 'error':
                    this.logError(`[${name}] ${text}`, false, metadata);
                    break;

                case 'debug':
                default:
                    this.logDebug(`[${name}] ${text}`, metadata);
                    break;
            }
        });
    }
}
