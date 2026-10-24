import { CONNECTION_LINE } from '../core/log-message.js';
import { Service } from '../core/service.js';
import * as dgram from 'dgram';
import { isIPv6 } from 'net';
import { readFileSync } from 'fs';
import {
    VoiceCodec,
    readVoiceHeader,
} from './voice-packet.js';
import type { VoiceHeader } from './voice-packet.js';
import type { TrustProxy } from '../net/trusted-proxies.js';
import { trustNoProxy } from '../net/trusted-proxies.js';
import { hostPort, ipv4OnlyWarning } from '../net/addresses.js';
import type { UnityClientSource } from './unity-client-addresses.js';
import type { VoiceClientGroup } from './voice-admission.js';
import { VoiceAdmission } from './voice-admission.js';
import { REPORT_INTERVAL_MILLIS, VoiceReports } from './voice-reports.js';
import { VoiceRecorder } from './voice-recorder.js';
import { VoiceClients } from './voice-clients.js';
import { formatAppId } from './format-app-id.js';
import { voiceClientKey } from './voice-client-key.js';
import { GrowableInt16Buffer } from './wav.js';

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
    // The voice clients of its app let in from its address, itself included (see
    // VoiceAdmission.admit). Undefined for one let in because its address is in TRUSTED_PROXIES:
    // that is neither checked nor limited, so it is dropped only once it goes quiet.
    group: VoiceClientGroup<VoiceClient> | undefined;
}

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

/**
 * The UDP socket voice listens on, for VOICE_HOST. An IPv6 address, `::` included, gets an IPv6
 * socket that takes IPv4 as well (ipv6Only false), so that VOICE_HOST=:: serves Unity clients of
 * either kind. Anything else, a host name included, gets a udp4 socket, which cannot bind an IPv6
 * address at all.
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
    // The helpers below log through this service's methods, so their lines carry its name.
    private readonly voiceClients = new VoiceClients<VoiceClient>({
        leaveGroup: (client) => this.admission.leaveGroup(client),
        logDebug: (msg, metadata) => this.logDebug(msg, metadata),
        queueRecording: (client) => this.recorder.queueRecording(client),
    });
    // The map voiceClients holds, by voiceClientKey.
    private readonly clients: Map<string, VoiceClient> = this.voiceClients.clients;
    private readonly disconnectTimeoutMillis = 2000;
    private disconnectCheckInterval!: NodeJS.Timeout;

    private readonly recorder: VoiceRecorder;

    private readonly reports = new VoiceReports({
        logDebug: (msg, metadata) => this.logDebug(msg, metadata),
        logInfo: (msg) => this.logInfo(msg),
        logWarning: (msg) => this.logWarning(msg),
        logError: (msg, printStacktrace) => this.logError(msg, printStacktrace),
    });

    // Whether the UDP socket is listening: false before start(), and for good if it could not bind.
    private listening = false;

    private readonly admission: VoiceAdmission<VoiceClient>;

    // `unityClients`: TCPServerProxy. `trustProxy`: TRUSTED_PROXIES, whose voice is relayed unchecked.
    public constructor(
        private readonly samplingRate: number,
        voiceRecordingPath: string,
        private readonly recordingVoiceData: boolean,
        unityClients: UnityClientSource,
        trustProxy: TrustProxy = trustNoProxy
    ) {
        super();
        this.recorder = new VoiceRecorder(samplingRate, voiceRecordingPath, {
            logInfo: (msg) => this.logInfo(msg),
            logError: (msg, printStacktrace) => this.logError(msg, printStacktrace),
        });
        this.admission = new VoiceAdmission<VoiceClient>(unityClients, trustProxy, {
            dropVoiceClient: (client, why) => this.voiceClients.dropVoiceClient(client, why),
            reportUncheckedProxy: (address) => this.reports.reportUncheckedProxy(address),
            reportNoUnityClient: (source, address, appId, nowMillis) => this.reports.reportNoUnityClient(source, address, appId, nowMillis),
            reportNoRoom: (source, address, appId, count, nowMillis) => this.reports.reportNoRoom(source, address, appId, count, nowMillis),
        });
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
            const address = this.udpSocket.address();
            this.logInfo(`Voice server listening on ${hostPort(address.address, address.port)}`);
            this.logInfo(`Voice server Sampling Rate: ${this.samplingRate} Hz`);
            if (this.recordingVoiceData) this.logWarning('Warning: Voice recording is enabled');
        });
        this.udpSocket.on('message', (message, remote) => this.handlePacket(message, remote));
        // A failed bind (the voice port taken, a VOICE_HOST that does not resolve or is not
        // this machine's) is only reported here, and the rest of the server runs on without voice.
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

        // Source port 0 means the sender named no port to reply to (RFC 768), and nothing can be
        // sent back to it: udpSocket.send() rejects port 0 synchronously with ERR_SOCKET_BAD_PORT.
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
        if (codec === VoiceCodec.PCM && this.recordingVoiceData) this.recorder.record(message, voiceClient);
    }

    // The sender's voice client, registered if new or moved if it changes app. Undefined if
    // VoiceAdmission.admit drops the packet.
    private admitSender(remote: dgram.RemoteInfo, clientKey: string, header: VoiceHeader, now: Date, nowMillis: number): VoiceClient | undefined {
        const { userId, codec, appId } = header;

        // Current voice client
        let voiceClient = this.clients.get(clientKey);

        // Checked for a sender that is new or changes app. One already let in needs no check:
        // it is dropped as soon as the Unity clients it was let in for leave
        // (VoiceAdmission.onUnityClientsLeft).
        if (voiceClient && voiceClient.appId === appId) return voiceClient;
        const admittedAs = this.admission.admit(remote.address, appId, clientKey, nowMillis);
        if (!admittedAs) return undefined;
        this.reports.forgetRejection(clientKey);

        // Add to clients if new client
        if (!voiceClient) {
            voiceClient = newVoiceClient(remote, header, this.samplingRate, now, nowMillis);
            this.clients.set(clientKey, voiceClient);
            if (admittedAs === 'unity') this.admission.joinGroup(voiceClient, remote.address);
            this.voiceClients.invalidateAppClients();
            this.logDebug(
                `New voice client connected from ${clientKey} ID: ${userId} App: ${formatAppId(appId)} Codec: ${codec === VoiceCodec.OPUS ? 'Opus' : 'PCM'}`
                    + (admittedAs === 'proxy' ? ' (through a trusted proxy, unchecked)' : ''),
                CONNECTION_LINE
            );
            if (this.recordingVoiceData) {
                this.logWarning('Warning: Voice recording is enabled');
                if (codec !== VoiceCodec.PCM) this.logWarning('Voice recording is only supported for PCM data');
            }
        } else {
            // Its app name changed: from now on it hears, and is heard by, the new app.
            this.logDebug(`Voice client ${clientKey} ID: ${voiceClient.userId} moved from app ${formatAppId(voiceClient.appId)} to app ${formatAppId(appId)}`);
            this.admission.leaveGroup(voiceClient);
            voiceClient.appId = appId;
            if (admittedAs === 'unity') this.admission.joinGroup(voiceClient, remote.address);
            this.voiceClients.invalidateAppClients();
        }
        return voiceClient;
    }

    // Send message to all other clients
    private relay(message: Buffer, sender: VoiceClient, appId: number, nowMillis: number): void {
        for (const peer of this.voiceClients.getAppClients(appId)) {
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
    // Saves every recording still held before it resolves, those of clients not yet timed out included.
    public async stop(): Promise<void> {
        if (this.disconnectCheckInterval) clearInterval(this.disconnectCheckInterval);
        // A socket closed already must not cost the recordings below.
        if (this.udpSocket) this.closeSocket();

        // A save the last disconnect check started may still be writing. Waiting for it keeps
        // the two from writing at once; the clients it is saving are no longer in the map.
        await this.recorder.saving;

        const pendingRecordings = this.recorder.takeRecordings(this.clients.values());
        this.clients.clear();
        this.admission.clearGroups();
        this.voiceClients.invalidateAppClients();
        await this.recorder.saveBeforeStopping(pendingRecordings);
    }

    private async checkClientsDisconnected(): Promise<void> {
        if (this.recorder.saving) return;

        const now = Date.now();
        for (const client of this.clients.values()) {
            // Remove inactive clients
            if (now - client.lastHeartbeat > this.disconnectTimeoutMillis) this.voiceClients.dropVoiceClient(client);
        }
        this.admission.trimGroups(now);

        await this.recorder.saveDropped();
    }
}
