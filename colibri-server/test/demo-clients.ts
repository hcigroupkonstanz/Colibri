// Synthetic clients that make a running server look in use, so the admin UI's pages have something to
// show without headsets: lines of every level on Log, latency and throughput on Clients, synced objects
// and deleted ids on Models, client and model counts on Server.
//
//   npm run demo -- [--host <name>] [--tls [--insecure]] [--web-port <port>] [--tcp-port <port>]
//                   [--minutes <n>] [--apps <n>]
//
// One copy of the scene is two apps. ArchViz: a furnished floor that two headsets walk through, arranged
// by a researcher in the Unity editor, with a web dashboard of annotations. MuseumGuide: a headset on a
// tour, with a web kiosk counting exhibit visits. The Unity clients speak the v3 TCP protocol as
// colibri-unity does, the web clients Socket.IO as colibri-web does. --apps <n> runs n copies; the
// apps of copy 2 are ArchViz-2 and MuseumGuide-2, and so on.
//
// The scene repeats every 3 minutes, so it can run for hours. A client whose connection drops (a server
// restart, a redeploy) connects again after a few seconds and sends its state again. A copy sends the
// server up to about 250 messages a second and is sent up to about 550.
//
// --web-port and --tcp-port default to WEBSERVER_PORT and TCP_PORT from the environment or a .env, as
// the server reads them. --host defaults to localhost, not 127.0.0.1: a server with WEBSERVER_HOST or
// TCP_HOST set to localhost can listen on ::1 only, and Node tries both addresses for the name. --tls
// and --insecure as in tcp-probe-connection.ts. --minutes stops it after that long; without it, it runs
// until Ctrl+C.
import { randomUUID } from 'crypto';
import * as net from 'net';
import * as tls from 'tls';
import { io, Socket as WebSocket } from 'socket.io-client';
import { Config } from '../src/server/configuration.js';
import {
    COLIBRI_CHANNEL,
    FrameReader,
    FrameType,
    PROTOCOL_REJECTED_COMMAND,
    PROTOCOL_VERSION,
    encodeHandshakeFrame,
    encodeHeartbeatFrame,
    encodeMessageFrame,
} from '../src/server/modules/networking/protocol.js';
import { PLAIN_PROBE_CLOSED_HINT, ProbeOptions, parseProbeArgs, probeErrorHint } from './tcp-probe-connection.js';

const USAGE = 'npm run demo -- [--host <name>] [--tls [--insecure]] [--web-port <port>] [--tcp-port <port>] ' +
    '[--minutes <n>] [--apps <n>]';

// The scene starts over after this many seconds.
const CYCLE_SECONDS = 180;
// How long a client whose connection dropped waits before it tries again.
const RECONNECT_MILLIS = 3000;
// colibri-unity's SyncTransform channel.
const SYNC_TRANSFORM = 'synctransform';
// The longest --minutes: setTimeout takes at most 2^31 - 1 ms (about 24.8 days) and fires at once
// for more.
const MAX_MINUTES = Math.floor((2 ** 31 - 1) / 60_000);

interface DemoOptions extends ProbeOptions {
    webPort: number;
    tcpPort: number;
    // Undefined: until Ctrl+C.
    minutes: number | undefined;
    apps: number;
}

const parseDemoArgs = function (argv: readonly string[]): DemoOptions {
    const probe = parseProbeArgs(argv, 'localhost');
    const options: DemoOptions = {
        ...probe,
        args: [],
        webPort: Config.WEBSERVER_PORT,
        tcpPort: Config.TCP_PORT,
        minutes: undefined,
        apps: 1,
    };
    const positive = (name: string, raw: string | undefined, integer: boolean, max = Infinity): number => {
        const value = Number(raw);
        if (raw === undefined || !(value > 0) || value > max || (integer && !Number.isInteger(value))) {
            throw new Error(`${name} needs a positive ${integer ? 'integer' : 'number'}${max < Infinity ? ` up to ${max}` : ''}`);
        }
        return value;
    };
    for (let i = 0; i < probe.args.length; i += 2) {
        const arg = probe.args[i]!;
        const value = probe.args[i + 1];
        switch (arg) {
            case '--web-port': options.webPort = positive(arg, value, true, 65535); break;
            case '--tcp-port': options.tcpPort = positive(arg, value, true, 65535); break;
            case '--minutes': options.minutes = positive(arg, value, false, MAX_MINUTES); break;
            case '--apps': options.apps = positive(arg, value, true); break;
            default: throw new Error(`Unknown argument '${arg}'`);
        }
    }
    return options;
};

let parsed: DemoOptions;
try {
    parsed = parseDemoArgs(process.argv.slice(2));
} catch (err) {
    console.error(`${(err as Error).message}\nUsage: ${USAGE}`);
    process.exit(2);
}
const options = parsed;

type Vec3 = [ number, number, number ];
type Quat = [ number, number, number, number ];
type LogLevel = 'debug' | 'info' | 'warning' | 'error';

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const r3 = (value: number) => Math.round(value * 1000) / 1000;
// A rotation about the vertical axis, as a quaternion (x, y, z, w).
const yaw = (angle: number): Quat => [ 0, r3(Math.sin(angle / 2)), 0, r3(Math.cos(angle / 2)) ];
// The full state of a SyncTransform, as colibri-unity sends it when the object appears.
const fullTransform = (id: string, position: Vec3, rotation: Quat = [ 0, 0, 0, 1 ]) =>
    ({ id, active: true, position, rotation, scale: [ 1, 1, 1 ], physicsid: null });

// Messages the clients sent and were sent, but neither heartbeats nor latency pings, which the server
// does not count either. For the averages printed at the end.
const stats = { sent: 0, received: 0 };
let stopping = false;
// Until a Unity client has heard from the server, a failure is more likely the setup's (TLS on one
// side only, a wrong port) than an outage, and gets one hint.
let heardFromServer = false;
let hinted = false;

// For a name with more than one address, such as localhost (::1 and 127.0.0.1), Node reports a connect
// that failed on all of them as an AggregateError with an empty message and one error per address.
const describeError = function (err: Error): string {
    if (err instanceof AggregateError && !err.message) {
        return err.errors.map(inner => (inner instanceof Error ? inner.message : String(inner))).join(', ');
    }
    return err.message;
};

const readReason = function (payload: Buffer): unknown {
    try {
        return (JSON.parse(payload.toString('utf8')) as { reason?: unknown }).reason;
    } catch {
        return payload.toString('utf8');
    }
};

// The server speaks another protocol version: trying again cannot help.
const refused = function (label: string, reason: unknown): void {
    console.error(`${label}: the server refused this client: ${String(reason ?? '(no reason given)')}`);
    shutdown(1);
};

// A Unity client, speaking the v3 TCP protocol as colibri-unity does.
class UnityClient {
    private socket: net.Socket | undefined;
    private ready = false;
    // False between leave() and join(): a connection that drops then is not made again.
    private wanted = false;
    // Set while a dropped connection is retried, so that an outage is reported once, not every few seconds.
    private lost = false;
    private retry: NodeJS.Timeout | undefined;
    private readonly readyHandlers: (() => void)[] = [];

    public constructor(
        public readonly app: string,
        public readonly name: string,
        // The range of the delay before a heartbeat is answered, in ms: the round trip of a headset on Wi-Fi.
        private readonly latency: [ number, number ],
    ) {}

    public get label(): string {
        return `${this.name} (${this.app})`;
    }

    public get connected(): boolean {
        return this.ready;
    }

    // Called on every connection, to send the client's state: a server that restarted has none.
    public onReady(handler: () => void): void {
        this.readyHandlers.push(handler);
    }

    public join(): void {
        if (this.wanted) return;
        this.wanted = true;
        this.connect();
    }

    public leave(): void {
        this.wanted = false;
        // A client that leaves during an outage is not reported as connected again when it joins.
        this.lost = false;
        clearTimeout(this.retry);
        const socket = this.socket;
        this.socket = undefined;
        this.ready = false;
        socket?.end();
    }

    public send(channel: string, command: string, payload: unknown): void {
        this.write(channel, command, Buffer.from(JSON.stringify(payload), 'utf8'));
    }

    // The text as it is, not as a JSON string: colibri-unity sends the log channel that way.
    public log(level: LogLevel, text: string): void {
        this.write('log', level, Buffer.from(text, 'utf8'));
    }

    private write(channel: string, command: string, payload: Buffer): void {
        if (!this.ready || !this.socket) return;
        this.socket.write(encodeMessageFrame({ channel, command, payload }));
        stats.sent += 1;
    }

    private connect(): void {
        const socket = options.tls
            ? tls.connect({
                host: options.host,
                port: options.tcpPort,
                // SNI takes a name, never an address.
                servername: net.isIP(options.host) ? undefined : options.host,
                rejectUnauthorized: !options.insecure,
            })
            : net.connect({ host: options.host, port: options.tcpPort });
        this.socket = socket;
        const reader = new FrameReader();
        let received = false;
        let error: Error | undefined;

        socket.once(options.tls ? 'secureConnect' : 'connect', () => {
            // As colibri-unity does. With Nagle's algorithm on, a heartbeat's answer waits for the ACK
            // of the one before, and the latency chart shows spikes of about 40 ms.
            socket.setNoDelay(true);
            socket.write(encodeHandshakeFrame(PROTOCOL_VERSION, this.app, this.name));
            this.ready = true;
            for (const handler of this.readyHandlers) handler();
        });

        socket.on('data', (data: Buffer) => {
            // Back once the server answers: a server that refuses the connection (TLS on one side
            // only) accepts it first and closes it right after.
            if (!received && this.lost) console.log(`${this.label}: connected again`);
            this.lost = false;
            received = true;
            heardFromServer = true;
            let frames;
            try {
                frames = reader.append(data);
            } catch (err) {
                error = err as Error;
                socket.destroy();
                return;
            }
            for (const frame of frames) {
                if (frame.type === FrameType.Heartbeat) {
                    const ping = frame.pingTimestamp;
                    setTimeout(() => {
                        if (socket.writable) socket.write(encodeHeartbeatFrame(ping));
                    }, rand(...this.latency));
                } else if (frame.type === FrameType.Message && frame.channel === COLIBRI_CHANNEL) {
                    if (frame.command === PROTOCOL_REJECTED_COMMAND) refused(this.label, readReason(frame.payload));
                } else if (frame.type === FrameType.Message) {
                    stats.received += 1;
                }
            }
        });

        socket.on('error', err => {
            error = err;
        });

        socket.on('close', () => {
            // Left on purpose.
            if (this.socket !== socket) return;
            this.socket = undefined;
            this.ready = false;
            if (stopping || !this.wanted) return;

            if (!this.lost) {
                this.lost = true;
                const why = error ? describeError(error) : (received ? 'closed by the server' : 'closed by the server before it sent anything');
                console.log(`${this.label}: connection lost (${why}), trying again every ${RECONNECT_MILLIS / 1000} s`);
            }
            if (!heardFromServer && !hinted) {
                const hint = error ? probeErrorHint(options, error) : (!options.tls && !received ? PLAIN_PROBE_CLOSED_HINT : undefined);
                if (hint) console.error(hint);
                hinted = hint !== undefined;
            }
            this.retry = setTimeout(() => this.connect(), RECONNECT_MILLIS);
        });
    }
}

// A web client, speaking Socket.IO as colibri-web does. Socket.IO connects it again by itself after its
// connection dropped.
class WebClient {
    private readonly socket: WebSocket;
    // As UnityClient.lost.
    private lost = false;
    private readonly readyHandlers: (() => void)[] = [];

    public constructor(
        public readonly app: string,
        public readonly label: string,
        // As UnityClient.latency, for the latency pings.
        latency: [ number, number ],
    ) {
        const host = net.isIPv6(options.host) ? `[${options.host}]` : options.host;
        this.socket = io(`${options.tls ? 'https' : 'http'}://${host}:${options.webPort}`, {
            query: { app, version: PROTOCOL_VERSION },
            transports: [ 'websocket' ],
            rejectUnauthorized: !options.insecure,
            reconnectionDelay: RECONNECT_MILLIS,
            reconnectionDelayMax: RECONNECT_MILLIS,
            autoConnect: false,
        });

        this.socket.on(COLIBRI_CHANNEL, (msg: { command?: string; payload?: unknown } | undefined) => {
            if (msg?.command === 'latency') {
                setTimeout(() => {
                    if (this.socket.connected) this.socket.emit(COLIBRI_CHANNEL, { command: 'latency', payload: msg.payload });
                }, rand(...latency));
            } else if (msg?.command === PROTOCOL_REJECTED_COMMAND) {
                refused(this.label, (msg.payload as { reason?: unknown } | undefined)?.reason);
            }
        });
        this.socket.onAny((channel: string) => {
            if (channel !== COLIBRI_CHANNEL) stats.received += 1;
        });

        this.socket.on('connect', () => {
            if (this.lost) console.log(`${this.label}: connected again`);
            this.lost = false;
            for (const handler of this.readyHandlers) handler();
        });
        this.socket.on('connect_error', err => this.reportLost(err.message));
        this.socket.on('disconnect', reason => {
            if (stopping) return;
            this.reportLost(reason);
            // The one case in which Socket.IO does not connect again by itself.
            if (reason === 'io server disconnect') {
                setTimeout(() => {
                    if (!stopping) this.socket.connect();
                }, RECONNECT_MILLIS);
            }
        });
    }

    public get connected(): boolean {
        return this.socket.connected;
    }

    // As UnityClient.onReady.
    public onReady(handler: () => void): void {
        this.readyHandlers.push(handler);
    }

    public join(): void {
        this.socket.connect();
    }

    public leave(): void {
        this.socket.close();
    }

    // Dropped while disconnected: Socket.IO would buffer it and send a burst of stale updates later.
    public send(channel: string, command: string, payload: unknown): void {
        if (!this.socket.connected) return;
        this.socket.emit(channel, { command, payload });
        stats.sent += 1;
    }

    private reportLost(why: string): void {
        if (this.lost || stopping) return;
        this.lost = true;
        console.log(`${this.label}: connection lost (${why}), trying again`);
    }
}

// A headset's avatar: head and both hands, sent 30 times a second while they move, as SyncTransform
// does, with the fields that changed.
class Avatar {
    public still = false;
    private hands = true;
    private ids: string[] = [];
    private time = 0;
    private readonly base: Vec3[];
    private readonly timer: NodeJS.Timeout;

    public constructor(private readonly client: UnityClient, offset: number) {
        this.base = [ [ offset, 1.62, 0 ], [ offset - 0.25, 1.1, 0.3 ], [ offset + 0.25, 1.1, 0.3 ] ];
        this.spawn();
        client.onReady(() => {
            this.ids.forEach((id, i) => {
                const transform = fullTransform(id, this.base[i]!);
                client.send(SYNC_TRANSFORM, 'model::update', i > 0 ? { ...transform, active: this.hands } : transform);
            });
        });
        this.timer = setInterval(() => this.move(), 1000 / 30);
    }

    // New ids, as for the avatar a headset spawns when it joins.
    public spawn(): void {
        this.ids = [ randomUUID(), randomUUID(), randomUUID() ];
    }

    // As when the app quits and its avatar is destroyed: the Models page lists the ids as deleted.
    public despawn(): void {
        for (const id of this.ids) this.client.send(SYNC_TRANSFORM, 'model::delete', { id });
    }

    // Hand tracking lost or back: the hands are hidden, and not sent while they are.
    public setHands(tracked: boolean): void {
        this.hands = tracked;
        for (const id of this.ids.slice(1)) this.client.send(SYNC_TRANSFORM, 'model::update', { id, active: tracked });
    }

    public stop(): void {
        clearInterval(this.timer);
    }

    private move(): void {
        this.time += 1 / 30;
        if (this.still || !this.client.connected) return;

        const t = this.time;
        this.ids.forEach((id, i) => {
            if (i > 0 && !this.hands) return;
            // Some frames, a part has not moved enough to be sent.
            if (Math.random() < 0.12) return;
            const [ x, y, z ] = this.base[i]!;
            this.client.send(SYNC_TRANSFORM, 'model::update', {
                id,
                position: [ r3(x + Math.sin(t * 0.4 + i) * 0.6), r3(y + Math.sin(t * 2.1 + i) * 0.03), r3(z + Math.cos(t * 0.3) * 0.8) ],
                rotation: yaw(Math.sin(t * 0.25 + i) * 0.8),
            });
        });
    }
}

interface Annotation {
    id: string;
    author: string;
    text: string;
    position: Vec3;
    resolved: boolean;
    createdAt: number;
}

const FIRST_NOTES = [
    'Window frame clips into the wall', 'Door swing too narrow for a wheelchair', 'Lamp floats 5 cm above the desk',
    'Shelf blocks the fire exit sign', 'Sofa texture missing on the back', 'Light probe too dark in the corridor',
    'Stair railing height looks off', 'Check the scale of the plant',
];
const LATER_NOTES = [
    'Ceiling height in the meeting room feels low', 'Handrail missing on the landing', 'Glare from the skylight on the screens',
    'Too little space behind the desks', 'Kitchen counter too high', 'Exit sign hard to read from the stairs',
];

const EXCEPTION = 'NullReferenceException: Object reference not set to an instance of an object\n' +
    '  at AnnotationPanel.Show (Annotation note) [0x00012] in Assets/Scripts/AnnotationPanel.cs:42\n' +
    '  at AnnotationMarker.OnSelectEntered (SelectEnterEventArgs args) [0x00008] in Assets/Scripts/AnnotationMarker.cs:27';

interface Scene {
    apps: string[];
    // Called once a second, with the seconds since the start.
    tick(elapsed: number): void;
    stop(): void;
}

// One copy of the scene: both apps, their clients, and what happens at each second of the cycle.
const createScene = function (copy: number): Scene {
    const suffix = copy === 1 ? '' : `-${copy}`;
    const archViz = `ArchViz${suffix}`;
    const museum = `MuseumGuide${suffix}`;
    // Copies are at different points of the cycle, so that their events do not all come at once.
    const offset = ((copy - 1) * 47) % CYCLE_SECONDS;

    // ArchViz: the researcher's editor loads the furnished floor and moves a piece now and then.
    const editor = new UnityClient(archViz, 'LAB-PC-02', [ 0.6, 1.4 ]);
    const furniture = Array.from({ length: 36 }, () => ({
        id: randomUUID(),
        position: [ r3(rand(-6, 6)), 0, r3(rand(-4, 4)) ] as Vec3,
        rotation: yaw(rand(-Math.PI, Math.PI)),
        // Each time it is moved, it goes the other way, so that nothing drifts off in a long run.
        step: 0.02,
    }));
    let moves = 0;
    editor.onReady(() => {
        for (const piece of furniture) editor.send(SYNC_TRANSFORM, 'model::update', fullTransform(piece.id, piece.position, piece.rotation));
        editor.log('info', `Loaded scene Floor2_Furnished: ${furniture.length} synced objects`);
        editor.log('debug', 'Spawned 6 furniture prefabs from Addressables in 412 ms');
    });
    const moveFurniture = () => {
        const piece = furniture[moves++ % furniture.length]!;
        for (let k = 0; k < 6; k++) {
            piece.position = [ r3(piece.position[0] + piece.step), 0, piece.position[2] ];
            editor.send(SYNC_TRANSFORM, 'model::update', { id: piece.id, position: piece.position });
        }
        piece.step = -piece.step;
    };

    // Two headsets walking through it.
    const quest3 = new UnityClient(archViz, 'Quest 3', [ 4, 12 ]);
    const quest3Avatar = new Avatar(quest3, -1);
    quest3.onReady(() => {
        quest3.log('info', `Colibri: connected to ${options.host}:${options.tcpPort}`);
        quest3.log('info', 'Joined walkthrough as participant P07');
    });
    const quest2 = new UnityClient(archViz, 'Quest 2', [ 5, 22 ]);
    const quest2Avatar = new Avatar(quest2, 1);
    quest2.onReady(() => quest2.log('info', 'Joined walkthrough as participant P08'));

    // A web dashboard of the annotations the headsets add. It resolves and deletes them, so the
    // Models page has deleted ids to show.
    const dashboard = new WebClient(archViz, `Web dashboard (${archViz})`, [ 1.5, 3.5 ]);
    let notes: Annotation[] = FIRST_NOTES.map((text, i) => ({
        id: randomUUID(),
        author: i % 2 ? 'Quest 2' : 'Quest 3',
        text,
        position: [ r3(rand(-5, 5)), r3(rand(0.5, 2)), r3(rand(-3, 3)) ],
        resolved: i < 2,
        createdAt: Date.now() - (FIRST_NOTES.length - i) * 95_000,
    }));
    let added = 0;
    dashboard.onReady(() => {
        dashboard.send('annotation', 'model::request', {});
        for (const note of notes) dashboard.send('annotation', 'model::update', note);
    });
    const addNote = (client: UnityClient) => {
        if (!client.connected) return;
        const note: Annotation = {
            id: randomUUID(),
            author: client.name,
            text: LATER_NOTES[added++ % LATER_NOTES.length]!,
            position: [ r3(rand(-5, 5)), r3(rand(0.5, 2.5)), r3(rand(-3, 3)) ],
            resolved: false,
            createdAt: Date.now(),
        };
        notes.push(note);
        client.send('annotation', 'model::update', note);
        client.log('info', 'Added an annotation');
    };
    const resolveOldest = () => {
        const note = notes.find(n => !n.resolved);
        if (!note || !dashboard.connected) return;
        note.resolved = true;
        dashboard.send('annotation', 'model::update', { id: note.id, resolved: true });
    };
    const deleteResolved = () => {
        if (!dashboard.connected) return;
        for (const note of notes) {
            if (note.resolved) dashboard.send('annotation', 'model::delete', { id: note.id });
        }
        notes = notes.filter(n => !n.resolved);
    };

    // MuseumGuide: a headset on a tour of three rooms, and a web kiosk counting the exhibits' visits.
    const questPro = new UnityClient(museum, 'Quest Pro', [ 6, 16 ]);
    const questProAvatar = new Avatar(questPro, 2);
    let room = 1;
    questPro.onReady(() => questPro.log('info', `Tour started: Room ${room}`));
    const kiosk = new WebClient(museum, `Web kiosk (${museum})`, [ 2, 4 ]);
    const exhibits = Array.from({ length: 12 }, (_, i) => ({
        id: `exhibit-${String(i + 1).padStart(2, '0')}`,
        room: 1 + Math.floor(i / 4),
        title: `Exhibit ${i + 1}`,
        visits: Math.floor(rand(3, 40)),
        audio: `exhibit-${i + 1}.ogg`,
    }));
    kiosk.onReady(() => {
        for (const exhibit of exhibits) kiosk.send('exhibit', 'model::update', exhibit);
    });
    const countVisit = () => {
        const inRoom = exhibits.filter(e => e.room === room);
        const exhibit = inRoom[Math.floor(Math.random() * inRoom.length)]!;
        exhibit.visits += 1;
        kiosk.send('exhibit', 'model::update', { id: exhibit.id, visits: exhibit.visits });
    };

    const tick = (elapsed: number) => {
        // One after another, as people arrive.
        if (elapsed === 0) {
            editor.join();
            dashboard.join();
        }
        if (elapsed === 2) quest3.join();
        if (elapsed === 4) {
            questPro.join();
            kiosk.join();
        }
        if (elapsed === 6) quest2.join();

        const second = (elapsed + offset) % CYCLE_SECONDS;
        if (second % 3 === 0) moveFurniture();
        if (second % 25 === 7) quest3.log('debug', `Teleported to (${r3(rand(-4, 4))}, 0, ${r3(rand(-3, 3))})`);
        if (second % 30 === 15) countVisit();

        switch (second) {
            case 0:
            case 60:
            case 120:
                room = 1 + second / 60;
                questPro.log('info', `Tour moved on to Room ${room}`);
                break;
            case 5:
            case 75:
            case 165:
                deleteResolved();
                break;
            case 12:
                quest2.log('warning', 'Hand tracking lost, switching to controllers');
                quest2Avatar.setHands(false);
                break;
            case 18:
                quest3.log('error', EXCEPTION);
                break;
            case 20:
                questPro.log('warning', 'Audio clip exhibit-7.ogg not found, skipping the narration');
                break;
            case 26:
                quest2.log('info', 'Hand tracking restored');
                quest2Avatar.setHands(true);
                break;
            case 34:
                quest3Avatar.still = true;
                quest3.log('debug', 'Paused: headset taken off');
                break;
            case 40:
                addNote(quest3);
                break;
            case 44:
                quest3Avatar.still = false;
                quest3.log('debug', 'Resumed: headset put on');
                break;
            case 50:
            case 150:
                resolveOldest();
                break;
            case 90:
                // Quits the app: its avatar goes, and comes back with new ids.
                quest2.log('info', 'Session ended, leaving the walkthrough');
                quest2Avatar.despawn();
                quest2.leave();
                quest2Avatar.spawn();
                break;
            case 110:
                quest2.join();
                break;
            case 140:
                addNote(quest2);
                break;
        }
    };

    return {
        apps: [ archViz, museum ],
        tick,
        stop: () => {
            for (const avatar of [ quest3Avatar, quest2Avatar, questProAvatar ]) avatar.stop();
            for (const client of [ editor, quest3, quest2, questPro, dashboard, kiosk ]) client.leave();
        },
    };
};

const scenes = Array.from({ length: options.apps }, (_, i) => createScene(i + 1));
const apps = scenes.flatMap(scene => scene.apps);
const appList = apps.length > 4 ? `${apps.length} apps (${apps.slice(0, 4).join(', ')}, ...)` : `apps ${apps.join(' and ')}`;
console.log(
    `Demo: ${4 * scenes.length} Unity clients to ${options.host}:${options.tcpPort} and ${2 * scenes.length} web clients to ` +
        `${options.host}:${options.webPort}${options.tls ? ' over TLS' : ''} in ${appList}, sending up to about ${250 * scenes.length} ` +
        `messages/s. ${options.minutes === undefined ? 'Stop with Ctrl+C.' : `Stops after ${options.minutes} min, or with Ctrl+C.`}`
);

const startedAt = performance.now();
let elapsed = 0;
for (const scene of scenes) scene.tick(elapsed);
const ticker = setInterval(() => {
    elapsed += 1;
    for (const scene of scenes) scene.tick(elapsed);
}, 1000);
const deadline = options.minutes === undefined ? undefined : setTimeout(() => shutdown(0), options.minutes * 60_000);

const shutdown = function (exitCode: number): void {
    if (stopping) return;
    stopping = true;
    process.exitCode = exitCode;
    clearInterval(ticker);
    clearTimeout(deadline);
    for (const scene of scenes) scene.stop();

    const seconds = Math.max(Math.round((performance.now() - startedAt) / 1000), 1);
    const perSecond = (count: number) => Math.round(count / seconds);
    console.log(
        `Stopped after ${Math.floor(seconds / 60)} min ${seconds % 60} s. On average, the clients sent ` +
            `${perSecond(stats.sent)} messages/s and were sent ${perSecond(stats.received)}.`
    );
    // The process ends once the connections are closed. This is for a server that does not close its side.
    setTimeout(() => process.exit(), 3000).unref();
};

// A second Ctrl+C does not wait for the connections to close.
process.on('SIGINT', () => (stopping ? process.exit() : shutdown(0)));
process.on('SIGTERM', () => shutdown(0));
