import { mkdir, writeFile } from 'fs/promises';
import * as path from 'path';
import { errorMessage } from '../core/error-message.js';
import { VOICE_HEADER_LENGTH } from './voice-packet.js';
import { formatAppId } from './format-app-id.js';
import { voiceClientKey } from './voice-client-key.js';
import type { GrowableInt16Buffer } from './wav.js';
import { littleEndianBytes, wavHeader } from './wav.js';

// What VoiceRecorder reads of a voice client: who it is, and its recording.
interface RecordedVoiceClient {
    readonly ip: string;
    readonly port: number;
    readonly userId: number;
    readonly appId: number;
    readonly recordingStartDate: Date;
    readonly recordingData: GrowableInt16Buffer;
}

// What VoiceRecorder needs from the VoiceServer that owns it: its log methods, so that its lines
// keep the server's name as their origin.
interface VoiceRecorderCallbacks {
    logInfo(msg: string): void;
    logError(msg: string, printStacktrace: boolean): void;
}

// The VoiceServer's recordings of PCM voice, saved as .wav files once their voice client is dropped
// or the server stops. One for the server's lifetime.
export class VoiceRecorder {
    // The recordings of voice clients dropped (see VoiceClients.dropVoiceClient), for the next
    // disconnect check, or stop(), to save.
    private droppedRecordings: RecordedVoiceClient[] = [];

    // The recordings saveDropped is saving, while it is. Guards VoiceServer.checkClientsDisconnected
    // against overlapping fs work when a save outlives its tick (see the comment there), and lets
    // stop() wait for it.
    private savingRecordings: Promise<void> | undefined;

    public constructor(
        private readonly samplingRate: number,
        private readonly voiceRecordingPath: string,
        private readonly callbacks: VoiceRecorderCallbacks
    ) {}

    // The save saveDropped is running, if any.
    public get saving(): Promise<void> | undefined {
        return this.savingRecordings;
    }

    public record(message: Buffer, client: RecordedVoiceClient): void {
        // i + 2 <= length: an odd trailing byte is dropped rather than over-read.
        for (let i = VOICE_HEADER_LENGTH; i <= message.length - 2; i += 2) {
            client.recordingData.push(message.readInt16LE(i));
        }
    }

    // Keeps the recording of `client`, just dropped, for the next saveDropped or takeRecordings, if
    // it has any samples.
    public queueRecording(client: RecordedVoiceClient): void {
        if (client.recordingData.length > 0) this.droppedRecordings.push(client);
    }

    // Saves the recordings queued since the last call, one at a time.
    public async saveDropped(): Promise<void> {
        // Those just timed out or trimmed, and those dropped since the last check for another
        // reason (see VoiceClients.dropVoiceClient's callers).
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

    // Every recording still held, for stop() to save: those queued, then those of `clients` with any
    // samples. Forgets the queued ones.
    public takeRecordings(clients: Iterable<RecordedVoiceClient>): RecordedVoiceClient[] {
        const pendingRecordings = this.droppedRecordings.concat(Array.from(clients).filter(client => client.recordingData.length > 0));
        this.droppedRecordings = [];
        return pendingRecordings;
    }

    // Saves what takeRecordings returned, one at a time.
    public async saveBeforeStopping(pendingRecordings: readonly RecordedVoiceClient[]): Promise<void> {
        if (pendingRecordings.length === 0) return;

        this.callbacks.logInfo(`Saving ${pendingRecordings.length} voice recording(s) still in progress before stopping`);
        for (const client of pendingRecordings) {
            await this.saveRecording(client);
        }
    }

    // Never throws: a failed save is logged. Nothing here re-encodes the samples on the main
    // thread (see wavHeader): writeFile hands their bytes to the file system in chunks.
    //
    // The app and the source port are in the file name because the start time and the voice id
    // alone do not tell recordings apart: two apps may use the same voice id, and after a
    // restart or a dropped network every client registers again within the same few ms. Two
    // recordings with the same name used to overwrite each other without a word.
    private async saveRecording(client: RecordedVoiceClient): Promise<void> {
        const samples = client.recordingData.toTypedArray();
        const dateString = client.recordingStartDate.toISOString().replace(/:/g, '_');
        const filename = path.join(this.voiceRecordingPath,
            `rec_${dateString}_app_${formatAppId(client.appId)}_ID_${client.userId}_port_${client.port}.wav`);
        const seconds = (samples.length / this.samplingRate).toFixed(1);
        try {
            await mkdir(this.voiceRecordingPath, { recursive: true });
            await writeFile(filename, [ wavHeader(this.samplingRate, samples.byteLength), littleEndianBytes(samples) ]);
            this.callbacks.logInfo(`Voice recording of client ID ${client.userId} (${voiceClientKey(client.ip, client.port)}, ${seconds} s) saved to ${filename}`);
        } catch (err) {
            // An fs error names the file itself.
            this.callbacks.logError(`Failed to save the voice recording of client ID ${client.userId} (${voiceClientKey(client.ip, client.port)}, ${seconds} s): `
                + `${errorMessage(err)}`, false);
        }
    }
}
