import { CONNECTION_LINE, Service } from '../core/index.js';
import * as dgram from 'dgram';
import { AddressInfo, isIPv6 } from 'net';
import { mkdir, writeFile } from 'fs/promises';
import { endianness } from 'os';
import * as path from 'path';
import {
    VOICE_APP_ID_OFFSET,
    VOICE_HEADER_LENGTH,
    VOICE_HEADER_VERSION,
    VOICE_VERSION_AND_CODEC_OFFSET,
    VoiceCodec,
} from './voice-packet.js';
import { TrustProxy, trustNoProxy } from '../networking/trusted-proxies.js';
import { UnityClientAddresses, UnityClientSource, normalizeAddress } from './unity-client-addresses.js';

// Recordings can run for minutes at 48kHz, so a plain number[] would mean millions of
// boxed-double pushes. This keeps samples in a flat Int16Array, growing (doubling) only
// when the current capacity is exhausted, same trade-off as FrameReader's growable buffer.
class GrowableInt16Buffer {
    private data: Int16Array;
    private len = 0;

    public constructor(initialCapacity = 48000) {
        this.data = new Int16Array(initialCapacity);
    }

    public get length(): number {
        return this.len;
    }

    public push(value: number): void {
        if (this.len >= this.data.length) {
            const grown = new Int16Array(this.data.length * 2);
            grown.set(this.data);
            this.data = grown;
        }
        this.data[this.len++] = value;
    }

    public toTypedArray(): Int16Array {
        return this.data.subarray(0, this.len);
    }
}

interface VoiceClient {
    ip: string;
    port: number;
    userId: number;
    appId: number;
    lastSequence: number;
    lastHeartbeat: number;
    frameSize: number; // How many samples are sent at one time
    frameSizeMillis: number;
    codec: VoiceCodec;
    recordingStartDate: Date;
    recordingData: GrowableInt16Buffer;
    // The voice clients of its app let in from its address, itself included (see admit).
    // Undefined for one let in because its address is in TRUSTED_PROXIES: that is neither checked
    // nor limited, so it is dropped only once it goes quiet.
    group: VoiceClientGroup | undefined;
}

// The voice clients of one app let in from one address (normalized). Each has the app's voice sent
// to that address once more, and anyone can add one by forging a source port there, so there are
// never more of them than Unity clients of the app connected from there (see admit).
interface VoiceClientGroup {
    readonly key: string;
    readonly address: string;
    readonly appId: number;
    readonly clients: Set<VoiceClient>;
    // When a Unity client of its app last left its address and left fewer of them than voice
    // clients here, if the extra ones have not been dropped since (see onUnityClientsLeft).
    shrunkAt: number | undefined;
}

// Why a voice packet may be relayed: there is room for its sender among the voice clients of its
// app at its address, or its address is a trusted proxy's.
type Admission = 'unity' | 'proxy';

// A source whose packets admit drops, while it does (see JOIN_GRACE_MILLIS).
interface Rejection {
    // When its first dropped packet came in.
    readonly since: number;
    // When its latest one did.
    last: number;
}

const voiceClientKey = (address: string, port: number): string => `${address}:${port}`;
const groupKey = (address: string, appId: number): string => `${address} ${appId}`;

// A voice client sends a packet every 20 ms while it broadcasts (VoiceBroadcast's default frame).
// One that has sent nothing for this long is taken to be gone when a new sender of its app at its
// address needs its place, as when a Unity client's voice socket is opened again, on a new port.
// Waiting for the 2 s disconnect timeout would cut that client's voice for 2 to 3 s. Taking the
// place of one still sending would let any forged packet take it, and two clients that both send
// would take it from each other at packet rate, cutting their recordings into 20 ms pieces.
// It is also how long after a Unity client leaves the voice clients over those left at its address
// are dropped (see onUnityClientsLeft).
const VOICE_CLIENT_GONE_MILLIS = 500;

// The voice client in `group` that has gone the longest without a packet.
const stalestOf = function (group: VoiceClientGroup): VoiceClient | undefined {
    let stalest: VoiceClient | undefined;
    for (const client of group.clients) {
        if (!stalest || client.lastHeartbeat < stalest.lastHeartbeat) stalest = client;
    }
    return stalest;
};

// What getAppClients hands back for an app with no voice clients.
const NO_CLIENTS: readonly VoiceClient[] = [];

const WAV_HEADER_LENGTH = 44;

/**
 * The 44-byte RIFF header of a mono, 16-bit PCM .wav file holding `dataBytes` bytes of samples.
 *
 * Written by hand because it is all a recording needs: building the file with wavefile
 * (fromScratch, then toBuffer) re-encoded every sample on the main thread, which held up all
 * TCP and Socket.IO relaying for seconds when a long recording was saved.
 */
export const wavHeader = function (samplingRate: number, dataBytes: number): Buffer {
    // The sizes are 32-bit. Past 4 GiB (12 h at 48 kHz) they say "as much as there is", which
    // players read to the end of the file, instead of failing the save and losing it all.
    const size = (value: number) => Math.min(value, 0xFFFFFFFF);
    const header = Buffer.alloc(WAV_HEADER_LENGTH);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(size(WAV_HEADER_LENGTH - 8 + dataBytes), 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16); // fmt chunk size
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(samplingRate, 24);
    header.writeUInt32LE(samplingRate * 2, 28); // bytes per second
    header.writeUInt16LE(2, 32); // bytes per sample frame
    header.writeUInt16LE(16, 34); // bits per sample
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(size(dataBytes), 40);
    return header;
};

/**
 * The UDP socket voice listens on, for VOICE_HOST. An IPv6 address, `::` included, gets an IPv6
 * socket that takes IPv4 as well (ipv6Only false), so that VOICE_HOST=:: serves Unity clients of
 * either kind. Anything else, a host name included, gets the IPv4 socket voice always had: a udp4
 * socket cannot bind an IPv6 address at all, so an IPv6 VOICE_HOST used to leave voice off.
 */
export const voiceSocketOptions = function (hostname: string): dgram.SocketOptions {
    return isIPv6(hostname) ? { type: 'udp6', ipv6Only: false } : { type: 'udp4' };
};

const formatAppId = (appId: number): string => `0x${appId.toString(16).padStart(8, '0')}`;

/** The samples as the little-endian bytes a .wav file holds, without copying them where it can. */
const littleEndianBytes = function (samples: Int16Array): Buffer {
    const bytes = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    return endianness() === 'LE' ? bytes : Buffer.from(bytes).swap16();
};

// A source sending malformed packets, or a peer that can't be relayed to, fails at packet rate
// (up to ~50/s per voice client), so each is reported at most once per this interval rather
// than once per packet...
const REPORT_INTERVAL_MILLIS = 10000;
// ...and only this many distinct sources and peers are remembered at a time, so a burst from
// many addresses can't grow the map without bound. Once full, new ones go unreported until
// the next prune frees a slot.
const REPORT_MAX_KEYS = 100;

// A Unity client opens its voice socket and its TCP connection at about the same time, and its
// voice often starts a moment (0.1 to 0.2 s) before the TCP handshake has registered it. Its first
// packets are dropped then (see admit), as are those of a second client at the same address until
// its own handshake is in, and those of a voice socket opened again on a new port until the old one
// has been quiet for VOICE_CLIENT_GONE_MILLIS. Each of those used to be a warning, the first at
// every client start. Now the first packet dropped from a source is logged at debug level only, and
// the source is reported as a warning once its packets have been dropped for this long. One let in
// before that is never reported, and its next drop starts over.
const JOIN_GRACE_MILLIS = 3000;

export class VoiceServer extends Service {

    public get serviceName(): string { return 'VoiceServer'; }
    public get groupName(): string { return 'web'; }

    private udpSocket!: dgram.Socket;
    private clients: Map<string, VoiceClient> = new Map<string, VoiceClient>();
    private disconnectTimeoutMillis = 2000;
    private disconnectCheckInterval!: NodeJS.Timeout;

    // The voice clients of each app, by appId. Rebuilt only when a client joins, times out or
    // changes app, instead of re-scanning/re-deriving `this.clients` on every incoming voice
    // packet (received at up to ~50 packets/s/client).
    private appClients: Map<number, VoiceClient[]> | undefined;

    // The recordings checkClientsDisconnected is saving, while it is. Guards it against
    // overlapping fs work when a save outlives its tick (see the comment there), and lets
    // stop() wait for it.
    private savingRecordings: Promise<void> | undefined;

    // Report key (see reportMalformedPacket and reportRelayFailure) -> when it was last
    // reported. See REPORT_INTERVAL_MILLIS; pruned every disconnect-check tick.
    private readonly reportedAt = new Map<string, number>();
    // The sources whose packets admit drops, by voiceClientKey (see JOIN_GRACE_MILLIS). One is
    // forgotten once it is let in, or by pruneReports once none of its packets has been dropped for
    // REPORT_INTERVAL_MILLIS. Bounded by REPORT_MAX_KEYS, as reportedAt: once full, a new source is
    // neither timed nor reported until the next prune frees a slot.
    private readonly rejections = new Map<string, Rejection>();

    // Whether the UDP socket is listening: false before start(), and for good if it could not bind.
    private listening = false;

    // Where the Unity clients of each app are connected from: voice is relayed only from there.
    private readonly unityClients: UnityClientAddresses;
    // The trusted proxies whose voice has been said to be relayed unchecked, so it is said once for
    // each. Bounded by REPORT_MAX_KEYS, as TRUSTED_PROXIES may name whole ranges.
    private readonly uncheckedProxies = new Set<string>();
    // The voice clients let in for the Unity clients of each app at each address, by groupKey.
    private readonly groups = new Map<string, VoiceClientGroup>();
    // The recordings of voice clients dropped (see dropVoiceClient), for the next disconnect check,
    // or stop(), to save.
    private droppedRecordings: VoiceClient[] = [];

    // `unityClients`: TCPServerProxy. `trustProxy`: TRUSTED_PROXIES, whose voice is relayed unchecked.
    public constructor(
        private samplingRate: number,
        private voiceRecordingPath: string,
        private recordingVoiceData: boolean,
        unityClients: UnityClientSource,
        private trustProxy: TrustProxy = trustNoProxy
    ) {
        super();
        this.unityClients = new UnityClientAddresses(unityClients);
        this.unityClients.left$.subscribe(({ address, appId }) => this.onUnityClientsLeft(address, appId));
    }

    // For the admin UI's server info.
    public get status(): { listening: boolean; recording: boolean; samplingRate: number; clients: number } {
        return { listening: this.listening, recording: this.recordingVoiceData, samplingRate: this.samplingRate, clients: this.clients.size };
    }

    public start(voicePort: number, hostname: string) {
        this.udpSocket = dgram.createSocket(voiceSocketOptions(hostname));
        this.udpSocket.on('listening', () => {
            this.listening = true;
            const address = this.udpSocket.address() as AddressInfo;
            this.logInfo(`Voice server listening on ${address.address}:${address.port}`);
            this.logInfo(`Voice server Sampling Rate: ${this.samplingRate} Hz`);
            if (this.recordingVoiceData) this.logWarning('Warning: Voice recording is enabled');
        });
        this.udpSocket.on('message', (message, remote) => {
            const now = new Date();
            const nowMillis = now.getTime();
            const clientKey = voiceClientKey(remote.address, remote.port);

            // A Colibri 1.x client's header has no appId, so there is no app to relay its
            // packets to. Its codec byte (0 or 1) is where the header version is now, which
            // makes its version 0.
            if (message.length > VOICE_VERSION_AND_CODEC_OFFSET) {
                const version = message.readUInt8(VOICE_VERSION_AND_CODEC_OFFSET) >> 4;
                if (version === 0) {
                    this.reportV1Packet(clientKey, nowMillis);
                    return;
                }
                if (version !== VOICE_HEADER_VERSION) {
                    this.reportMalformedPacket(clientKey, `its header version is ${version}, not ${VOICE_HEADER_VERSION}`, nowMillis);
                    return;
                }
            }

            // Every header read below is at a fixed offset, so the whole header has to be
            // there. This used to check for only 2 bytes: a single 2-6 byte datagram then
            // reached readInt16LE(2)/readInt8(6), and the ERR_OUT_OF_RANGE thrown out of this
            // listener was an uncaught exception that shut the whole server down.
            if (message.length < VOICE_HEADER_LENGTH) {
                this.reportMalformedPacket(clientKey, `${message.length} bytes is shorter than the ${VOICE_HEADER_LENGTH}-byte header`, nowMillis);
                return;
            }

            // Source port 0 means the sender named no port to reply to (RFC 768), and nothing
            // can be sent back to it: udpSocket.send() rejects port 0 synchronously with
            // ERR_SOCKET_BAD_PORT.
            // Such a sender used to register like any other, and the next packet from anyone
            // else threw out of this listener while relaying to it and shut the server down.
            // Only a raw socket can send one, but that is one packet from any machine on the LAN.
            if (remote.port === 0) {
                this.reportMalformedPacket(clientKey, 'its source port is 0, so nothing can be relayed back to it', nowMillis);
                return;
            }

            // |userId(2)|sequence(2)|frameSize(2)|version and codec(1)|appId(4)|data|, see voice-packet.ts
            const userId = message.readInt16LE(0); // .net (Unity) decodes default in little-endian order
            const sequence = message.readInt16LE(2);
            const frameSize = message.readInt16LE(4);
            const codec: VoiceCodec = message.readUInt8(VOICE_VERSION_AND_CODEC_OFFSET) & 0x0f;
            const appId = message.readUInt32LE(VOICE_APP_ID_OFFSET);

            // Current voice client
            let voiceClient = this.clients.get(clientKey);

            // Checked for a sender that is new or changes app. One already let in needs no check:
            // it is dropped as soon as the Unity clients it was let in for leave (onUnityClientsLeft).
            let admission: Admission | undefined;
            if (!voiceClient || voiceClient.appId !== appId) {
                admission = this.admit(remote.address, appId, clientKey, nowMillis);
                if (!admission) return;
                this.rejections.delete(clientKey);
            }

            // Add to clients if new client
            if (!voiceClient) {
                voiceClient = {
                    ip: remote.address,
                    port: remote.port,
                    userId: userId,
                    appId,
                    lastSequence: sequence,
                    lastHeartbeat: nowMillis,
                    frameSize,
                    frameSizeMillis: frameSize / this.samplingRate * 1000,
                    codec,
                    recordingStartDate: now,
                    recordingData: new GrowableInt16Buffer(),
                    group: undefined,
                };
                this.clients.set(clientKey, voiceClient);
                if (admission === 'unity') this.joinGroup(voiceClient, remote.address);
                this.appClients = undefined;
                this.logDebug(
                    `New voice client connected from ${remote.address}:${remote.port} ID: ${userId} App: ${formatAppId(appId)} Codec: ${codec === VoiceCodec.OPUS ? 'Opus' : 'PCM'}`
                        + (admission === 'proxy' ? ' (through a trusted proxy, unchecked)' : ''),
                    CONNECTION_LINE
                );
                if (this.recordingVoiceData) {
                    this.logWarning('Warning: Voice recording is enabled');
                    if (codec !== VoiceCodec.PCM) this.logWarning('Voice recording is only supported for PCM data');
                }
            } else if (voiceClient.appId !== appId) {
                // Its app name changed: from now on it hears, and is heard by, the new app.
                this.logDebug(`Voice client ${remote.address}:${remote.port} ID: ${voiceClient.userId} moved from app ${formatAppId(voiceClient.appId)} to app ${formatAppId(appId)}`);
                this.leaveGroup(voiceClient);
                voiceClient.appId = appId;
                if (admission === 'unity') this.joinGroup(voiceClient, remote.address);
                this.appClients = undefined;
            }

            // Update last heartbeat
            voiceClient.lastSequence = sequence;
            voiceClient.lastHeartbeat = nowMillis;

            // Send message to all other clients of its app
            for (const peer of this.getAppClients(appId)) {
                if (peer === voiceClient) continue;

                // send() checks its arguments synchronously and throws, and anything thrown
                // out of this listener is an uncaught exception that shuts the server down.
                // Nothing that registers should fail those checks (see the port 0 check
                // above), so this is a backstop. It also keeps one peer that can't be sent
                // to from stopping the relay to every peer after it.
                try {
                    this.udpSocket.send(message, 0, message.length, peer.port, peer.ip, (err) => {
                        if (err) this.reportRelayFailure(peer, err, Date.now());
                    });
                } catch (err) {
                    this.reportRelayFailure(peer, err, nowMillis);
                }
            }

            if (codec === VoiceCodec.PCM && this.recordingVoiceData) {
                // i + 2 <= length: an odd trailing byte is dropped rather than over-read.
                for (let i = VOICE_HEADER_LENGTH; i <= message.length - 2; i += 2) {
                    voiceClient.recordingData.push(message.readInt16LE(i));
                }
            }
        });
        // A failed bind (the voice port taken, a VOICE_HOST that does not resolve or is not
        // this machine's) is only ever reported here, and the rest of the server runs on
        // without voice. This used to be a bare console.error of the message - on stderr
        // only, never in the admin UI's log, and as nothing more than
        // 'bind EADDRINUSE 0.0.0.0:9013', without saying what had failed or what it meant.
        this.udpSocket.on('error', (err: NodeJS.ErrnoException) => {
            if (!this.listening) {
                const inUse = err.code === 'EADDRINUSE' ? ', which another process is already using' : '';
                this.logError(`Voice server could not listen on UDP ${hostname}:${voicePort}${inUse}: ${err.message}. `
                    + 'Voice is disabled until the server is restarted with a VOICE_HOST and VOICE_PORT it can listen on; '
                    + 'everything else keeps running.', false);
                return;
            }
            // Once it listens, this is a failed receive, which a peer could cause at packet rate.
            if (!this.claimReport('socket error', Date.now())) return;
            this.logError(`Voice server socket error on UDP ${hostname}:${voicePort}: ${err.message}`
                + ` (further ones are not reported for ${REPORT_INTERVAL_MILLIS / 1000}s)`, false);
        });
        this.udpSocket.bind(voicePort, hostname);

        // Check if clients disconnected every second
        this.disconnectCheckInterval = setInterval(() => {
            this.pruneReports(Date.now());
            void this.checkClientsDisconnected();
        }, 1000);
    }

    // Tolerates never having been started, for the same reason as SocketIOServer.stop().
    //
    // Saves every recording still held before it resolves. A recording used to be saved only
    // once its client had been quiet for disconnectTimeoutMillis, so stopping the server (docker
    // stop, a restart, a crash) while anyone was still talking, or within 2 s of them stopping,
    // dropped their whole recording without a word.
    public async stop(): Promise<void> {
        if (this.disconnectCheckInterval) clearInterval(this.disconnectCheckInterval);
        if (this.udpSocket) {
            // Throws if the socket is closed already. That must not cost the recordings below.
            try {
                this.udpSocket.close();
            } catch {
                // Nothing left to close.
            }
        }

        // A save the last disconnect check started may still be writing. Waiting for it keeps
        // the two from writing at once; the clients it is saving are no longer in the map.
        await this.savingRecordings;

        const pendingRecordings = this.droppedRecordings.concat(Array.from(this.clients.values()).filter(client => client.recordingData.length > 0));
        this.droppedRecordings = [];
        this.clients.clear();
        this.groups.clear();
        this.appClients = undefined;
        if (pendingRecordings.length === 0) return;

        this.logInfo(`Saving ${pendingRecordings.length} voice recording(s) still in progress before stopping`);
        for (const client of pendingRecordings) {
            await this.saveRecording(client);
        }
    }

    // Whether a packet from `address` for the app `appId` may be relayed, and its sender be relayed
    // to. Anyone can compute an app's id from its name, and forge a packet's source address and
    // port. While every sender was let in, one forged packet every 2 s had this server stream an
    // app's voice to whatever address it named. Now a sender has to be at the address of a Unity
    // client of the app, which takes a TCP connection from there, and each such Unity client lets
    // in one voice client. Otherwise forged source ports at a participant's address would each have
    // the app's voice sent there once more: a thousand of them, a thousand copies of every packet.
    private admit(address: string, appId: number, source: string, nowMillis: number): Admission | undefined {
        // Behind a proxy every voice packet comes from the proxy's address, which says nothing
        // about who sent it: nothing can be checked, or counted, there. Asked first, so that a
        // Unity client on the proxy's machine does not have the voice of everyone behind the proxy
        // taken for its own, and dropped when it leaves.
        if (this.trustProxy(address, 0)) {
            this.reportUncheckedProxy(address);
            return 'proxy';
        }

        const normalized = normalizeAddress(address);
        const unityClients = this.unityClients.count(normalized, appId);
        if (unityClients === 0) {
            this.reportNoUnityClient(source, address, appId, nowMillis);
            return undefined;
        }

        const group = this.groups.get(groupKey(normalized, appId));
        if (group && group.clients.size >= unityClients && !this.dropGoneVoiceClient(group, source, nowMillis)) {
            this.reportNoRoom(source, address, appId, unityClients, nowMillis);
            return undefined;
        }
        return 'unity';
    }

    // Makes room in `group` for `source` by dropping the voice client that has gone the longest
    // without a packet, if that is VOICE_CLIENT_GONE_MILLIS or more.
    private dropGoneVoiceClient(group: VoiceClientGroup, source: string, nowMillis: number): boolean {
        const stalest = stalestOf(group);
        if (!stalest || nowMillis - stalest.lastHeartbeat < VOICE_CLIENT_GONE_MILLIS) return false;

        this.dropVoiceClient(stalest, `no packet for ${nowMillis - stalest.lastHeartbeat} ms, and ${source} takes its place`);
        return true;
    }

    // A Unity client of the app `appId` has left `address`. With none left there, the voice clients
    // they let in stop receiving now rather than once they go quiet: one that kept sending, forged
    // packets included, would otherwise keep receiving the app's voice for as long as it liked.
    // With fewer left than voice clients, the extra ones are dropped VOICE_CLIENT_GONE_MILLIS later
    // (trimGroups), once the voice client of the one that left has gone quiet. Right now, the one
    // that has gone the longest without a packet may well be one still sending: a client that quits
    // closes its TCP connection and its voice socket at about the same time.
    private onUnityClientsLeft(address: string, appId: number): void {
        const group = this.groups.get(groupKey(address, appId));
        if (!group) return;

        const unityClients = this.unityClients.count(address, appId);
        if (unityClients > 0) {
            if (group.clients.size > unityClients) group.shrunkAt = Date.now();
            return;
        }
        // dropVoiceClient takes each out of the set: deleting the entry being visited is safe.
        for (const client of group.clients) {
            this.dropVoiceClient(client, `no Unity client of app ${formatAppId(appId)} is connected from ${address} any more`);
        }
    }

    // Drops the voice clients each group has over the Unity clients of its app left at its address,
    // the one that has gone the longest without a packet first, VOICE_CLIENT_GONE_MILLIS after one
    // of those Unity clients left (see onUnityClientsLeft).
    private trimGroups(nowMillis: number): void {
        for (const group of this.groups.values()) {
            if (group.shrunkAt === undefined || nowMillis - group.shrunkAt < VOICE_CLIENT_GONE_MILLIS) continue;

            group.shrunkAt = undefined;
            const unityClients = this.unityClients.count(group.address, group.appId);
            while (group.clients.size > unityClients) {
                this.dropVoiceClient(stalestOf(group)!,
                    `${group.address} has only ${unityClients} Unity client(s) of app ${formatAppId(group.appId)} left`);
            }
        }
    }

    // Takes `client` out of the clients relayed to and from, and says why in a connection line. Its
    // recording is saved by the next disconnect check, or stop().
    private dropVoiceClient(client: VoiceClient, why?: string): void {
        this.clients.delete(voiceClientKey(client.ip, client.port));
        this.leaveGroup(client);
        this.appClients = undefined;
        this.logDebug(`Voice client ${client.ip}:${client.port} disconnected ID: ${client.userId}` + (why ? `: ${why}` : ''), CONNECTION_LINE);
        if (client.recordingData.length > 0) this.droppedRecordings.push(client);
    }

    // Counts `client` against the Unity clients of its app at `address` (see admit).
    private joinGroup(client: VoiceClient, address: string): void {
        const normalized = normalizeAddress(address);
        const key = groupKey(normalized, client.appId);
        let group = this.groups.get(key);
        if (!group) {
            group = { key, address: normalized, appId: client.appId, clients: new Set(), shrunkAt: undefined };
            this.groups.set(key, group);
        }
        group.clients.add(client);
        client.group = group;
    }

    private leaveGroup(client: VoiceClient): void {
        const group = client.group;
        if (!group) return;

        client.group = undefined;
        group.clients.delete(client);
        if (group.clients.size === 0) this.groups.delete(group.key);
    }

    private reportNoUnityClient(source: string, address: string, appId: number, nowMillis: number): void {
        const level = this.rejectionReport(source, nowMillis);
        if (level) this.logRejection(level, source, appId, `no Unity client of that app is connected from ${address}`);
    }

    private reportNoRoom(source: string, address: string, appId: number, unityClients: number, nowMillis: number): void {
        const level = this.rejectionReport(source, nowMillis);
        if (level) this.logRejection(level, source, appId, `${address} has ${unityClients} Unity client(s) of that app, and as many voice clients already`);
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
            this.logWarning(`${message} (further ones from this source are not reported for ${REPORT_INTERVAL_MILLIS / 1000}s)`);
            return;
        }
        // Routine while a Unity client connects, hence a connection line.
        this.logDebug(`${message} (reported as a warning if this goes on for ${JOIN_GRACE_MILLIS / 1000}s: `
            + 'a Unity client\'s voice can start before its TCP handshake is in)', CONNECTION_LINE);
    }

    private reportUncheckedProxy(address: string): void {
        if (this.uncheckedProxies.has(address) || this.uncheckedProxies.size >= REPORT_MAX_KEYS) return;
        this.uncheckedProxies.add(address);

        this.logInfo(`Relaying voice from ${address} unchecked: it is in TRUSTED_PROXIES, and voice through a proxy cannot be matched `
            + 'to a Unity client\'s address. Logged once per address.');
    }

    private reportMalformedPacket(source: string, reason: string, nowMillis: number): void {
        if (!this.claimReport(source, nowMillis)) return;

        this.logError(`Ignoring malformed voice packet from ${source}: ${reason}`
            + ` (further ones from this source are not reported for ${REPORT_INTERVAL_MILLIS / 1000}s)`, false);
    }

    private reportV1Packet(source: string, nowMillis: number): void {
        if (!this.claimReport(source, nowMillis)) return;

        this.logWarning(`Ignoring voice packet from ${source}: it looks like a Colibri 1.x client (its voice header has no app), `
            + `but this server speaks voice header v${VOICE_HEADER_VERSION}. Upgrade the Colibri Unity package (de.uni.kn.colibri) in that app to 2.x`
            + ` (further ones from this source are not reported for ${REPORT_INTERVAL_MILLIS / 1000}s)`);
    }

    private reportRelayFailure(peer: VoiceClient, err: unknown, nowMillis: number): void {
        const target = `${peer.ip}:${peer.port}`;
        // Keyed apart from the peer's own malformed packets, so neither report hides the other.
        if (!this.claimReport(`relay to ${target}`, nowMillis)) return;

        this.logError(`Failed to relay voice packet to ${target}: ${err instanceof Error ? err.message : String(err)}`
            + ` (further failures for this peer are not reported for ${REPORT_INTERVAL_MILLIS / 1000}s)`, false);
    }

    // True, and remembers the time, if `key` may be reported now: at most once per
    // REPORT_INTERVAL_MILLIS, and only while fewer than REPORT_MAX_KEYS keys are remembered.
    private claimReport(key: string, nowMillis: number): boolean {
        const reportedAt = this.reportedAt.get(key);
        if (reportedAt !== undefined && nowMillis - reportedAt < REPORT_INTERVAL_MILLIS) return false;
        if (reportedAt === undefined && this.reportedAt.size >= REPORT_MAX_KEYS) return false;

        this.reportedAt.set(key, nowMillis);
        return true;
    }

    private pruneReports(nowMillis: number): void {
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

    private getAppClients(appId: number): readonly VoiceClient[] {
        if (!this.appClients) {
            this.appClients = new Map<number, VoiceClient[]>();
            for (const client of this.clients.values()) {
                const app = this.appClients.get(client.appId);
                if (app) app.push(client);
                else this.appClients.set(client.appId, [ client ]);
            }
        }
        return this.appClients.get(appId) ?? NO_CLIENTS;
    }

    // setInterval never awaits this, so the timed-out clients are collected and removed
    // before anything is awaited. Deleting only after `await saveRecording(...)` meant a
    // save slower than the 1s tick let the next tick find the same client still registered
    // and write the same recording to the same filename a second time.
    private async checkClientsDisconnected(): Promise<void> {
        if (this.savingRecordings) return;

        const now = Date.now();
        for (const client of this.clients.values()) {
            // Remove inactive clients
            if (now - client.lastHeartbeat > this.disconnectTimeoutMillis) this.dropVoiceClient(client);
        }
        this.trimGroups(now);

        // Those just timed out or trimmed, and those dropped since the last check for another
        // reason (see dropVoiceClient's callers).
        const pendingRecordings = this.droppedRecordings;
        this.droppedRecordings = [];
        if (pendingRecordings.length === 0) return;

        const saving = (async () => {
            for (const client of pendingRecordings) {
                await this.saveRecording(client);
            }
        })();
        this.savingRecordings = saving;
        try {
            await saving;
        } finally {
            this.savingRecordings = undefined;
        }
    }

    // Never throws: a failed save is logged. Nothing here re-encodes the samples on the main
    // thread (see wavHeader): writeFile hands their bytes to the file system in chunks.
    //
    // The app and the source port are in the file name because the start time and the voice id
    // alone do not tell recordings apart: two apps may use the same voice id, and after a
    // restart or a dropped network every client registers again within the same few ms. Two
    // recordings with the same name used to overwrite each other without a word.
    private async saveRecording(client: VoiceClient): Promise<void> {
        const samples = client.recordingData.toTypedArray();
        const dateString = client.recordingStartDate.toISOString().replace(/:/g, '_');
        const filename = path.join(this.voiceRecordingPath,
            `rec_${dateString}_app_${formatAppId(client.appId)}_ID_${client.userId}_port_${client.port}.wav`);
        const seconds = (samples.length / this.samplingRate).toFixed(1);
        try {
            await mkdir(this.voiceRecordingPath, { recursive: true });
            await writeFile(filename, [ wavHeader(this.samplingRate, samples.byteLength), littleEndianBytes(samples) ]);
            this.logInfo(`Voice recording of client ID ${client.userId} (${client.ip}:${client.port}, ${seconds} s) saved to ${filename}`);
        } catch (err) {
            // An fs error names the file itself.
            this.logError(`Failed to save the voice recording of client ID ${client.userId} (${client.ip}:${client.port}, ${seconds} s): `
                + `${err instanceof Error ? err.message : String(err)}`, false);
        }
    }
}
