import { CustomError } from 'ts-custom-error';

export class ColibriError extends CustomError {}

/**
 * Raised when this client and the server do not agree on the wire protocol. The fix is always
 * to align the `colibri-web` and `colibri-server` versions.
 *
 * Check {@link ProtocolMismatchError.fatal `fatal`} before reacting - the two cases this covers
 * differ in whether there is still a working connection:
 *
 * - `fatal: true` - the server **refused** this client and hung up. Terminal, not transient:
 *   there is no negotiation and no subset both sides can speak, so reconnecting cannot succeed.
 *   `Colibri` stops Socket.IO from retrying when it receives one.
 * - `fatal: false` - the server is **suspected** to predate the version check, inferred from the
 *   absence of a signal only a 2.0.0+ server sends. The connection is live and usable, since the
 *   Socket.IO envelope did not change between v1 and v2, so this is a warning to act on at
 *   leisure and not a reason to tear anything down.
 */
export class ProtocolMismatchError extends ColibriError {
    public constructor(
        message: string,
        /**
         * Protocol version the server speaks - always a wire version like `'1'` or `'2'`, never a
         * release version, so it is comparable with {@link clientVersion} on both paths. Reported
         * by the server when `fatal`, and `'unknown'` if it refused this client without saying
         * what it speaks. When not `fatal` it is **inferred**: a server that never announced
         * itself predates 2.0.0, and every release before that speaks `'1'`.
         */
        public readonly serverVersion: string,
        /** Protocol version this client announced in its handshake. */
        public readonly clientVersion: string,
        /** Whether the connection is gone. See the class doc - a suspicion is not fatal. */
        public readonly fatal: boolean = true
    ) {
        super(message);
    }
}
