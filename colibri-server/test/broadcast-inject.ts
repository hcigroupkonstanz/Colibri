// Sends one broadcast::<type> frame as a second client, for driving a specific case in
// another client (e.g. a deliberate channel/type mismatch).
//
//   npx tsx test/broadcast-inject.ts <app> <channel> <command> '<jsonPayload>' [repeats]
import * as net from 'net';
import { Config } from '../src/server/configuration.js';
import {
    FrameReader,
    FrameType,
    PROTOCOL_VERSION,
    encodeHandshakeFrame,
    encodeHeartbeatFrame,
    encodeMessageFrame,
} from '../src/server/modules/networking/protocol.js';

const [app, channel, command, payload, repeatsRaw] = process.argv.slice(2);
const repeats = Number(repeatsRaw ?? 1);
const onError = (err?: Error) => err && console.error(err);
const reader = new FrameReader();
const client = new net.Socket();

client.on('data', data => {
    for (const frame of reader.append(data)) {
        if (frame.type === FrameType.Heartbeat && !client.writableEnded) {
            client.write(encodeHeartbeatFrame(frame.pingTimestamp), onError);
        }
    }
});

client.on('error', err => console.error(err));

client.connect(Config.TCP_PORT, '127.0.0.1', () => {
    client.write(encodeHandshakeFrame(PROTOCOL_VERSION, app, `broadcast-inject-${process.pid}`), onError);

    setTimeout(() => {
        for (let i = 0; i < repeats; i++) {
            client.write(
                encodeMessageFrame({
                    channel,
                    command,
                    payload: Buffer.from(payload, 'utf8'),
                }),
                onError
            );
        }
        console.log(`-> ${channel} / ${command} :: ${payload}  x${repeats}`);
    }, 1500);

    setTimeout(() => client.end(), 6000);
});
