// A far end for colibri-unity's Network Stress sample.
//
// The stress harness measures latency by round trip: it sends a numbered ping on its probe
// channel and times how long the echo takes to come back. That needs a second client, and the
// server excludes a sender from its own broadcasts, so one editor on its own can never measure
// anything. This is a raw v3 client that does nothing but answer probes - enough to get real
// numbers out of a single editor, and a known-good reference when a second Unity would only be
// one more variable.
//
//   npx tsx test/stress-echo-peer.ts [app] [seconds]
//
// The app name must match the Unity client's (Window -> Colibri Configuration). Defaults to
// 'myAppName', which is what a fresh project uses.
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

const PROBE_CHANNEL = 'colibri-stress-probe';

const app = process.argv[2] ?? 'myAppName';
const runSeconds = Number(process.argv[3] ?? 0);

const onError = (err: Error | undefined) => {
    if (err) console.error(err);
};

const reader = new FrameReader();
const client = new net.Socket();

let echoed = 0;
let heartbeats = 0;
let lastReport = 0;

client.on('data', data => {
    for (const frame of reader.append(data)) {
        switch (frame.type) {
            case FrameType.Heartbeat:
                heartbeats += 1;
                // Not echoing these gets this peer dropped after two seconds, which shows up at
                // the other end as every probe suddenly going missing.
                if (!client.writableEnded) client.write(encodeHeartbeatFrame(frame.pingTimestamp), onError);
                break;

            case FrameType.Message:
                if (frame.channel === PROBE_CHANNEL) echoProbe(frame.payload);
                break;
        }
    }
});

const echoProbe = (payload: Buffer): void => {
    let probe: { o?: string; s?: number; e?: boolean };
    try {
        probe = JSON.parse(payload.toString('utf8'));
    } catch {
        return; // Not one of ours.
    }

    // Only pings are answered. Echoing an echo would put the two ends in a loop that never ends
    // and would read, at the harness, as a latency that improves the more it is measured.
    if (probe.e || typeof probe.o !== 'string') return;

    client.write(
        encodeMessageFrame({
            channel: PROBE_CHANNEL,
            command: 'broadcast::json',
            payload: Buffer.from(JSON.stringify({ o: probe.o, s: probe.s, e: true }), 'utf8'),
        }),
        onError
    );

    echoed += 1;

    // One line a second rather than one per probe: at 200 Hz the log would cost more than the
    // echoing does.
    const now = Date.now();
    if (now - lastReport >= 1000) {
        lastReport = now;
        console.log(`echoed ${echoed} probe(s), ${heartbeats} heartbeat(s)`);
    }
};

client.on('error', err => console.error(err));
client.on('close', () => console.log(`done: echoed ${echoed} probe(s), ${heartbeats} heartbeat(s)`));

client.connect(Config.TCP_PORT, '127.0.0.1', () => {
    console.log(`connected, handshaking as app "${app}" - echoing ${PROBE_CHANNEL}`);
    client.write(encodeHandshakeFrame(PROTOCOL_VERSION, app, `stress-echo-${process.pid}`), onError);

    if (runSeconds > 0) setTimeout(() => client.end(), runSeconds * 1000);
});
