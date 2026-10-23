// Pass-through proxy in front of the v3 TCP port, printing every frame in both directions.
// Point a client's TCP port at this instead of the server's to see exactly what it puts on
// the wire - handshake bytes, heartbeat echoes, and whether a payload is quoted.
//
//   npx tsx test/tcp-wire-tap.ts [listenPort=9222] [serverPort=9212]
import * as net from 'net';
import { FrameReader, FrameType } from '../src/server/modules/protocol/protocol.js';

const listenPort = Number(process.argv[2] ?? 9222);
const serverPort = Number(process.argv[3] ?? 9212);

let heartbeatsUp = 0;
let heartbeatsDown = 0;

const describe = (direction: string, data: Buffer, reader: FrameReader) => {
    let frames;
    try {
        frames = reader.append(data);
    } catch (err) {
        console.log(`${direction} UNPARSEABLE: ${String(err)}`);
        return;
    }

    for (const frame of frames) {
        switch (frame.type) {
            case FrameType.Handshake:
                console.log(`${direction} HANDSHAKE version=${frame.version} app=${frame.app} name=${frame.name}`);
                break;
            case FrameType.Heartbeat:
                if (direction.startsWith('C')) heartbeatsUp += 1;
                else heartbeatsDown += 1;
                break;
            case FrameType.Message:
                console.log(
                    `${direction} MESSAGE ${frame.channel} / ${frame.command} ` +
                        `payload(${frame.payload.length}B)=${JSON.stringify(frame.payload.toString('utf8'))}`
                );
                break;
        }
    }
};

net.createServer(client => {
    console.log('client connected');
    const upstream = net.connect(serverPort, '127.0.0.1');
    const clientReader = new FrameReader();
    const serverReader = new FrameReader();

    client.on('data', d => {
        describe('C->S', d, clientReader);
        upstream.write(d);
    });
    upstream.on('data', d => {
        describe('S->C', d, serverReader);
        client.write(d);
    });

    const close = () => {
        console.log(`client gone (heartbeats: server->client ${heartbeatsDown}, echoed back ${heartbeatsUp})`);
        client.destroy();
        upstream.destroy();
    };
    client.on('close', close);
    client.on('error', close);
    upstream.on('close', close);
    upstream.on('error', close);
}).listen(listenPort, () => console.log(`wire tap listening on ${listenPort}, forwarding to ${serverPort}`));

setTimeout(() => process.exit(0), Number(process.env.TAP_MS ?? 30000));
