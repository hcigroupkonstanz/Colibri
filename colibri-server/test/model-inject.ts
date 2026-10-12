// Injects model::update frames as a second client, so a Unity client's *receive* side -
// SyncTransformManager instantiating a template, SyncBehaviour applying [Sync] members - can
// be exercised without a second Unity instance.
//
//   npx tsx test/model-inject.ts <app> <channel> '<json>' [moreJson...]
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

const [app, channel, ...payloads] = process.argv.slice(2);
const onError = (err?: Error) => err && console.error(err);
const reader = new FrameReader();
const client = new net.Socket();

client.on('data', data => {
    for (const frame of reader.append(data)) {
        if (frame.type === FrameType.Heartbeat) {
            if (!client.writableEnded) client.write(encodeHeartbeatFrame(frame.pingTimestamp), onError);
        } else if (frame.type === FrameType.Message) {
            console.log(`<- ${frame.channel} / ${frame.command} :: ${frame.payload.toString('utf8')}`);
        }
    }
});

client.on('error', err => console.error(err));

client.connect(Config.TCP_PORT, '127.0.0.1', () => {
    client.write(encodeHandshakeFrame(PROTOCOL_VERSION, app, `model-inject-${process.pid}`), onError);

    setTimeout(() => {
        for (const payload of payloads) {
            console.log(`-> ${channel} / model::update :: ${payload}`);
            client.write(
                encodeMessageFrame({
                    channel,
                    command: 'model::update',
                    payload: Buffer.from(payload, 'utf8'),
                }),
                onError
            );
        }
    }, 1500);

    setTimeout(() => client.end(), Number(process.env.INJECT_MS ?? 15000));
});
