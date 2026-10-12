/**
 * Cross-implementation protocol vectors: encodes a fixed set of frames and voice packets with
 * *this* server's encoders and checks that colibri-unity's `ProtocolVectorTests.cs` still expects
 * the same bytes.
 *
 * The C# suite's round-trip tests only prove that the C# encoder and decoder agree with each
 * other - they would pass just as happily with both sides big-endian, or both off by one. The
 * hardcoded hex in ProtocolVectorTests is what actually catches drift between the two
 * implementations, and until now regenerating it meant reading a comment that said "run the
 * encoders from colibri-server and hex-dump the buffers" and doing it by hand. Nobody was ever
 * going to do that, which made the one file guarding wire compatibility the one file that would
 * quietly go stale.
 *
 * It also checks that every other hard-coded copy of the protocol version agrees with this
 * server's PROTOCOL_VERSION - see `versionLiterals` below.
 *
 *   npm run test:vectors            check the C# file and the version literals
 *   npm run test:vectors -- --emit  print the C# table, ready to paste
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    PROTOCOL_VERSION,
    encodeHandshakeFrame,
    encodeHeartbeatFrame,
    encodeMessageFrame,
} from '../src/server/modules/networking/protocol.js';
import { VoiceCodec, encodeVoicePacket, voiceAppId } from '../src/server/modules/web/voice-packet.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const CSHARP_VECTORS = path.resolve(
    REPO_ROOT,
    'colibri-unity/Assets/Colibri/Tests/Editor/ProtocolVectorTests.cs'
);

interface VersionLiteral {
    /** Repository-relative. */
    readonly file: string;
    /** Must match exactly once; the first capture group is the version. */
    readonly pattern: RegExp;
}

// Every other place the protocol version is spelled out. Each has to hard-code it - the web
// client and the Unity package ship separately from this server, and the admin UI is built by a
// different compiler - so a version bumped in one of them alone was noticed by nothing short of
// every client being refused. Each pattern must match exactly once, so moving or renaming a
// literal fails here until this list is updated, rather than passing because nothing matched.
const versionLiterals: VersionLiteral[] = [
    { file: 'colibri-web/src/Colibri.ts', pattern: /export const PROTOCOL_VERSION\s*=\s*'([^']*)'/g },
    {
        file: 'colibri-unity/Assets/Colibri/Networking/WebServerConnection.cs',
        pattern: /const string CLIENT_VERSION\s*=\s*"([^"]*)"/g,
    },
    {
        file: 'colibri-server/src/ui/app/services/socketio.service.ts',
        pattern: /query:\s*\{\s*app:\s*'colibri',\s*version:\s*'([^']*)'\s*\}/g,
    },
];

interface Vector {
    /** How the C# case reads, for the failure message and the --emit table. */
    readonly description: string;
    readonly bytes: Buffer;
}

const vectors: Vector[] = [
    { description: 'Heartbeat(0)', bytes: encodeHeartbeatFrame(0n) },
    { description: 'Heartbeat(1)', bytes: encodeHeartbeatFrame(1n) },
    { description: 'Heartbeat(123456789012345)', bytes: encodeHeartbeatFrame(123456789012345n) },
    { description: 'Heartbeat(ulong.MaxValue)', bytes: encodeHeartbeatFrame(18446744073709551615n) },

    // The current version, so bumping PROTOCOL_VERSION fails this check until the C# vectors
    // (which hard-code it) are regenerated too.
    {
        description: `Handshake("${PROTOCOL_VERSION}", "myApp", "myClient")`,
        bytes: encodeHandshakeFrame(PROTOCOL_VERSION, 'myApp', 'myClient'),
    },
    {
        // Non-ASCII in the client name is ordinary: it comes from the device name.
        description: `Handshake("${PROTOCOL_VERSION}", "app", "Bjorn-ü中")`,
        bytes: encodeHandshakeFrame(PROTOCOL_VERSION, 'app', 'Bjorn-ü中'),
    },

    {
        description: 'Message("app::chan", "model::update", {"x":1})',
        bytes: encodeMessageFrame({
            channel: 'app::chan',
            command: 'model::update',
            payload: Buffer.from('{"x":1}', 'utf8'),
        }),
    },
    {
        description: 'Message("c", "cmd", empty)',
        bytes: encodeMessageFrame({ channel: 'c', command: 'cmd', payload: Buffer.alloc(0) }),
    },
    {
        description: 'Message("känäl", "broadcast::string", "hello")',
        bytes: encodeMessageFrame({
            channel: 'känäl',
            command: 'broadcast::string',
            payload: Buffer.from('"hello"', 'utf8'),
        }),
    },
    {
        // Payload bytes are opaque to the codec, so a body that is not text has to survive too.
        description: 'Message("b", "raw", 00 ff 7f 80)',
        bytes: encodeMessageFrame({
            channel: 'b',
            command: 'raw',
            payload: Buffer.from([0x00, 0xff, 0x7f, 0x80]),
        }),
    },

    // Voice packets (UDP). The app id in each is voiceAppId of the app name, so these pin the
    // hash as well as the header.
    {
        description: 'VoicePacket(AppId("myApp"), 1, 0, 960, PCM, 00 01 ff 7f)',
        bytes: encodeVoicePacket({
            appId: voiceAppId('myApp'),
            userId: 1,
            sequence: 0,
            frameSize: 960,
            codec: VoiceCodec.PCM,
            data: Buffer.from([0x00, 0x01, 0xff, 0x7f]),
        }),
    },
    {
        // The App Name is typed in by hand, so it can be anything; the hash is over its utf8 bytes.
        description: 'VoicePacket(AppId("Bjorn-ü中"), -2, 513, 480, OPUS, fc ff fe)',
        bytes: encodeVoicePacket({
            appId: voiceAppId('Bjorn-ü中'),
            userId: -2,
            sequence: 513,
            frameSize: 480,
            codec: VoiceCodec.OPUS,
            data: Buffer.from([0xfc, 0xff, 0xfe]),
        }),
    },
    {
        description: 'VoicePacket(AppId(""), 32000, -1, 0, PCM, empty)',
        bytes: encodeVoicePacket({
            appId: voiceAppId(''),
            userId: 32000,
            sequence: -1,
            frameSize: 0,
            codec: VoiceCodec.PCM,
            data: Buffer.alloc(0),
        }),
    },
];

const hex = (buffer: Buffer) => buffer.toString('hex');

const emit = function (): void {
    console.log('Vectors produced by this server, for ProtocolVectorTests.cs:\n');
    for (const vector of vectors) {
        console.log(`  ${vector.description}`);
        console.log(`  "${hex(vector.bytes)}"\n`);
    }
};

const check = function (): number {
    let source: string;
    try {
        source = readFileSync(CSHARP_VECTORS, 'utf8');
    } catch {
        console.error(`Cannot read ${CSHARP_VECTORS}`);
        console.error('This check needs the colibri-unity package checked out alongside colibri-server.');
        return 1;
    }

    // Every hex literal in the file. Nine bytes is the shortest frame there is, and a voice
    // packet is at least 11, so anything shorter than that is some other string.
    const literals = new Set((source.match(/"[0-9a-f]{18,}"/g) ?? []).map(match => match.slice(1, -1)));

    const missing = vectors.filter(vector => !literals.has(hex(vector.bytes)));
    for (const vector of missing) {
        console.error(`MISSING  ${vector.description}`);
        console.error(`         this server encodes it as ${hex(vector.bytes)},`);
        console.error('         which does not appear in ProtocolVectorTests.cs');
    }

    const encoded = new Set(vectors.map(vector => hex(vector.bytes)));
    const stale = [...literals].filter(literal => !encoded.has(literal));
    for (const literal of stale) {
        console.error(`STALE    ${literal}`);
        console.error('         is expected by ProtocolVectorTests.cs but no vector here produces it');
    }

    if (missing.length > 0 || stale.length > 0) {
        console.error(
            `\n${missing.length} missing, ${stale.length} stale. The two implementations have drifted, ` +
                'or a vector was added on one side only.'
        );
        console.error('Run `npm run test:vectors -- --emit` for the current bytes.');
        return 1;
    }

    console.log(`All ${vectors.length} protocol vectors match colibri-unity's ProtocolVectorTests.cs.`);
    return 0;
};

const checkVersions = function (): number {
    let failures = 0;

    for (const literal of versionLiterals) {
        let source: string;
        try {
            source = readFileSync(path.resolve(REPO_ROOT, literal.file), 'utf8');
        } catch {
            console.error(`VERSION  cannot read ${literal.file}`);
            failures += 1;
            continue;
        }

        const matches = [...source.matchAll(literal.pattern)];
        const found = matches[0]?.[1];
        if (matches.length !== 1 || found === undefined) {
            console.error(`VERSION  ${literal.file}: expected exactly one match for ${literal.pattern}, found ${matches.length}`);
            console.error('         If the literal moved, update versionLiterals in test/emit-protocol-vectors.ts.');
            failures += 1;
        } else if (found !== PROTOCOL_VERSION) {
            console.error(`VERSION  ${literal.file} announces protocol version '${found}',`);
            console.error(`         but PROTOCOL_VERSION in colibri-server's protocol.ts is '${PROTOCOL_VERSION}'`);
            failures += 1;
        }
    }

    if (failures > 0) {
        console.error(
            `\n${failures} protocol version mismatch(es). Every client announcing another version is refused, ` +
                'so they have to change together.'
        );
        return 1;
    }

    console.log(`All ${versionLiterals.length} other copies of the protocol version say '${PROTOCOL_VERSION}'.`);
    return 0;
};

if (process.argv.includes('--emit')) {
    emit();
} else {
    // Both run either way, so one failure does not hide the other.
    const vectorsFailed = check() !== 0;
    const versionsFailed = checkVersions() !== 0;
    process.exit(vectorsFailed || versionsFailed ? 1 : 0);
}
