import * as net from 'net';
import * as _ from 'lodash';
import { WorkerService } from '../core';
import * as threads from 'worker_threads';
import * as flatbuffers from 'flatbuffers';
import { Message } from './message';
import { NetworkMessage } from 'modules/command-hooks';
import { v4 as uuidv4 } from 'uuid';

export const UNITY_SERVER_WORKER = __filename;

interface TcpClient {
    id: string;
    socket: net.Socket;
    leftOverBuffer: Buffer;
    address: string;
    app: string;
    version: number;
}

export class UnityServerWorker extends WorkerService {
    private server!: net.Server;

    // waiting for client to specify app name
    private readonly waitingClients: TcpClient[] = [];
    // properly connected clients
    private readonly clients: TcpClient[] = [];

    private heartbeatInterval!: NodeJS.Timer;
    private idCounter = 0;

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

        this.logInfo(`Starting Unity server on *:${port}`);
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
        const payload = builder.createString(JSON.stringify(msg.payload));

        Message.startMessage(builder);
        Message.addChannel(builder, channel);
        Message.addCommand(builder, command);
        Message.addPayload(builder, payload);
        const message = Message.endMessage(builder);
        builder.finish(message);

        const msgBytes = builder.asUint8Array();
        // FIXME: we don't want to deal with big/little endian, so we just use utf8 encoding for packet length
        const packetHeader = new TextEncoder().encode(`\0\0\0${msgBytes.length.toString()}\0`);

        for (const client of clients) {
            // message format:
            // \0\0\0(PacketHeader)\0(ActualMessage)
            const tcpClient = client;
            tcpClient.socket.write(packetHeader);
            tcpClient.socket.write(msgBytes);
        }

    }

    private handleConnection(socket: net.Socket): void {
        const id = uuidv4();
        this.logDebug(`New unity client (${id}) connected from ${socket.remoteAddress}, waiting for app name`);
        socket.setNoDelay(true);

        const tcpClient: TcpClient = {
            id,
            socket,
            leftOverBuffer: Buffer.alloc(0),
            address: socket.remoteAddress || 'UNDEFINED',
            app: '',
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
            const headerStart = buffer.indexOf('\0\0\0');

            if (headerStart === -1) {
                // invalid packet?!
                this.logError(`Invalid packet received from client ${client.id}, discarding buffer`);
                client.leftOverBuffer = Buffer.alloc(0);
                break;
            }

            const headerEnd = buffer.indexOf('\0', headerStart + 4);

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
                const packetEnd = buffer.indexOf('\0', headerEnd + 1);

                if (packetEnd < 0) {
                    // incomplete packet, store leftovers
                    client.leftOverBuffer = buffer;
                    break;
                }

                packetLength = packetEnd - headerEnd;
                const packet = buffer.subarray(headerEnd + 1).toString();
                const version = packet.substring(0, packet.indexOf('::'));
                const app = packet.substring(packet.indexOf('::') + '::'.length);

                this.assignApp(client, app, Number(version));
            } else {
                // Packet with payload (normal message)
                packetLength = Number(header);
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
                        payload: JSON.parse(message.payload() || '{}'),
                        origin: { id: client.id, app: client.app }
                    });
                } catch (err) {
                    console.log(err);
                }
            }

            // if there are multiple packets in the buffer, begin anew
            buffer = buffer.subarray(headerEnd + 1 + packetLength);

        }

        // clear leftover buffers once we're finished
        if (buffer.length === 0) {
            client.leftOverBuffer = Buffer.alloc(0);
        }

        // pass on actual messages
        for (const msg of msgs) {
            if (client.app) {
                this.postMessage('clientMessage$', msg as unknown as { [key: string]: unknown });
            } else {
                this.logError(`Ignoring message (${msg.channel} / ${msg.command}) from client ${client.id} without app`);
            }
        }
    }

    private assignApp(client: TcpClient, app: string, version: number): void {
        this.logDebug(`Setting app of unity client "${client.id}" (v${version}) to "${app}"`);
        client.app = app;
        client.version = version;
        _.pull(this.waitingClients, client);
        this.clients.push(client);
        this.postMessage('clientConnected$', { id: client.id, app });
    }


    private handleSocketError(client: TcpClient, error: Error): void {
        this.logError(error.message);
        this.handleSocketDisconnect(client);
    }

    private handleSocketDisconnect(client: TcpClient): void {
        this.logDebug(`Unity client ${client.address} disconnected`);
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




    // adapted from http://stackoverflow.com/a/18729931
    private toUTF8Array(str: string): number[] {
        const utf8: number[] = [];

        for (let i = 0; i < str.length; i++) {
            let charcode = str.charCodeAt(i);
            if (charcode < 0x80) { utf8.push(charcode); } else if (charcode < 0x800) {
                // tslint:disable-next-line:no-bitwise
                utf8.push(0xc0 | (charcode >> 6), 0x80 | (charcode & 0x3f));
            } else if (charcode < 0xd800 || charcode >= 0xe000) {
                // tslint:disable-next-line:no-bitwise
                utf8.push(0xe0 | (charcode >> 12), 0x80 | ((charcode >> 6) & 0x3f), 0x80 | (charcode & 0x3f));
            } else {
                i++;
                // UTF-16 encodes 0x10000-0x10FFFF by
                // subtracting 0x10000 and splitting the
                // 20 bits of 0x0-0xFFFFF into two halves
                // tslint:disable-next-line:no-bitwise
                charcode = 0x10000 + (((charcode & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
                // tslint:disable-next-line:no-bitwise
                utf8.push(0xf0 | (charcode >> 18), 0x80 | ((charcode >> 12) & 0x3f), 0x80 | ((charcode >> 6) & 0x3f), 0x80 | (charcode & 0x3f));
            }
        }
        return utf8;
    }
}


if (!threads.isMainThread) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const server = new UnityServerWorker();
}
