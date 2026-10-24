import { CONNECTION_LINE } from '../core/log-message.js';
import type { Metadata } from '../core/log-message.js';
import { errorMessage } from '../core/error-message.js';
import { VOICE_HEADER_VERSION } from './voice-packet.js';
import { formatAppId } from './format-app-id.js';

// A source sending malformed packets, or a peer that can't be relayed to, fails at packet rate
// (up to ~50/s per voice client), so each is reported at most once per this interval rather
// than once per packet...
export const REPORT_INTERVAL_MILLIS = 10000;
// ...and only this many distinct sources and peers are remembered at a time, so a burst from
// many addresses can't grow the map without bound. Once full, new ones go unreported until
// the next prune frees a slot.
const REPORT_MAX_KEYS = 100;

// A Unity client opens its voice socket and its TCP connection at about the same time, and its
// voice often starts a moment (0.1 to 0.2 s) before the TCP handshake has registered it. Its first
// packets are dropped then (see VoiceServer.admit), as are those of a second client at the same
// address until its own handshake is in, and those of a voice socket opened again on a new port
// until the old one has been quiet for VOICE_CLIENT_GONE_MILLIS. Each of those used to be a
// warning, the first at every client start. Now the first packet dropped from a source is logged at
// debug level only, and the source is reported as a warning once its packets have been dropped for
// this long. One let in before that is never reported, and its next drop starts over.
const JOIN_GRACE_MILLIS = 3000;

// A source whose packets admit drops, while it does (see JOIN_GRACE_MILLIS).
interface Rejection {
    // When its first dropped packet came in.
    readonly since: number;
    // When its latest one did.
    last: number;
}

// What VoiceReports needs from the VoiceServer that owns it: its log methods, so that the reports
// keep its name as their origin.
interface VoiceReportsCallbacks {
    logDebug(msg: string, metadata?: Metadata): void;
    logInfo(msg: string): void;
    logWarning(msg: string): void;
    logError(msg: string, printStacktrace: boolean): void;
}

// The VoiceServer's reports of the packets it drops or cannot relay, and of its socket errors,
// throttled per source and peer. One for the server's lifetime: all of them share REPORT_MAX_KEYS.
export class VoiceReports {
    // Report key (see reportMalformedPacket and reportRelayFailure) -> when it was last
    // reported. See REPORT_INTERVAL_MILLIS; pruned every disconnect-check tick.
    private readonly reportedAt = new Map<string, number>();
    // The sources whose packets admit drops, by voiceClientKey (see JOIN_GRACE_MILLIS). One is
    // forgotten once it is let in, or by pruneReports once none of its packets has been dropped for
    // REPORT_INTERVAL_MILLIS. Bounded by REPORT_MAX_KEYS, as reportedAt: once full, a new source is
    // neither timed nor reported until the next prune frees a slot.
    private readonly rejections = new Map<string, Rejection>();
    // The trusted proxies whose voice has been said to be relayed unchecked, so it is said once for
    // each. Bounded by REPORT_MAX_KEYS, as TRUSTED_PROXIES may name whole ranges.
    private readonly uncheckedProxies = new Set<string>();

    public constructor(private readonly callbacks: VoiceReportsCallbacks) {}

    public reportNoUnityClient(source: string, address: string, appId: number, nowMillis: number): void {
        const level = this.rejectionReport(source, nowMillis);
        if (level) this.logRejection(level, source, appId, `no Unity client of that app is connected from ${address}`);
    }

    public reportNoRoom(source: string, address: string, appId: number, unityClients: number, nowMillis: number): void {
        const level = this.rejectionReport(source, nowMillis);
        if (level) this.logRejection(level, source, appId, `${address} has ${unityClients} Unity client(s) of that app, and as many voice clients already`);
    }

    // `source` has been let in: its next dropped packet starts over (see JOIN_GRACE_MILLIS).
    public forgetRejection(source: string): void {
        this.rejections.delete(source);
    }

    // How a packet admit has dropped from `source` is to be logged, if at all (see JOIN_GRACE_MILLIS):
    // the first one of the source at debug level, then nothing until they have been dropped for
    // JOIN_GRACE_MILLIS, then as a warning at most once per REPORT_INTERVAL_MILLIS (claimReport).
    // Called at packet rate, so the message is built only when there is one to log.
    private rejectionReport(source: string, nowMillis: number): 'debug' | 'warning' | undefined {
        const rejection = this.rejections.get(source);
        if (!rejection) {
            if (this.rejections.size >= REPORT_MAX_KEYS) return undefined;
            this.rejections.set(source, { since: nowMillis, last: nowMillis });
            return 'debug';
        }
        rejection.last = nowMillis;
        if (nowMillis - rejection.since < JOIN_GRACE_MILLIS) return undefined;
        return this.claimReport(source, nowMillis) ? 'warning' : undefined;
    }

    private logRejection(level: 'debug' | 'warning', source: string, appId: number, reason: string): void {
        const message = `Ignoring voice packet from ${source} for app ${formatAppId(appId)}: ${reason}`;
        if (level === 'warning') {
            this.callbacks.logWarning(`${message} (further ones from this source are not reported for ${REPORT_INTERVAL_MILLIS / 1000}s)`);
            return;
        }
        // Routine while a Unity client connects, hence a connection line.
        this.callbacks.logDebug(`${message} (reported as a warning if this goes on for ${JOIN_GRACE_MILLIS / 1000}s: `
            + 'a Unity client\'s voice can start before its TCP handshake is in)', CONNECTION_LINE);
    }

    public reportUncheckedProxy(address: string): void {
        if (this.uncheckedProxies.has(address) || this.uncheckedProxies.size >= REPORT_MAX_KEYS) return;
        this.uncheckedProxies.add(address);

        this.callbacks.logInfo(`Relaying voice from ${address} unchecked: it is in TRUSTED_PROXIES, and voice through a proxy cannot be matched `
            + 'to a Unity client\'s address. Logged once per address.');
    }

    public reportMalformedPacket(source: string, reason: string, nowMillis: number): void {
        if (!this.claimReport(source, nowMillis)) return;

        this.callbacks.logError(`Ignoring malformed voice packet from ${source}: ${reason}`
            + ` (further ones from this source are not reported for ${REPORT_INTERVAL_MILLIS / 1000}s)`, false);
    }

    public reportV1Packet(source: string, nowMillis: number): void {
        if (!this.claimReport(source, nowMillis)) return;

        this.callbacks.logWarning(`Ignoring voice packet from ${source}: it looks like a Colibri 1.x client (its voice header has no app), `
            + `but this server speaks voice header v${VOICE_HEADER_VERSION}. Upgrade the Colibri Unity package (de.uni.kn.colibri) in that app to 2.x`
            + ` (further ones from this source are not reported for ${REPORT_INTERVAL_MILLIS / 1000}s)`);
    }

    // `target`: the peer's voiceClientKey.
    public reportRelayFailure(target: string, err: unknown, nowMillis: number): void {
        // Keyed apart from the peer's own malformed packets, so neither report hides the other.
        if (!this.claimReport(`relay to ${target}`, nowMillis)) return;

        this.callbacks.logError(`Failed to relay voice packet to ${target}: ${errorMessage(err)}`
            + ` (further failures for this peer are not reported for ${REPORT_INTERVAL_MILLIS / 1000}s)`, false);
    }

    // True, and remembers the time, if `key` may be reported now: at most once per
    // REPORT_INTERVAL_MILLIS, and only while fewer than REPORT_MAX_KEYS keys are remembered.
    public claimReport(key: string, nowMillis: number): boolean {
        const reportedAt = this.reportedAt.get(key);
        if (reportedAt !== undefined && nowMillis - reportedAt < REPORT_INTERVAL_MILLIS) return false;
        if (reportedAt === undefined && this.reportedAt.size >= REPORT_MAX_KEYS) return false;

        this.reportedAt.set(key, nowMillis);
        return true;
    }

    public pruneReports(nowMillis: number): void {
        for (const [key, reportedAt] of this.reportedAt) {
            if (nowMillis - reportedAt >= REPORT_INTERVAL_MILLIS) {
                this.reportedAt.delete(key);
            }
        }
        // By the latest dropped packet, not the first: a source dropped for good would otherwise
        // start over every REPORT_INTERVAL_MILLIS, and its warning come JOIN_GRACE_MILLIS late each time.
        for (const [source, rejection] of this.rejections) {
            if (nowMillis - rejection.last >= REPORT_INTERVAL_MILLIS) {
                this.rejections.delete(source);
            }
        }
    }
}
