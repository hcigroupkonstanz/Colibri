import { Service } from '../core';
import * as dgram from 'dgram';
import { AddressInfo } from 'net';
import { WaveFile } from 'wavefile';
import { writeFileSync, existsSync, mkdirSync } from 'fs';

interface VoiceClient {
    ip: string;
    port: number;
    userId: number;
    lastSequence: number;
    lastHeartbeat: number;
    frameSize: number; // How many samples are sent at one time
    frameSizeMillis: number;
    codec: Codec;
    recordingStartDate: Date;
    recordingData: number[];
}

enum Codec {
    PCM,
    OPUS
}

export class VoiceServer extends Service {

    public get serviceName(): string { return 'VoiceServer'; }
    public get groupName(): string { return 'web'; }

    private udpSocket!: dgram.Socket;
    private clients: Map<string, VoiceClient> = new Map<string, VoiceClient>();
    private disconnectTimeoutMillis = 2000;

    public constructor(private samplingRate: number, private voiceRecordingPath: string, private recordingVoiceData: boolean = false) {
        super();
    }

    public start(voicePort: number, hostname: string) {
        this.udpSocket = dgram.createSocket('udp4');
        this.udpSocket.on('listening', () => {
            const address = this.udpSocket.address() as AddressInfo;
            console.log(`Voice server listening on ${address.address}:${address.port}`);
            this.logInfo(`Voice server listening on ${address.address}:${address.port}`);
            this.logInfo(`Voice server Sampling Rate: ${this.samplingRate} Hz`);
            if (this.recordingVoiceData) this.logWarning('Warning: Voice recording is enabled');
        });
        this.udpSocket.on('message', (message, remote) => {
            if (message.length < 2) {
                this.logError(`Invalid voice packet received from client ${remote.address}:${remote.port}`, false);
                return;
            }
            const now = new Date();
            const nowMillis = now.getTime();

            // Voice message with 7 bytes header: |userId(2)|sequence(2)|frameSize(2)|codec(1)|data|
            const userId = message.readInt16LE(0); // .net (Unity) decodes default in little-endian order
            const sequence = message.readInt16LE(2);
            const frameSize = message.readInt16LE(4);
            const codec: Codec = message.readInt8(6);

            // Current voice client
            let voiceClient: VoiceClient | undefined;

            // Add to clients if new client
            if (!this.clients.has(`${remote.address}:${remote.port}`)) {
                voiceClient = {
                    ip: remote.address,
                    port: remote.port,
                    userId: userId,
                    lastSequence: sequence,
                    lastHeartbeat: nowMillis,
                    frameSize,
                    frameSizeMillis: frameSize / this.samplingRate * 1000,
                    codec,
                    recordingStartDate: now,
                    recordingData: [],
                };
                this.clients.set(`${remote.address}:${remote.port}`, voiceClient);
                this.logDebug(`New voice client connected from ${remote.address}:${remote.port} ID: ${userId} Codec: ${codec === Codec.OPUS ? 'Opus' : 'PCM'}`);
                if (this.recordingVoiceData) {
                    this.logWarning('Warning: Voice recording is enabled');
                    if (codec !== Codec.PCM) this.logWarning('Voice recording is only supported for PCM data');
                }
            } else {
                voiceClient = this.clients.get(`${remote.address}:${remote.port}`);
            }

            if (!voiceClient) {
                this.logError('Unknown voice client!');
                return;
            }

            // Update last heartbeat
            voiceClient.lastSequence = sequence;
            voiceClient.lastHeartbeat = nowMillis;

            // Send message to all other clients
            this.clients.forEach((value, key) => {
                if (key !== `${remote.address}:${remote.port}`) {
                    this.udpSocket.send(message, 0, message.length, value.port, value.ip, (err) => {
                        if (err) {
                            throw err;
                        }
                    });
                }
            });

            if (codec === Codec.PCM && this.recordingVoiceData) {
                for (let i = 7; i <= message.length - 2; i += 2) {
                    voiceClient.recordingData.push(message.readInt16LE(i));
                }
            }
        });
        this.udpSocket.on('error', (exception) => {
            console.error(exception.message);
        });
        this.udpSocket.bind(voicePort, hostname);

        // Check if clients disconnected every second
        setInterval(this.checkClientsDisconnected, 1000, this);
    }

    private checkClientsDisconnected(context: VoiceServer) {
        const now = Date.now();
        context.clients.forEach((value, key) => {
            // Remove inactive clients
            if (now - value.lastHeartbeat > context.disconnectTimeoutMillis) {

                // Check if recording data is available
                if (value.recordingData.length > 0) {

                    // Create wave file from recording data
                    const wav = new WaveFile();
                    wav.fromScratch(1, context.samplingRate, '16', value.recordingData);

                    // Save wave file
                    const dateString = value.recordingStartDate.toISOString().replace(/:/g, '_');
                    if (!existsSync(context.voiceRecordingPath)) mkdirSync(context.voiceRecordingPath);
                    writeFileSync(`${context.voiceRecordingPath}/rec_${dateString}_ID_${value.userId}.wav`, wav.toBuffer());
                    context.logDebug(`Voice recording saved to rec_${dateString}_ID_${value.userId}.wav`);
                }

                // Delete client
                context.clients.delete(key);
                context.logDebug(`Voice client ${value.ip}:${value.port} disconnected ID: ${value.userId}`);
            }
        });
    }
}
