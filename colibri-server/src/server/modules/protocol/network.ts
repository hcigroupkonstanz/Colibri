import type { Observable } from 'rxjs';
import type { Payload } from './payload.js';

export interface NetworkMessage {
    origin?: NetworkClient;
    channel: string;
    command: string;
    payload?: Payload;
}

export interface NetworkClient {
    id: string;
    app: string;
    name: string;
    version: string;
    metadata: Record<string, unknown>;
}

// How a transport treats a message for a client that is falling behind.
// 'relay' (default): traffic between clients, where only the latest counts; dropped for a recipient
// too far behind (ClientWriter.writeToClient).
// 'reply': the server's answer to one client's own request (model::request). Nothing resends it, so it
// is queued instead; only a separate backlog limit drops it.
export type Delivery = 'relay' | 'reply';

export abstract class NetworkServer {
    public abstract get currentClients(): ReadonlyArray<NetworkClient>;
    public abstract get messages$(): Observable<NetworkMessage>;
    public abstract get clientConnected$(): Observable<NetworkClient>;
    public abstract get clientDisconnected$(): Observable<NetworkClient>;
    public abstract broadcast(message: NetworkMessage, clients: ReadonlyArray<NetworkClient>, delivery?: Delivery): void;

    // Optional fast path for broadcasting to one app. A transport that groups clients (Socket.IO rooms)
    // encodes the packet once per group; without it ConnectionPool falls back to broadcast().
    // Implementations must return before touching message.payload when the app has no recipient:
    // resolving a payload across transports costs a JSON parse or stringify, and every client
    // connect/disconnect broadcasts to app 'colibri', whose clients in practice sit on one transport.
    public broadcastToApp?(message: NetworkMessage, app: string, exceptClientId?: string): void;
}
