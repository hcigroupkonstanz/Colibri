// Manual v3 protocol smoke test: connects, handshakes, then decodes what the server sends
// and echoes heartbeat frames back the way a real client must. Run against a live server
// (`npm run server:start` in another shell) with `npm run test:tcpclient`.
//
// The echo is what makes item 22 (heartbeat + latency ping merged into one frame)
// observable at all: the server derives a client's latency purely from the ping timestamp
// coming back in a 0x00 frame, so without a client that returns it there is nothing to see
// in the admin UI's latency chart.
//
// Exit codes: 0 connected and heartbeated, 1 something is wrong with the server (no heartbeat,
// or a frame this client cannot decode), 2 the server refused this client's protocol version -
// the expected outcome of `npm run test:tcpclient -- 1`.
//
// With TLS on the server: `npm run test:tcpclient -- --tls`, plus --insecure for a self-signed
// certificate, and --host <name> for another server than this one; see tcp-probe-connection.ts.
import { Config } from '../src/server/configuration.js';
import {
    COLIBRI_CHANNEL,
    FrameReader,
    FrameType,
    PROTOCOL_REJECTED_COMMAND,
    PROTOCOL_VERSION,
    ProtocolRejection,
    encodeHandshakeFrame,
    encodeHeartbeatFrame,
    encodeMessageFrame,
} from '../src/server/modules/networking/protocol.js';
import { PLAIN_PROBE_CLOSED_HINT, connectProbe, parseProbeArgs, probeErrorHint } from './tcp-probe-connection.js';

const EXIT_REFUSED = 2;

const options = parseProbeArgs(process.argv.slice(2));
const port = Config.TCP_PORT;
const app = 'TEST';
// Overridable so this doubles as the manual probe for the version check:
// `npm run test:tcpclient -- 1` should be refused with a colibri/protocol::rejected frame
// and an immediate close, instead of connecting.
const version = options.args[0] || PROTOCOL_VERSION;
const hostname = `tcp-client-test-${process.pid}`;
const runMillis = 3000;

const onError = (err?: Error | null) => {
    if (err) console.error(err);
};

const reader = new FrameReader();
let heartbeats = 0;
let messages = 0;
// Set once the server says why it is refusing this client; a refused client is never heartbeated,
// so without this the summary below blamed a missing heartbeat instead.
let refusal: Partial<ProtocolRejection> | undefined;
// Set when the server sent something this client cannot decode. That used to end the connection
// and nothing else, so after a heartbeat had arrived the script exited 0 as if all was well.
let undecodable = false;
// Whether the connection, and with --tls its handshake, was made at all, and how many bytes the
// server sent: a server that refuses a client without TLS closes without sending any.
let ready = false;
let received = 0;

const readRefusal = function (payload: Buffer): Partial<ProtocolRejection> {
    try {
        const parsed: unknown = JSON.parse(payload.toString('utf8'));
        if (parsed && typeof parsed === 'object') return parsed as Partial<ProtocolRejection>;
    } catch {
        // Reported below as a refusal without a readable reason.
    }
    return {};
};

let endTimer: NodeJS.Timeout | undefined;

const client = connectProbe(options, port, () => {
    ready = true;
    console.log('Sending handshake');
    client.write(encodeHandshakeFrame(version, app, hostname), onError);

    // One real message, so the server's ingress path is exercised too and anything the
    // server relays back to this app shows up in the log above.
    client.write(
        encodeMessageFrame({
            channel: `${app}::test`,
            command: 'ping',
            payload: Buffer.from(JSON.stringify({ from: hostname }), 'utf8'),
        }),
        onError
    );

    endTimer = setTimeout(() => client.end(), runMillis);
});

client.on('data', (data: Buffer) => {
    received += data.length;
    let frames;
    try {
        frames = reader.append(data);
    } catch (err) {
        console.error('Malformed frame from server:', err);
        undecodable = true;
        client.destroy();
        return;
    }

    for (const frame of frames) {
        switch (frame.type) {
            case FrameType.Heartbeat:
                heartbeats += 1;
                // Echoed back verbatim - the server diffs it against its own clock. The
                // server keeps sending heartbeats until it notices the half-closed socket,
                // so stop replying once this side has ended.
                if (!client.writableEnded) {
                    client.write(encodeHeartbeatFrame(frame.pingTimestamp), onError);
                }
                break;

            case FrameType.Message:
                messages += 1;
                console.log(
                    `<- message ${frame.channel} / ${frame.command} (${frame.payload.length} payload bytes)`
                );
                if (frame.channel === COLIBRI_CHANNEL && frame.command === PROTOCOL_REJECTED_COMMAND) {
                    refusal = readRefusal(frame.payload);
                }
                break;

            case FrameType.Handshake:
                console.log(`<- handshake ${frame.version} / ${frame.app} / ${frame.name}`);
                break;
        }
    }
});

client.on('error', (err) => {
    console.error(err);
    const hint = ready ? undefined : probeErrorHint(options, err);
    if (hint) console.error(hint);
});

client.on('close', () => {
    clearTimeout(endTimer);
    console.log(`Disconnected after ${heartbeats} heartbeat(s) and ${messages} message(s)`);

    // First: a frame that cannot be decoded is a broken server whatever came before it, and
    // the frames that arrived along with it were never seen.
    if (undecodable) {
        console.error('FAILED: the server sent a frame this client cannot decode (see above)');
        process.exitCode = 1;
    } else if (refusal) {
        console.error(
            `REFUSED: the server speaks protocol v${refusal.serverVersion ?? '?'}, ` +
                `and this client announced '${refusal.clientVersion ?? version}'.`
        );
        console.error(`         ${refusal.reason ?? '(no reason given)'}`);
        process.exitCode = EXIT_REFUSED;
    } else if (!ready) {
        console.error(`FAILED: could not connect${options.tls ? ' with TLS' : ''} (see above)`);
        process.exitCode = 1;
    } else if (heartbeats === 0) {
        console.error('No heartbeat received - the server is not sending v3 heartbeat frames');
        if (received === 0 && !options.tls) console.error(PLAIN_PROBE_CLOSED_HINT);
        process.exitCode = 1;
    }
});
