// Temporary diagnostic: a v3 TCP client that joins the *same* app as the colibri-web
// verification peer, so that "does the server relay Socket.IO <-> TCP at all" can be
// answered without Unity in the picture.
//
//   tsx test/tcp-crosstalk-check.ts [app] [milliseconds] [--tls [--insecure]] [--host <name>]
//
// See tcp-probe-connection.ts for the options.
import { Config } from '../src/server/configuration.js';
import {
    FrameReader,
    FrameType,
    PROTOCOL_VERSION,
    encodeHandshakeFrame,
    encodeHeartbeatFrame,
    encodeMessageFrame,
} from '../src/server/modules/networking/protocol.js';
import { connectProbe, parseProbeArgs, probeErrorHint } from './tcp-probe-connection.js';

const options = parseProbeArgs(process.argv.slice(2));
const app = options.args[0] ?? 'myAppName';
const runMillis = Number(options.args[1] ?? 20000);
const hostname = `tcp-crosstalk-${process.pid}`;

const onError = (err?: Error | null) => {
    if (err) console.error(err);
};

const reader = new FrameReader();
let heartbeats = 0;
let messages = 0;
let ready = false;

const client = connectProbe(options, Config.TCP_PORT, () => {
    ready = true;
    console.log(`handshaking as app "${app}"`);
    client.write(encodeHandshakeFrame(PROTOCOL_VERSION, app, hostname), onError);

    setTimeout(() => {
        console.log('-> sending broadcast::string on myChannel');
        client.write(
            encodeMessageFrame({
                channel: 'myChannel',
                command: 'broadcast::string',
                payload: Buffer.from(JSON.stringify('hello from the raw tcp client'), 'utf8'),
            }),
            onError
        );
    }, 2000);

    setTimeout(() => client.end(), runMillis);
});

client.on('data', (data: Buffer) => {
    for (const frame of reader.append(data)) {
        switch (frame.type) {
            case FrameType.Heartbeat:
                heartbeats += 1;
                if (!client.writableEnded) client.write(encodeHeartbeatFrame(frame.pingTimestamp), onError);
                break;
            case FrameType.Message:
                messages += 1;
                console.log(`<- ${frame.channel} / ${frame.command} :: ${frame.payload.toString('utf8')}`);
                break;
            case FrameType.Handshake:
                console.log(`<- handshake ${frame.version} / ${frame.app} / ${frame.name}`);
                break;
        }
    }
});

client.on('error', err => {
    console.error(err);
    const hint = ready ? undefined : probeErrorHint(options, err);
    if (hint) console.error(hint);
});
client.on('close', () => console.log(`done: ${heartbeats} heartbeat(s), ${messages} message(s)`));
