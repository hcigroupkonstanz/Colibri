import * as net from 'net';
import * as _ from 'lodash';
import { WorkerService } from '../core';
import * as threads from 'worker_threads';
import * as flatbuffers from 'flatbuffers';
import { Message } from './message';
import { NetworkMessage } from 'modules/command-hooks';
import { v4 as uuidv4 } from 'uuid';

export const TCP_SERVER_WORKER = __filename;
const maxBufferSize = 1024 * 1024 * 5;

interface TcpClient {
    id: string;
    socket: net.Socket;
    leftOverBuffer: Buffer;
    address: string;
    app: string;
    version: number;
    name: string;
}

export class TCPServerWorker extends WorkerService {
    private server!: net.Server;

    // waiting for client to specify app name
    private readonly waitingClients: TcpClient[] = [];
    // properly connected clients
    private readonly clients: TcpClient[] = [];

    private heartbeatInterval!: NodeJS.Timeout;

    public constructor() {
        super(true);

        this.parentMessages$.subscribe(msg => {
            switch (msg.channel) {
                case 'm:start':
                    this.start(msg.content.port as number);
                    break;

                case 'm:stop':
                    this.stop();
                    break;

                case 'm:broadcast': {
                    const ids = msg.content.clients as string[];
                    const clients = ids
                        .map(id => this.clients.find(c => c.id === id))
                        .filter((c): c is TcpClient => !!c);

                    this.broadcast(msg.content.msg as NetworkMessage, clients);
                    break;
                }
            }
        });
    }

    public start(port: number): void {
        this.server = net.createServer((socket) => this.handleConnection(socket));
        this.server.listen(port);

        this.logInfo(`Starting Colibri TCP server on *:${port}`);
        this.heartbeatInterval = setInterval(() => this.handleHeartbeat(), 100);
    }

    public stop(): void {
        this.server.close();
        clearInterval(this.heartbeatInterval);
    }



    public broadcast(msg: NetworkMessage, clients: ReadonlyArray<TcpClient>): void {
        if (clients.length === 0) {
            return;
        }

        const builder = new flatbuffers.Builder(1024);
        const channel = builder.createString(msg.channel);
        const command = builder.createString(msg.command);
        // TODO: replace this with dictionary to avoid JSON serialization
        //       see: https://flatbuffers.dev/flatbuffers_guide_use_c-sharp.html#autotoc_md93
        const payload = builder.createString(msg.payload);

        Message.startMessage(builder);
        Message.addChannel(builder, channel);
        Message.addCommand(builder, command);
        Message.addPayload(builder, payload);
        const message = Message.endMessage(builder);
        builder.finish(message);

        const msgBytes = builder.asUint8Array();
        // FIXME: we don't want to deal with big/little endian, so we just use utf8 encoding for packet length
        const packetHeader = new TextEncoder().encode(`\0\0\0${msgBytes.length.toString()}\0`);

        // TODO:  could probably be more efficient!
        const mergedPacket = new Uint8Array(packetHeader.length + msgBytes.length);
        mergedPacket.set(packetHeader);
        mergedPacket.set(msgBytes, packetHeader.length);

        for (const client of clients) {
            // message format:
            // \0\0\0(PacketHeader)\0(ActualMessage)
            const tcpClient = client;
            tcpClient.socket.write(mergedPacket, (err) => {
                if (err) {
                    this.logWarning(`Failed to send message to client ${client.id}: ${err.message} `);
                }
            });
        }

    }

    private handleConnection(socket: net.Socket): void {
        const id = uuidv4();
        this.logDebug(`New client (${id}) connected from ${socket.remoteAddress}, waiting for app name`);
        socket.setNoDelay(true);

        const tcpClient: TcpClient = {
            id,
            socket,
            leftOverBuffer: Buffer.alloc(0),
            address: socket.remoteAddress || 'UNDEFINED',
            app: '',
            name: '',
            version: 0
        };
        this.waitingClients.push(tcpClient);

        socket.on('data', (data) => {
            this.handleSocketData(tcpClient, data);
        });

        socket.on('error', (error) => {
            this.handleSocketError(tcpClient, error);
        });

        socket.on('end', () => {
            this.handleSocketDisconnect(tcpClient);
        });
    }

    private handleSocketData(client: TcpClient, data: Buffer): void {
        let buffer = Buffer.concat([client.leftOverBuffer, data]);
        const msgs: NetworkMessage[] = [];

        while (buffer.length > 0) {
            if (buffer.subarray(0, 3).toString() !== '\0\0\0') {
                // invalid packet?!
                this.logError(`Invalid packet received from client ${client.id}, discarding buffer`, false);
                client.leftOverBuffer = Buffer.alloc(0);
                break;
            }

            const headerStart = 0;
            const headerEnd = buffer.indexOf(0, headerStart + 4);

            if (headerEnd < 0) {
                // incomplete packet, store leftovers
                client.leftOverBuffer = buffer;
                break;
            }

            const packetLengthBuffer = buffer.subarray(headerStart + 3, headerEnd);
            // FIXME: we don't want to deal with big/little endian, so we just use utf8 encoding for packet length
            //        also the header might contain more than just the packet length, so we need to parse it
            const header = packetLengthBuffer.toString('utf8');
            let packetLength: number;

            if (header === 'h') {
                // handshake
                const packetEnd = buffer.indexOf(0, headerEnd + 1);

                if (packetEnd < 0) {
                    // incomplete packet, store leftovers
                    client.leftOverBuffer = buffer;
                    break;
                }

                packetLength = packetEnd - headerEnd;
                const packet = buffer.subarray(headerEnd, packetEnd).toString().replace(/\0/g, '');
                try {
                    const [ version, app, name ] = packet.split('::');
                    this.assignApp(client, app, name, Number(version));
                } catch (err) {
                    this.logError(`Invalid handshake packet received from client ${client.id}`, false);
                    if (err instanceof Error)
                        this.logError(err.stack || '', false);
                    else
                        console.error(err);
                }
            } else {
                // Packet with payload (normal message)
                packetLength = Number(header);
                if (!Number.isFinite(packetLength)) {
                    this.logError(`Invalid header received from client ${client.id}, discarding buffer`, false);
                    this.logDebug(`Header: ${header}`);
                    client.leftOverBuffer = Buffer.alloc(0);
                    break;
                }

                const packetEnd = headerEnd + 1 + packetLength;
                
                if (packetEnd > buffer.length) {
                    // incomplete packet, store leftovers
                    client.leftOverBuffer = buffer;
                    break;
                }

                const packet = buffer.subarray(headerEnd + 1, packetEnd);
                const packetBuffer = new flatbuffers.ByteBuffer(packet);
                const message = Message.getRootAsMessage(packetBuffer);

                try {
                    msgs.push({
                        channel: message.channel() || '',
                        command: message.command() || '',
                        payload: message.payload() || '',
                        origin: { id: client.id, app: client.app, name: client.name, metadata: {} }
                    });
                } catch (err) {
                    if (err instanceof Error)
                        this.logError(err.stack || '', false);
                    else
                        console.error(err);
                }
            }

            // if there are multiple packets in the buffer, begin anew
            buffer = buffer.subarray(headerEnd + 1 + packetLength);
        }

        // clear leftover buffers once we're finished
        if (buffer.length === 0) {
            client.leftOverBuffer = Buffer.alloc(0);
        }

        // try to somewhat mitigate spamming clients
        if (client.leftOverBuffer.length > maxBufferSize) {
            this.logWarning(`Client ${client.id} exceeds max buffer size (${maxBufferSize} bytes), discarding buffer and terminating connection`);
            client.socket.end();
        }

        // pass on actual messages
        for (const msg of msgs) {
            if (client.app) {
                this.postMessage('clientMessage$', msg as unknown as { [key: string]: unknown });
            } else {
                this.logError(`Ignoring message (${msg.channel} / ${msg.command}) from client ${client.id} without app`, false);
            }
        }
    }

    private assignApp(client: TcpClient, app: string, name: string, version: number): void {
        client.app = app;
        client.name = name;
        client.version = version;
        this.logDebug(`Setting app of new colibri client '${name}' (${client.id}, v${version}) to "${app}"`, {
            clientApp: client.app,
            clientName: client.name,
            clientId: client.id
        });
        _.pull(this.waitingClients, client);
        this.clients.push(client);
        this.postMessage('clientConnected$', { id: client.id, app });
    }


    private handleSocketError(client: TcpClient, error: Error): void {
        // ignore ECONNRESET errors, as they are caused by the client disconnecting
        if (error.message.indexOf('ECONNRESET') === -1) {
            this.logError(error.message, false);
        }

        this.handleSocketDisconnect(client);
    }

    private handleSocketDisconnect(client: TcpClient): void {
        this.logDebug(`Colibri client ${client.address} disconnected`, {
            clientApp: client.app,
            clientName: client.name,
            clientId: client.id
        });
        _.pull(this.clients, client);
        _.pull(this.waitingClients, client);
        this.postMessage('clientDisconnected$', { id: client.id });
    }


    private handleHeartbeat() {
        for (const client of this.clients) {
            client.socket.write('\0\0\0h\0');
        }

        for (const client of this.waitingClients) {
            client.socket.write('\0\0\0h\0');
        }
    }
}


if (!threads.isMainThread) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const server = new TCPServerWorker();
}
