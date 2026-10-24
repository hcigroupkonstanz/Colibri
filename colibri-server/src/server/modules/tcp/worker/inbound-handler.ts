import type * as tls from 'tls';
import type { AppIndex } from '../../core/app-index.js';
import { CONNECTION_LINE } from '../../core/log-message.js';
import type { Metadata } from '../../core/log-message.js';
import {
    COLIBRI_CHANNEL,
    FrameError,
    FrameType,
    MAX_FRAME_LENGTH,
    PROTOCOL_REJECTED_COMMAND,
    PROTOCOL_VERSION,
    V1FramingError,
    encodeMessageFrame,
    looksLikeTlsHandshake,
    ownBytes,
    protocolRejection,
} from '../../protocol/protocol.js';
import type { DecodedFrame } from '../../protocol/protocol.js';
import { isLimitable } from '../../limits/inbound-limits.js';
import type { TcpClientConnected } from '../worker-messages.js';
import { AddressThrottle } from './address-throttle.js';
import type { InboundGate } from './inbound-gate.js';
import type { ProxyProtocolGate } from './proxy-protocol-gate.js';
import type { TcpClient } from './tcp-client.js';

// A channel or command may be up to 64 KiB; a log line names only this much of one.
const abbreviateName = (name: string): string => (name.length > 200 ? `${name.slice(0, 200)}...` : name);

type FrameOf<T extends FrameType> = Extract<DecodedFrame, { type: T }>;

// The TCP worker's client indexes and gates: the instances it keeps for its lifetime.
interface InboundHandlerParts {
    waitingClients: Map<string, TcpClient>;
    clients: Map<string, TcpClient>;
    clientsByApp: AppIndex<TcpClient>;
    proxyProtocolGate: ProxyProtocolGate;
    inboundGate: InboundGate;
}

// What InboundHandler needs from the TCP worker that owns it.
interface InboundHandlerCallbacks {
    // Ends the connection from this side; see TCPServerWorker.closeClient.
    closeClient(client: TcpClient, finalPacket?: Buffer): void;
    postMessage(channel: string, content: { [key: string]: unknown }): void;
    logDebug(msg: string, metadata?: Metadata): void;
    logWarning(msg: string): void;
    logError(msg: string, printStacktrace: boolean): void;
}

// The TCP worker's read path: decodes what its clients send, accepts or refuses their handshakes and
// passes their messages on through InboundGate. One for all clients.
export class InboundHandler {
    private readonly waitingClients: Map<string, TcpClient>;
    private readonly clients: Map<string, TcpClient>;
    private readonly clientsByApp: AppIndex<TcpClient>;
    private readonly proxyProtocolGate: ProxyProtocolGate;
    private readonly inboundGate: InboundGate;

    // When a Colibri 1.x client at each remote address was last warned about.
    private readonly v1WarnedAt = new AddressThrottle();
    // The same for a TLS client on an unencrypted port.
    private readonly tlsWithoutTlsPortWarnedAt = new AddressThrottle();
    // The same for a connection closed for a message before its handshake.
    private readonly noHandshakeWarnedAt = new AddressThrottle();

    public constructor(parts: InboundHandlerParts, private readonly callbacks: InboundHandlerCallbacks) {
        this.waitingClients = parts.waitingClients;
        this.clients = parts.clients;
        this.clientsByApp = parts.clientsByApp;
        this.proxyProtocolGate = parts.proxyProtocolGate;
        this.inboundGate = parts.inboundGate;
    }

    public handleSocketData(client: TcpClient, data: Buffer): void {
        // A client this server has already refused or cut off: the peer can keep sending
        // until it notices our FIN, and none of it is meant to be acted on.
        if (client.disconnected) return;

        const now = performance.now();
        if (!this.acceptChunk(client, data, now)) return;

        const frames = this.readFrames(client, data);
        if (!frames) return;

        for (const frame of frames) {
            // A handshake earlier in this same chunk may have refused the client; the frames
            // queued behind it must not be relayed or logged as orphans.
            if (client.disconnected) return;

            switch (frame.type) {
                case FrameType.Handshake:
                    this.onHandshakeFrame(client, frame);
                    break;

                case FrameType.Heartbeat:
                    this.onHeartbeatFrame(client, frame);
                    break;

                case FrameType.Message:
                    if (!this.onMessageFrame(client, frame, now)) return;
                    break;
            }
        }
    }

    // False if it closed the client: nothing in the chunk is read.
    private acceptChunk(client: TcpClient, data: Buffer, now: number): boolean {
        client.reading.lastInboundAt = now;

        // A TLS client on an unencrypted port. Its handshake would otherwise go into the frame
        // reader, which reads a length field of 790 bytes or more from it and waits, silently, for
        // the rest of a frame that never comes, until the idle timeout; or rejects it as an invalid
        // frame, which names neither the client's setting nor the server's.
        if (!client.receivedAny) {
            client.receivedAny = true;
            if (!(client.socket as tls.TLSSocket).encrypted && looksLikeTlsHandshake(data)) {
                this.reportTlsClientWithoutTlsPort(client);
                this.callbacks.closeClient(client);
                return false;
            }
        }
        return true;
    }

    // Undefined if the bytes are no valid frames and it closed the client.
    private readFrames(client: TcpClient, data: Buffer): DecodedFrame[] | undefined {
        try {
            return client.reader.append(data);
        } catch (err) {
            if (err instanceof V1FramingError) {
                this.reportV1Client(client);
            } else {
                const reason = err instanceof FrameError ? err.message : String(err);
                this.callbacks.logError(
                    `Invalid frame from client ${client.id}, discarding buffer and terminating connection: ${reason}`,
                    false
                );
            }
            client.reader.reset();
            this.callbacks.closeClient(client);
            return undefined;
        }
    }

    private onHandshakeFrame(client: TcpClient, frame: FrameOf<FrameType.Handshake>): void {
        // A re-handshake can move the client to another app; what it sent in the old
        // one has to reach the main thread while it is still in the old one.
        this.inboundGate.releaseHeld(client);
        try {
            this.assignApp(client, frame.app, frame.name, frame.version);
        } catch (err) {
            this.callbacks.logError(
                `Invalid handshake packet received from client ${client.id}`,
                false
            );
            if (err instanceof Error) this.callbacks.logError(err.stack || '', false);
            else console.error(err);
        }
    }

    private onHeartbeatFrame(client: TcpClient, frame: FrameOf<FrameType.Heartbeat>): void {
        // One written after the client's large messages: it has read them all.
        if (frame.pingTimestamp > client.reading.lastLargeWrittenAt) client.reading.unreadLargeBytes = 0;
        this.handlePong(client, frame.pingTimestamp);
    }

    // False if it closed the client: the rest of the chunk is not read.
    private onMessageFrame(client: TcpClient, frame: FrameOf<FrameType.Message>, now: number): boolean {
        // A Colibri client handshakes before it sends anything else, so this is no
        // Colibri client, or not one this server can serve. Each such message used to
        // log an ERROR line, and a peer that kept sending was never closed: what it
        // sent kept it from looking idle. A loop of them stalled the main thread with
        // log lines.
        if (!client.app) {
            if (this.noHandshakeWarnedAt.shouldWarn(client.address, now)) {
                this.callbacks.logWarning(
                    `Closing the connection of client ${client.id} from ${client.address}: it sent a message ` +
                        `(${abbreviateName(frame.channel)} / ${abbreviateName(frame.command)}) before a handshake naming its app. ` +
                        'Logged at most once a minute per address.'
                );
            }
            this.callbacks.closeClient(client);
            return false;
        }

        client.traffic.received += 1;
        if (!isLimitable(frame.channel, frame.command)) {
            // Nothing may overtake what the client sent before it, so whatever of its
            // updates is held back goes first - a model::delete must not arrive ahead
            // of an update to the same object and have that update bring it back.
            this.inboundGate.releaseHeld(client);
            this.inboundGate.postClientMessage(client, frame.channel, frame.command, frame.payload);
        } else {
            this.inboundGate.acceptLimitable(client, frame.channel, frame.command, frame.payload, now);
        }
        return true;
    }

    private assignApp(client: TcpClient, app: string, name: string, version: string): void {
        // Refuse before the client is indexed, so a mismatched client never reaches an app's
        // broadcast set, never posts clientConnected$, and never shows up in the admin UI as
        // a half-connected ghost.
        if (version !== PROTOCOL_VERSION) {
            this.rejectProtocolVersion(client, name, version);
            return;
        }

        // A second handshake frame with a different app would otherwise leave the client in
        // its previous app's Set forever - TCPServerWorker.removeFromAppIndex only ever looks at the
        // client's *current* app - so a disconnected socket would keep receiving
        // writeToClient calls for the app it first announced.
        if (client.app) {
            this.clientsByApp.remove(client.app, client);
        }

        client.app = app;
        client.name = name;
        client.version = version;
        this.callbacks.logDebug(
            `Setting app of new colibri client '${name}' (${client.id}, v${version}) to "${app}"`,
            {
                clientApp: client.app,
                clientName: client.name,
                clientId: client.id,
                ...CONNECTION_LINE,
            }
        );
        this.waitingClients.delete(client.id);
        this.clients.set(client.id, client);
        this.clientsByApp.add(client.app, client);
        const connected: TcpClientConnected = {
            id: client.id,
            app,
            name,
            version,
            address: client.address,
            tls: (client.socket as tls.TLSSocket).encrypted === true,
            tlsAtProxy: this.proxyProtocolGate.tlsAtProxyFor(client.socket),
            connectedAt: client.connectedAt,
        };
        this.callbacks.postMessage('clientConnected$', connected as unknown as { [key: string]: unknown });
    }

    // Tells the client why it was refused and closes the connection. Only a client that speaks
    // this server's *framing* gets here - one whose handshake frame decoded, but announced another
    // protocol version - so it can read the refusal. A Colibri 1.x client never reaches this
    // method: its handshake is not a valid frame in the current framing, so FrameReader throws a
    // V1FramingError on its first bytes and reportV1Client names it instead (it could not decode
    // a refusal anyway). Either way the log line is the diagnostic an integrator will look at.
    //
    // end(packet) rather than write-then-end: it queues the rejection and the FIN together,
    // so the frame cannot be lost to a close that races the write callback.
    private rejectProtocolVersion(client: TcpClient, name: string, version: string): void {
        const rejection = protocolRejection(version);
        this.callbacks.logError(
            `Refusing client '${name}' (${client.id}, ${client.address}): ${rejection.reason}`,
            false
        );

        let packet: Buffer | undefined;
        try {
            packet = encodeMessageFrame({
                channel: COLIBRI_CHANNEL,
                command: PROTOCOL_REJECTED_COMMAND,
                payload: Buffer.from(JSON.stringify(rejection), 'utf8'),
            }, MAX_FRAME_LENGTH);
        } catch {
            // Nothing useful to say if even the refusal cannot be encoded - the socket is
            // going away either way.
        }
        this.callbacks.closeClient(client, packet);
    }

    // A 1.x client cannot be sent a refusal it would understand - the framing itself differs -
    // so this warning is the whole diagnostic. Before it, all the log said was an anonymous
    // "Invalid frame length: 1744830464" once a second, which names neither the client nor
    // the fix.
    private reportV1Client(client: TcpClient): void {
        if (!this.v1WarnedAt.shouldWarn(client.address, performance.now())) {
            this.callbacks.logDebug(`Refusing Colibri 1.x client ${client.id} from ${client.address} (warned about this address already)`);
            return;
        }

        this.callbacks.logWarning(
            `Refusing a connection from ${client.address}: it looks like a Colibri 1.x client (it speaks the 1.x wire format), ` +
                `but this server speaks protocol v${PROTOCOL_VERSION}. Upgrade the Colibri Unity package (de.uni.kn.colibri) ` +
                'in that app to 2.x. This is logged at most once a minute per address.'
        );
    }

    private reportTlsClientWithoutTlsPort(client: TcpClient): void {
        if (!this.tlsWithoutTlsPortWarnedAt.shouldWarn(client.address, performance.now())) {
            this.callbacks.logDebug(`Refusing TLS client ${client.id} from ${client.address} (warned about this address already)`);
            return;
        }

        this.callbacks.logWarning(
            `Refusing a connection from ${client.address}: it starts a TLS handshake, but this server's TCP port does not use ` +
                'TLS (TLS_CERT and TLS_KEY are not set). Untick \'Server supports SSL/TLS?\' in that Unity app\'s Colibri ' +
                'configuration, or set TLS_CERT and TLS_KEY on this server. This is logged at most once a minute per address.'
        );
    }

    // A client echoes a server-sent heartbeat frame's timestamp back verbatim; relay it
    // into the normal clientMessage$ pipeline as a 'colibri'/'latency' message so
    // MeasureLatency's existing round-trip math (unchanged) handles it exactly as it
    // would a message-level ping reply. hrtime is a system-wide monotonic clock, so a
    // timestamp this worker generated remains valid to diff against once it reaches the
    // main thread. The difference from before is purely in what it cost to get here: one
    // fixed 13-byte frame each way instead of a full channel/command/payload message.
    private handlePong(client: TcpClient, pingTimestamp: bigint): void {
        if (!client.app) return;

        // ownBytes: a Buffer.from() this small is a view into the 64 KiB Buffer pool, and
        // postMessage would clone all of it - ten times a second per client.
        this.inboundGate.postClientMessage(client, COLIBRI_CHANNEL, 'latency', ownBytes(Buffer.from(pingTimestamp.toString(), 'utf8')));
    }
}
