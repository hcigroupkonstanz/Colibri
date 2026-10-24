import { CONNECTION_LINE } from '../core/log-message.js';
import type { Metadata } from '../core/log-message.js';
import { voiceClientKey } from './voice-client-key.js';

// What VoiceClients reads of a voice client.
interface ListedVoiceClient {
    readonly ip: string;
    readonly port: number;
    readonly userId: number;
    readonly appId: number;
}

// What VoiceClients needs from VoiceServer. logDebug is the server's own, so the lines keep its name
// as their origin.
interface VoiceClientsCallbacks<C> {
    leaveGroup(client: C): void;
    logDebug(msg: string, metadata?: Metadata): void;
    queueRecording(client: C): void;
}

const NO_CLIENTS: readonly never[] = [];

// The VoiceServer's voice clients, by voiceClientKey, and those of each app. VoiceServer reads and
// writes `clients` itself.
export class VoiceClients<C extends ListedVoiceClient> {
    public readonly clients = new Map<string, C>();

    // The voice clients of each app, by appId. Built lazily and kept, as relaying runs per packet
    // (up to ~50/s per client).
    private appClients: Map<number, C[]> | undefined;

    public constructor(private readonly callbacks: VoiceClientsCallbacks<C>) {}

    // Call when a client joins, leaves or changes app.
    public invalidateAppClients(): void {
        this.appClients = undefined;
    }

    public getAppClients(appId: number): readonly C[] {
        if (!this.appClients) {
            this.appClients = new Map<number, C[]>();
            for (const client of this.clients.values()) {
                const app = this.appClients.get(client.appId);
                if (app) app.push(client);
                else this.appClients.set(client.appId, [ client ]);
            }
        }
        return this.appClients.get(appId) ?? NO_CLIENTS;
    }

    // Takes `client` out of the clients relayed to and from, and says why in a connection line. Its
    // recording is saved by the next disconnect check, or stop().
    public dropVoiceClient(client: C, why?: string): void {
        this.clients.delete(voiceClientKey(client.ip, client.port));
        this.callbacks.leaveGroup(client);
        this.appClients = undefined;
        this.callbacks.logDebug(`Voice client ${voiceClientKey(client.ip, client.port)} disconnected ID: ${client.userId}` + (why ? `: ${why}` : ''), CONNECTION_LINE);
        this.callbacks.queueRecording(client);
    }
}
