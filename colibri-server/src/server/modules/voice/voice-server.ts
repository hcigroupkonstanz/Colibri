import { CONNECTION_LINE } from '../core/log-message.js';
import { errorMessage } from '../core/error-message.js';
import { Service } from '../core/service.js';
import * as dgram from 'dgram';
import type { AddressInfo } from 'net';
import { isIPv6 } from 'net';
import { readFileSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import * as path from 'path';
import {
    VOICE_HEADER_LENGTH,
    VoiceCodec,
    readVoiceHeader,
} from './voice-packet.js';
import type { VoiceHeader } from './voice-packet.js';
import type { TrustProxy } from '../net/trusted-proxies.js';
import { trustNoProxy } from '../net/trusted-proxies.js';
import { hostPort, ipv4OnlyWarning, normalizeAddress } from '../net/addresses.js';
import type { UnityClientSource } from './unity-client-addresses.js';
import { UnityClientAddresses } from './unity-client-addresses.js';
import { REPORT_INTERVAL_MILLIS, VoiceReports } from './voice-reports.js';
import { formatAppId } from './format-app-id.js';
import { voiceClientKey } from './voice-client-key.js';
import { GrowableInt16Buffer, littleEndianBytes, wavHeader } from './wav.js';

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

// A new voice client, from the header of its first packet and where that came from.
const newVoiceClient = function (remote: dgram.RemoteInfo, header: VoiceHeader, samplingRate: number, now: Date, nowMillis: number): VoiceClient {
    const { userId, sequence, frameSize, codec, appId } = header;
    return {
        ip: remote.address,
        port: remote.port,
        userId: userId,
        appId,
        lastSequence: sequence,
        lastHeartbeat: nowMillis,
        frameSize,
        frameSizeMillis: frameSize / samplingRate * 1000,
        codec,
        recordingStartDate: now,
        recordingData: new GrowableInt16Buffer(),
        group: undefined,
    };
};

// What getAppClients hands back for an app with no voice clients.
const NO_CLIENTS: readonly VoiceClient[] = [];

/**
 * The UDP socket voice listens on, for VOICE_HOST. An IPv6 address, `::` included, gets an IPv6
 * socket that takes IPv4 as well (ipv6Only false), so that VOICE_HOST=:: serves Unity clients of
 * either kind. Anything else, a host name included, gets the IPv4 socket voice always had: a udp4
 * socket cannot bind an IPv6 address at all, so an IPv6 VOICE_HOST used to leave voice off.
 */
export const voiceSocketOptions = function (hostname: string): dgram.SocketOptions {
    return isIPv6(hostname) ? { type: 'udp6', ipv6Only: false } : { type: 'udp4' };
};

/**
 * Whether a UDP socket on `::` takes IPv4 as well. For UDP, unlike TCP, libuv leaves IPV6_V6ONLY as
 * the system has it, except on Windows, where it clears it. On Linux that is net.ipv6.bindv6only,
 * 0 unless changed. Elsewhere, macOS included, IPv6 sockets take IPv4 by default.
 */
export const ipv6SocketsTakeIPv4 = function (read: (file: string) => string = file => readFileSync(file, 'utf8')): boolean {
    try {
        return read('/proc/sys/net/ipv6/bindv6only').trim() !== '1';
    } catch {
        return true;
    }
};

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

    // Throttles the reports of dropped and unrelayable packets and of socket errors; pruned every
    // disconnect-check tick. Logs through this service, so under its name.
    private readonly reports = new VoiceReports({
        logDebug: (msg, metadata) => this.logDebug(msg, metadata),
        logInfo: (msg) => this.logInfo(msg),
        logWarning: (msg) => this.logWarning(msg),
        logError: (msg, printStacktrace) => this.logError(msg, printStacktrace),
    });

    // Whether the UDP socket is listening: false before start(), and for good if it could not bind.
    private listening = false;

    // Where the Unity clients of each app are connected from: voice is relayed only from there.
    private readonly unityClients: UnityClientAddresses;
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

    // VOICE_HOST=::, the default, listens on IPv6 and IPv4. Where that is not possible, voice
    // listens on IPv4 only, as Unity clients send voice over IPv4 whenever the server's name has an
    // IPv4 address: on a system whose IPv6 sockets take no IPv4 (see ipv6SocketsTakeIPv4), and on
    // one without IPv6, which fails the bind (see the error handler).
    public start(voicePort: number, hostname: string, ipv6TakesIPv4: () => boolean = ipv6SocketsTakeIPv4) {
        if (hostname === '::' && !ipv6TakesIPv4()) {
            this.logWarning(ipv4OnlyWarning('VOICE_HOST', 'voice port', 'IPv6 sockets take no IPv4 on this system (net.ipv6.bindv6only=1)'));
            hostname = '0.0.0.0';
        }
        this.openSocket(voicePort, hostname);

        // Check if clients disconnected every second
        this.disconnectCheckInterval = setInterval(() => {
            this.reports.pruneReports(Date.now());
            void this.checkClientsDisconnected();
        }, 1000);
    }

    private openSocket(voicePort: number, hostname: string): void {
        this.udpSocket = dgram.createSocket(voiceSocketOptions(hostname));
        this.udpSocket.on('listening', () => {
            this.listening = true;
            const address = this.udpSocket.address() as AddressInfo;
            this.logInfo(`Voice server listening on ${hostPort(address.address, address.port)}`);
            this.logInfo(`Voice server Sampling Rate: ${this.samplingRate} Hz`);
            if (this.recordingVoiceData) this.logWarning('Warning: Voice recording is enabled');
        });
        this.udpSocket.on('message', (message, remote) => this.handlePacket(message, remote));
        // A failed bind (the voice port taken, a VOICE_HOST that does not resolve or is not
        // this machine's) is only ever reported here, and the rest of the server runs on
        // without voice. This used to be a bare console.error of the message - on stderr
        // only, never in the admin UI's log, and as nothing more than
        // 'bind EADDRINUSE 0.0.0.0:9013', without saying what had failed or what it meant.
        this.udpSocket.on('error', (err: NodeJS.ErrnoException) => {
            if (!this.listening && hostname === '::' && err.code === 'EAFNOSUPPORT') {
                this.logWarning(ipv4OnlyWarning('VOICE_HOST', 'voice port'));
                this.closeSocket();
                this.openSocket(voicePort, '0.0.0.0');
                return;
            }
            if (!this.listening) {
                const inUse = err.code === 'EADDRINUSE' ? ', which another process is already using' : '';
                this.logError(`Voice server could not listen on UDP ${hostPort(hostname, voicePort)}${inUse}: ${err.message}. `
                    + 'Voice is disabled until the server is restarted with a VOICE_HOST and VOICE_PORT it can listen on; '
                    + 'everything else keeps running.', false);
                return;
            }
            // Once it listens, this is a failed receive, which a peer could cause at packet rate.
            if (!this.reports.claimReport('socket error', Date.now())) return;
            this.logError(`Voice server socket error on UDP ${hostPort(hostname, voicePort)}: ${err.message}`
                + ` (further ones are not reported for ${REPORT_INTERVAL_MILLIS / 1000}s)`, false);
        });
        this.udpSocket.bind(voicePort, hostname);
    }

    private handlePacket(message: Buffer, remote: dgram.RemoteInfo): void {
        const now = new Date();
        const nowMillis = now.getTime();
        const clientKey = voiceClientKey(remote.address, remote.port);

        const reading = readVoiceHeader(message);
        if (reading.kind === 'v1') {
            this.reports.reportV1Packet(clientKey, nowMillis);
            return;
        }
        if (reading.kind === 'malformed') {
            this.reports.reportMalformedPacket(clientKey, reading.reason, nowMillis);
            return;
        }

        // Source port 0 means the sender named no port to reply to (RFC 768), and nothing
        // can be sent back to it: udpSocket.send() rejects port 0 synchronously with
        // ERR_SOCKET_BAD_PORT.
        // Such a sender used to register like any other, and the next packet from anyone
        // else threw out of this listener while relaying to it and shut the server down.
        // Only a raw socket can send one, but that is one packet from any machine on the LAN.
        if (remote.port === 0) {
            this.reports.reportMalformedPacket(clientKey, 'its source port is 0, so nothing can be relayed back to it', nowMillis);
            return;
        }

        const { sequence, codec, appId } = reading.header;
        const voiceClient = this.admitSender(remote, clientKey, reading.header, now, nowMillis);
        if (!voiceClient) return;

        // Update last heartbeat
        voiceClient.lastSequence = sequence;
        voiceClient.lastHeartbeat = nowMillis;

        this.relay(message, voiceClient, appId, nowMillis);
        if (codec === VoiceCodec.PCM && this.recordingVoiceData) this.record(message, voiceClient);
    }

    // The voice client `remote` sends as, added or moved to the app of `header` first if it is new or
    // changes app. Undefined if admit drops the packet.
    private admitSender(remote: dgram.RemoteInfo, clientKey: string, header: VoiceHeader, now: Date, nowMillis: number): VoiceClient | undefined {
        const { userId, codec, appId } = header;

        // Current voice client
        let voiceClient = this.clients.get(clientKey);

        // Checked for a sender that is new or changes app. One already let in needs no check:
        // it is dropped as soon as the Unity clients it was let in for leave (onUnityClientsLeft).
        if (voiceClient && voiceClient.appId === appId) return voiceClient;
        const admission = this.admit(remote.address, appId, clientKey, nowMillis);
        if (!admission) return undefined;
        this.reports.forgetRejection(clientKey);

        // Add to clients if new client
        if (!voiceClient) {
            voiceClient = newVoiceClient(remote, header, this.samplingRate, now, nowMillis);
            this.clients.set(clientKey, voiceClient);
            if (admission === 'unity') this.joinGroup(voiceClient, remote.address);
            this.appClients = undefined;
            this.logDebug(
                `New voice client connected from ${clientKey} ID: ${userId} App: ${formatAppId(appId)} Codec: ${codec === VoiceCodec.OPUS ? 'Opus' : 'PCM'}`
                    + (admission === 'proxy' ? ' (through a trusted proxy, unchecked)' : ''),
                CONNECTION_LINE
            );
            if (this.recordingVoiceData) {
                this.logWarning('Warning: Voice recording is enabled');
                if (codec !== VoiceCodec.PCM) this.logWarning('Voice recording is only supported for PCM data');
            }
        } else {
            // Its app name changed: from now on it hears, and is heard by, the new app.
            this.logDebug(`Voice client ${clientKey} ID: ${voiceClient.userId} moved from app ${formatAppId(voiceClient.appId)} to app ${formatAppId(appId)}`);
            this.leaveGroup(voiceClient);
            voiceClient.appId = appId;
            if (admission === 'unity') this.joinGroup(voiceClient, remote.address);
            this.appClients = undefined;
        }
        return voiceClient;
    }

    // Sends `message` to all other clients of the app `appId`.
    private relay(message: Buffer, sender: VoiceClient, appId: number, nowMillis: number): void {
        for (const peer of this.getAppClients(appId)) {
            if (peer === sender) continue;

            // send() checks its arguments synchronously and throws, and anything thrown
            // out of the 'message' listener is an uncaught exception that shuts the server down.
            // Nothing that registers should fail those checks (see the port 0 check in
            // handlePacket), so this is a backstop. It also keeps one peer that can't be sent
            // to from stopping the relay to every peer after it.
            try {
                this.udpSocket.send(message, 0, message.length, peer.port, peer.ip, (err) => {
                    if (err) this.reports.reportRelayFailure(voiceClientKey(peer.ip, peer.port), err, Date.now());
                });
            } catch (err) {
                this.reports.reportRelayFailure(voiceClientKey(peer.ip, peer.port), err, nowMillis);
            }
        }
    }

    private record(message: Buffer, client: VoiceClient): void {
        // i + 2 <= length: an odd trailing byte is dropped rather than over-read.
        for (let i = VOICE_HEADER_LENGTH; i <= message.length - 2; i += 2) {
            client.recordingData.push(message.readInt16LE(i));
        }
    }

    private closeSocket(): void {
        // Throws if the socket is closed already.
        try {
            this.udpSocket.close();
        } catch {
            // Nothing left to close.
        }
    }

    // Tolerates never having been started, for the same reason as SocketIOServer.stop().
    //
    // Saves every recording still held before it resolves. A recording used to be saved only
    // once its client had been quiet for disconnectTimeoutMillis, so stopping the server (docker
    // stop, a restart, a crash) while anyone was still talking, or within 2 s of them stopping,
    // dropped their whole recording without a word.
    public async stop(): Promise<void> {
        if (this.disconnectCheckInterval) clearInterval(this.disconnectCheckInterval);
        // A socket closed already must not cost the recordings below.
        if (this.udpSocket) this.closeSocket();

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
        const normalized = normalizeAddress(address);
        if (this.trustProxy(address, 0)) {
            this.reports.reportUncheckedProxy(normalized);
            return 'proxy';
        }

        const unityClients = this.unityClients.count(normalized, appId);
        if (unityClients === 0) {
            this.reports.reportNoUnityClient(source, normalized, appId, nowMillis);
            return undefined;
        }

        const group = this.groups.get(groupKey(normalized, appId));
        if (group && group.clients.size >= unityClients && !this.dropGoneVoiceClient(group, source, nowMillis)) {
            this.reports.reportNoRoom(source, normalized, appId, unityClients, nowMillis);
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
        this.logDebug(`Voice client ${voiceClientKey(client.ip, client.port)} disconnected ID: ${client.userId}` + (why ? `: ${why}` : ''), CONNECTION_LINE);
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
            this.logInfo(`Voice recording of client ID ${client.userId} (${voiceClientKey(client.ip, client.port)}, ${seconds} s) saved to ${filename}`);
        } catch (err) {
            // An fs error names the file itself.
            this.logError(`Failed to save the voice recording of client ID ${client.userId} (${voiceClientKey(client.ip, client.port)}, ${seconds} s): `
                + `${errorMessage(err)}`, false);
        }
    }
}
