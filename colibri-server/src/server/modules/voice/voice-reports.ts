import { CONNECTION_LINE } from '../core/log-message.js';
import type { Metadata } from '../core/log-message.js';
import { errorMessage } from '../core/error-message.js';
import { VOICE_HEADER_VERSION } from './voice-packet.js';
import { formatAppId } from './format-app-id.js';

// Packets that are dropped or cannot be relayed come at packet rate (up to ~50/s per voice client),
// so each source or peer is reported at most once per this interval.
export const REPORT_INTERVAL_MILLIS = 10000;
// Sources and peers remembered at a time, so a burst from many addresses cannot grow the maps
// without bound. Once full, new ones go unreported until the next prune.
const REPORT_MAX_KEYS = 100;

// A Unity client's voice often starts 0.1 to 0.2 s before its TCP handshake has registered it, so
// its first packets are dropped (see VoiceAdmission.admit). So are those of a second client at the
// same address until its handshake is in, and those of a voice socket reopened on a new port until
// the old one has been quiet for VOICE_CLIENT_GONE_MILLIS. None of that is worth a warning, so the
// first packet dropped from a source is logged at debug level, and the source is reported as a
// warning only once its packets have been dropped for this long. A source let in before that is
// never reported.
const JOIN_GRACE_MILLIS = 3000;

// A source whose packets VoiceAdmission.admit is dropping (see JOIN_GRACE_MILLIS).
interface Rejection {
    // When its first dropped packet came in.
    readonly since: number;
    // When its latest one did.
    last: number;
}

// The VoiceServer's log methods, so that the reports keep its name as their origin.
interface VoiceReportsCallbacks {
    logDebug(msg: string, metadata?: Metadata): void;
    logInfo(msg: string): void;
    logWarning(msg: string): void;
    logError(msg: string, printStacktrace: boolean): void;
}

// The VoiceServer's reports of the packets it drops or cannot relay, and of its socket errors,
// throttled per source and peer.
export class VoiceReports {
    // Report key -> when it was last reported (see claimReport); pruned every disconnect-check tick.
    private readonly reportedAt = new Map<string, number>();
    // Sources whose packets are being dropped, by voiceClientKey. Removed when the source is let in
    // (forgetRejection), or by pruneReports after REPORT_INTERVAL_MILLIS without a dropped packet.
    // Capped like reportedAt: once full, a new source is neither timed nor reported until a prune.
    private readonly rejections = new Map<string, Rejection>();
    // Trusted proxies already logged as relayed unchecked, so each is logged once. Capped like
    // reportedAt, as TRUSTED_PROXIES may name whole ranges.
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

    // The level to log a packet dropped from `source` at, if any: debug for the first, nothing until
    // the source has been dropped for JOIN_GRACE_MILLIS, then a warning at most once per
    // REPORT_INTERVAL_MILLIS (claimReport). Runs per packet, so the caller builds the message only
    // when there is a level.
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
        // Judged by the latest dropped packet, not the first, so a source that stays dropped is not
        // restarted every REPORT_INTERVAL_MILLIS, which would delay its warning by JOIN_GRACE_MILLIS each time.
        for (const [source, rejection] of this.rejections) {
            if (nowMillis - rejection.last >= REPORT_INTERVAL_MILLIS) {
                this.rejections.delete(source);
            }
        }
    }
}
