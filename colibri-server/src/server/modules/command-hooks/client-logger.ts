import { Service } from '../core/index.js';
import { ConnectionPool, NetworkMessage } from './connection-pool.js';

export class ClientLogger extends Service {
    public get serviceName(): string { return 'ClientLogger'; }
    public get groupName(): string { return 'hook'; }

    /**
     * A log line is human-readable text, so it has to reach the admin UI as text rather than as
     * the JSON encoding of a string.
     *
     * colibri-unity sends this one channel as raw utf8 for exactly that reason (see
     * `WebServerConnection.EncodePayload`), and `asString()` hands that straight back. A
     * Socket.IO client cannot do the same - it sends a JS value, so the payload arrives as
     * `Payload.fromValue('text')`, whose `asString()` is `JSON.stringify` and yields `"text"`
     * with the quotes in it and every newline in a stack trace flattened to a literal `\n`.
     * Unwrapping a string value here fixes that for both transports, and for every colibri-web
     * version already published.
     */
    public static readLogText(msg: NetworkMessage): string {
        try {
            const value = msg.payload?.asValue();
            if (typeof value === 'string') return value;
        } catch {
            // Not JSON at all - raw text off the TCP wire, which asString() returns verbatim.
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

            const text = ClientLogger.readLogText(m);

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
