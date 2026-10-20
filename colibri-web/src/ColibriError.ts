import { CustomError } from 'ts-custom-error';

/** Base class of colibri-web's errors, such as an invalid address or port. */
export class ColibriError extends CustomError {}

/**
 * Reported when this client and the server do not speak the same wire protocol. The fix is to run
 * matching `colibri-web` and `colibri-server` versions.
 *
 * Check `fatal` first. Both kinds are reported on `Colibri.protocolMismatch`:
 *
 * - `fatal: true`: the server refused this client and disconnected it. Terminal. There is no
 *   negotiation, so reconnecting cannot succeed, and `Colibri` stops Socket.IO from retrying.
 * - `fatal: false`: the server is suspected to predate colibri-server 2.0.0, because it never
 *   announced its protocol version. The connection stays up. Upgrade the server when you can.
 */
export class ProtocolMismatchError extends ColibriError {
    public constructor(
        message: string,
        /**
         * Wire protocol version the server speaks, like `'2'`, not a release version. The server
         * reports it on refusal, and it is `'unknown'` if the refusal did not say. When not `fatal`
         * it is inferred: a server that never announced itself is taken to speak `'1'`.
         */
        public readonly serverVersion: string,
        /** Wire protocol version this client announced in its handshake. */
        public readonly clientVersion: string,
        /** Whether the connection is gone. False when the server is only suspected to be old. */
        public readonly fatal: boolean = true
    ) {
        super(message);
    }
}
