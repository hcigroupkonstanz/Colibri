import { ProtocolMismatchError } from './ColibriError';

// How long to wait for `colibri`/`protocol::accepted` before concluding the server predates the
// version check. A 2.0.0+ server sends it immediately on connect; the window only covers an
// event-loop stall on a loaded server.
//
// Not inferred from the 100ms `latency` broadcast: 1.2.x and 1.3.x servers send it but speak v1.
const OLD_SERVER_TIMEOUT_MS = 5000;

// The protocol of every release before 2.0.0, none of which announce themselves.
const OLD_SERVER_PROTOCOL_VERSION = '1';

// The "dom" lib declares these as non-optional, but under plain Node (samples, e2e) they are
// absent. Shadowed so the types say so.
declare const document: Document | undefined;

/*
 *  Detecting a server that predates the protocol version check.
 *
 *  Such a server neither refuses this client nor says what it speaks, so a current one
 *  announces itself unprompted and the missing announcement is the signal. The timer only
 *  observes; it does not gate message delivery.
 */
export class OldServerDetector {
    private oldServerTimer: ReturnType<typeof setTimeout> | undefined;
    // Once per instance, not per connection, so a reconnect does not repeat the warning.
    private hasReportedOldServer = false;

    public constructor(
        private readonly clientVersion: string,
        private readonly isConnected: () => boolean,
        private readonly report: (error: ProtocolMismatchError) => void
    ) {}

    public start(): void {
        if (this.hasReportedOldServer) return;

        clearTimeout(this.oldServerTimer);
        this.oldServerTimer = setTimeout(() => {
            this.onServerHelloMissing();
        }, OLD_SERVER_TIMEOUT_MS);
    }

    public stop(): void {
        clearTimeout(this.oldServerTimer);
        this.oldServerTimer = undefined;
    }

    public giveUp(): void {
        this.stop();
        this.hasReportedOldServer = true;
    }

    private onServerHelloMissing(): void {
        // A disconnected socket explains the silence by itself, and a reconnect re-arms this.
        if (!this.isConnected()) return;

        // A frozen or backgrounded tab stops draining the socket while timers keep running, so this
        // can fire ahead of the queued announcement. Wait another window.
        //
        // `typeof` rather than `document?.`: under Node `document` is undeclared, which throws a
        // ReferenceError that optional chaining does not catch.
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
            this.start();
            return;
        }

        this.hasReportedOldServer = true;
        this.stop();

        const error = new ProtocolMismatchError(
            `The server did not identify itself within ${OLD_SERVER_TIMEOUT_MS / 1000}s, so it predates ` +
                `colibri-server 2.0.0 and speaks protocol v1; this client speaks v${this.clientVersion}.`,
            // A protocol version, as in the refusal. Inferred, not received: every 2.0.0+ server
            // announces itself, and everything older speaks v1.
            OLD_SERVER_PROTOCOL_VERSION,
            this.clientVersion,
            false
        );

        // Not disconnected: the Socket.IO envelope is the same in v1 and v2, so the connection works.
        // Tearing it down over a suspicion would turn a warning into an outage.
        console.warn(`Colibri: ${error.message} The connection still works; upgrade the server when you can.`);
        this.report(error);
    }
}
