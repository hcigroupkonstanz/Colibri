import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as dgram from 'dgram';
import { once } from 'events';
import { existsSync, readFileSync } from 'fs';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'fs/promises';
import { AddressInfo } from 'net';
import { networkInterfaces, tmpdir } from 'os';
import * as path from 'path';
import { Subject, Subscription } from 'rxjs';
import wavefile from 'wavefile';
import { VoiceServer, voiceSocketOptions, wavHeader } from '../../src/server/modules/web/voice-server.js';
import { VoiceCodec, encodeVoicePacket, voiceAppId } from '../../src/server/modules/web/voice-packet.js';
import { UnityClient, UnityClientSource } from '../../src/server/modules/web/unity-client-addresses.js';
import { ConsoleLog, LogLevel, LogMessage, Service } from '../../src/server/modules/core/index.js';
import { compileTrustedProxies } from '../../src/server/modules/networking/trusted-proxies.js';

const { WaveFile } = wavefile;

const APP = voiceAppId('voice-test');

// The Unity (TCP) clients, as TCPServerProxy reports them.
class FakeUnityClients implements UnityClientSource {
    public readonly currentClients: UnityClient[] = [];
    private readonly connected = new Subject<UnityClient>();
    private readonly disconnected = new Subject<UnityClient>();

    public get clientConnected$() {
        return this.connected.asObservable();
    }
    public get clientDisconnected$() {
        return this.disconnected.asObservable();
    }

    public connect(app: string, address: string): UnityClient {
        const client = { app, address };
        this.currentClients.push(client);
        this.connected.next(client);
        return client;
    }

    public disconnect(client: UnityClient): void {
        this.currentClients.splice(this.currentClients.indexOf(client), 1);
        this.disconnected.next(client);
    }

    public disconnectApp(app: string): void {
        for (const client of this.currentClients.filter(client => client.app === app)) this.disconnect(client);
    }
}

// Voice is relayed only from the address of a Unity client of the packet's app, one voice client
// per Unity client. The tests that are not about that send from 127.0.0.1, in these apps, from up
// to this many sockets per app.
const LOOPBACK_UNITY_CLIENTS = 8;
const unityClientsOnLoopback = function (): FakeUnityClients {
    const unity = new FakeUnityClients();
    for (const app of [ 'voice-test', 'app-a', 'app-b' ]) {
        for (let i = 0; i < LOOPBACK_UNITY_CLIENTS; i++) unity.connect(app, '127.0.0.1');
    }
    return unity;
};

// An app id as the server writes it in logs and recording names.
const appHex = (appId: number): string => `0x${appId.toString(16).padStart(8, '0')}`;

// A PCM voice packet of `appId`, as Unity sends it.
const voicePacket = function (userId: number, sequence: number, data: number[] = [ 0, 0 ], appId = APP): Buffer {
    return encodeVoicePacket({ appId, userId, sequence, frameSize: 960, codec: VoiceCodec.PCM, data: Buffer.from(data) });
};

// A PCM packet of `appId` carrying `samples` as 16-bit little-endian values.
const pcmPacket = function (userId: number, sequence: number, samples: number[], appId = APP): Buffer {
    const data = Buffer.alloc(samples.length * 2);
    samples.forEach((sample, i) => data.writeInt16LE(sample, i * 2));
    return Buffer.concat([ voicePacket(userId, sequence, [], appId), data ]);
};

interface VoiceServerInternals {
    udpSocket: dgram.Socket;
    clients: Map<string, unknown>;
    reportedAt: Map<string, number>;
    rejections: Map<string, unknown>;
    savingRecordings: Promise<void> | undefined;
    pruneReports(nowMillis: number): void;
    checkClientsDisconnected(): Promise<void>;
}

describe('VoiceServer', () => {
    let unity: FakeUnityClients;
    let server: VoiceServer;
    let internals: VoiceServerInternals;
    let port: number;
    let sockets: dgram.Socket[];
    let logs: LogMessage[];
    let logSubscription: Subscription;

    const openClient = async (): Promise<dgram.Socket> => {
        const socket = dgram.createSocket('udp4');
        sockets.push(socket);
        socket.bind(0, '127.0.0.1');
        await once(socket, 'listening');
        return socket;
    };

    const send = (socket: dgram.Socket, bytes: Buffer | number[]): Promise<void> =>
        new Promise((resolve, reject) => socket.send(Buffer.from(bytes), port, '127.0.0.1', err => err ? reject(err) : resolve()));

    const nextMessage = (socket: dgram.Socket): Promise<Buffer> =>
        new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('no voice packet relayed within 2s')), 2000);
            socket.once('message', (msg) => {
                clearTimeout(timeout);
                resolve(msg);
            });
        });

    const malformedReports = () => logs.filter(l => l.origin === 'VoiceServer' && l.level === LogLevel.Error && /malformed/i.test(l.message));
    const relayFailures = () => logs.filter(l => l.origin === 'VoiceServer' && l.level === LogLevel.Error && /failed to relay/i.test(l.message));

    // Relays a valid packet from `from` to `to` and waits for it: a datagram sent earlier from
    // the same loopback socket has been handled by the time this one comes out the other side.
    const roundTrip = async (from: dgram.Socket, to: dgram.Socket, userId: number): Promise<Buffer> => {
        const relayed = nextMessage(to);
        await send(from, voicePacket(userId, 1));
        return relayed;
    };

    beforeEach(async () => {
        sockets = [];
        logs = [];
        logSubscription = Service.output$.subscribe(log => logs.push(log));

        unity = unityClientsOnLoopback();
        server = new VoiceServer(48000, '/nonexistent-voice-recordings', false, unity);
        internals = server as unknown as VoiceServerInternals;
        server.start(0, '127.0.0.1');
        await once(internals.udpSocket, 'listening');
        port = (internals.udpSocket.address() as AddressInfo).port;
    });

    afterEach(async () => {
        logSubscription.unsubscribe();
        for (const socket of sockets) socket.close();
        await server.stop();
    });

    // For the admin UI's server info, and its log's Connections switch.
    it('says whether it listens and records, and how many clients it has', async () => {
        expect(server.status).toEqual({ listening: true, recording: false, samplingRate: 48000, clients: 0 });
        const a = await openClient();
        const b = await openClient();
        await send(a, voicePacket(1, 1));
        await roundTrip(b, a, 2);
        expect(server.status.clients).toBe(2);

        expect(new VoiceServer(16000, '/nonexistent-voice-recordings', true, new FakeUnityClients()).status)
            .toEqual({ listening: false, recording: true, samplingRate: 16000, clients: 0 });
    });

    it('tags the line for a new client as a connection line', async () => {
        const a = await openClient();
        const b = await openClient();
        await send(a, voicePacket(1, 1));
        await roundTrip(b, a, 2);

        const connected = logs.find(l => l.message.startsWith('New voice client connected'));
        expect(connected?.metadata).toEqual({ connection: true });
    });

    it('survives a datagram shorter than the header and still relays valid packets', async () => {
        const a = await openClient();
        const b = await openClient();

        // The 2-byte datagram that used to kill the process with ERR_OUT_OF_RANGE.
        await send(a, [ 1, 2 ]);

        // a registers with a valid packet, then b's packet is relayed to a.
        await send(a, voicePacket(1, 1));
        const relayed = await roundTrip(b, a, 2);

        expect(relayed).toEqual(voicePacket(2, 1));
        expect(malformedReports()).toHaveLength(1);
        expect(malformedReports()[0]!.message).toContain(`127.0.0.1:${(a.address() as AddressInfo).port}`);
    });

    it('rejects every length up to the 11-byte header, and accepts a header-only packet', async () => {
        const a = await openClient();
        const b = await openClient();

        for (let length = 0; length < 11; length++) {
            // The 0..10-byte prefix of a well-formed packet: only the full header may register.
            await send(a, voicePacket(1, 1).subarray(0, length));
        }
        await send(b, voicePacket(2, 1));
        // a has not been registered by any of those, so nothing reaches it yet; b is the
        // only client. A header-only (11-byte) packet from a then registers a.
        await send(a, voicePacket(1, 1, []));
        const relayed = await roundTrip(b, a, 2);

        expect(relayed).toEqual(voicePacket(2, 1));
        expect(internals.clients.size).toBe(2);
        // All eleven short ones came from a, so they were reported once.
        expect(malformedReports()).toHaveLength(1);
    });

    it('reports malformed packets once per source per interval', async () => {
        const a = await openClient();
        const b = await openClient();

        await send(a, [ 1, 2 ]);
        await send(a, [ 1, 2, 3 ]);
        await send(a, [ 1 ]);
        await send(a, voicePacket(1, 1));
        await roundTrip(b, a, 2);
        expect(malformedReports()).toHaveLength(1);

        // A different source is reported on its own.
        await send(b, [ 9, 9 ]);
        await roundTrip(a, b, 1);
        expect(malformedReports()).toHaveLength(2);

        // Once the interval has passed, the same source is reported again.
        internals.pruneReports(Date.now() + 10000);
        expect(internals.reportedAt.size).toBe(0);
        await send(a, [ 1, 2 ]);
        await roundTrip(a, b, 1);
        expect(malformedReports()).toHaveLength(3);
    });

    it('drops a datagram from source port 0 instead of crashing on the next relay', async () => {
        const a = await openClient();
        const b = await openClient();

        // Only a raw socket can send from port 0, so this delivery is synthetic. A valid
        // packet from port 0 used to register a peer that udpSocket.send() rejects
        // synchronously (ERR_SOCKET_BAD_PORT), so relaying the next packet from anyone else
        // threw out of the 'message' listener: an uncaught exception that stops the server.
        internals.udpSocket.emit('message', voicePacket(9, 1), { address: '127.0.0.1', port: 0, family: 'IPv4', size: 9 });
        expect(internals.clients.size).toBe(0);

        // a and b register and relay to each other as if nothing had happened.
        await send(a, voicePacket(1, 1));
        expect(await roundTrip(b, a, 2)).toEqual(voicePacket(2, 1));
        expect(await roundTrip(a, b, 1)).toEqual(voicePacket(1, 1));

        expect(internals.clients.size).toBe(2);
        expect(malformedReports()).toHaveLength(1);
        expect(malformedReports()[0]!.message).toContain('127.0.0.1:0');
    });

    it('keeps relaying to the other peers when send() throws for one of them', async () => {
        // Nothing that registers through the listener fails send()'s argument checks any more
        // (port 0 is dropped above), so a peer it rejects is planted directly. It goes in first,
        // so every relay reaches it before a and b.
        internals.clients.set('127.0.0.1:0', {
            ip: '127.0.0.1', port: 0, userId: 9, appId: APP, lastSequence: 0, lastHeartbeat: Date.now(),
            frameSize: 960, frameSizeMillis: 20, codec: 0, recordingStartDate: new Date(), recordingData: { length: 0 },
        });
        const a = await openClient();
        const b = await openClient();

        // The ERR_SOCKET_BAD_PORT thrown for the planted peer used to escape the listener
        // (an uncaught exception) and skip every peer after it.
        await send(a, voicePacket(1, 1));
        for (let i = 0; i < 5; i++) {
            expect(await roundTrip(b, a, 2)).toEqual(voicePacket(2, 1));
            expect(await roundTrip(a, b, 1)).toEqual(voicePacket(1, 1));
        }

        // Ten failed relays to it, reported once.
        expect(relayFailures()).toHaveLength(1);
        expect(relayFailures()[0]!.message).toContain('127.0.0.1:0');
        expect(relayFailures()[0]!.message).toContain('Port should be > 0');
    });

    it('reports a peer that keeps failing asynchronously once per interval', async () => {
        const a = await openClient();
        const b = await openClient();
        const bPort = (b.address() as AddressInfo).port;

        // An asynchronous send error, as for a peer that has dropped off the network
        // (EHOSTUNREACH), arrives in the callback for every packet relayed to it.
        const realSend = internals.udpSocket.send.bind(internals.udpSocket) as (...args: unknown[]) => void;
        vi.spyOn(internals.udpSocket, 'send').mockImplementation(((...args: unknown[]) => {
            if (args[3] !== bPort) return realSend(...args);
            const callback = args[args.length - 1] as (err: Error | null) => void;
            setImmediate(() => callback(Object.assign(new Error('send EHOSTUNREACH'), { code: 'EHOSTUNREACH' })));
        }) as never);

        await send(b, voicePacket(2, 1));
        for (let i = 0; i < 5; i++) {
            await send(a, voicePacket(1, 1));
            expect(await roundTrip(b, a, 2)).toEqual(voicePacket(2, 1));
        }
        await new Promise(resolve => setImmediate(resolve));

        expect(relayFailures()).toHaveLength(1);
        expect(relayFailures()[0]!.message).toContain(`127.0.0.1:${bPort}: send EHOSTUNREACH`);

        // A peer's own malformed packets are reported separately from relay failures to it.
        await send(b, [ 1, 2 ]);
        await roundTrip(b, a, 2);
        expect(malformedReports()).toHaveLength(1);
    });

    it('bounds what it remembers about malformed senders', () => {
        // Synthetic deliveries from many distinct sources, as from a flood of spoofed
        // addresses - no real socket can send from that many ports quickly.
        for (let i = 0; i < 5000; i++) {
            internals.udpSocket.emit('message', Buffer.from([ 1, 2 ]), { address: '10.0.0.1', port: 1024 + i, family: 'IPv4', size: 2 });
        }

        expect(internals.reportedAt.size).toBeLessThanOrEqual(100);
        expect(malformedReports().length).toBeLessThanOrEqual(100);
        expect(internals.clients.size).toBe(0);
    });

    describe('apps', () => {
        const A = voiceAppId('app-a');
        const B = voiceAppId('app-b');

        // Everything `socket` receives from now on.
        const inbox = (socket: dgram.Socket): Buffer[] => {
            const received: Buffer[] = [];
            socket.on('message', msg => received.push(msg));
            return received;
        };

        // Resolves once `packet` reaches `socket`. The server relays to a peer in the order the
        // packets came in, so by then everything relayed to that peer before it has arrived too.
        const arrival = (socket: dgram.Socket, packet: Buffer): Promise<void> =>
            new Promise((resolve, reject) => {
                const onMessage = (msg: Buffer) => {
                    if (!msg.equals(packet)) return;
                    clearTimeout(timeout);
                    socket.off('message', onMessage);
                    resolve();
                };
                const timeout = setTimeout(() => {
                    socket.off('message', onMessage);
                    reject(new Error('voice packet not relayed within 2s'));
                }, 2000);
                socket.on('message', onMessage);
            });

        const sendAll = async (packets: [ dgram.Socket, Buffer ][]): Promise<void> => {
            for (const [ socket, packet ] of packets) await send(socket, packet);
        };

        it('relays a packet only to the other clients of its app, also where another app uses the same voice ids', async () => {
            const a1 = await openClient();
            const a2 = await openClient();
            const b1 = await openClient();
            const b2 = await openClient();
            const received = [ a1, a2, b1, b2 ].map(inbox);

            // Two apps with voice ids 1 and 2 each, as two projects with fixed voice ids can
            // have. Every voice packet used to go to every other voice client.
            const a1Joins = voicePacket(1, 0, [], A);
            const a2Joins = voicePacket(2, 0, [], A);
            const b1Joins = voicePacket(1, 0, [], B);
            const b2Joins = voicePacket(2, 0, [], B);
            const a1Says = voicePacket(1, 1, [ 0xa1, 0 ], A);
            const b1Says = voicePacket(1, 1, [ 0xb1, 0 ], B);
            const a2Says = voicePacket(2, 1, [ 0xa2, 0 ], A);
            const b2Says = voicePacket(2, 1, [ 0xb2, 0 ], B);
            const arrived = Promise.all([ arrival(a2, a1Says), arrival(b2, b1Says), arrival(a1, a2Says), arrival(b1, b2Says) ]);

            await sendAll([ [ a1, a1Joins ], [ a2, a2Joins ], [ b1, b1Joins ], [ b2, b2Joins ] ]);
            await sendAll([ [ a1, a1Says ], [ b1, b1Says ], [ a2, a2Says ], [ b2, b2Says ] ]);
            await arrived;

            expect(received).toEqual([
                [ a2Joins, a2Says ],
                [ a1Says ],
                [ b2Joins, b2Says ],
                [ b1Says ],
            ]);
        });

        it('relays a packet to every other client of its app', async () => {
            const a1 = await openClient();
            const a2 = await openClient();
            const a3 = await openClient();
            await sendAll([ [ a1, voicePacket(1, 0, [], A) ], [ a2, voicePacket(2, 0, [], A) ], [ a3, voicePacket(3, 0, [], A) ] ]);

            const a3Says = voicePacket(3, 1, [ 0xa3, 0 ], A);
            const arrived = Promise.all([ arrival(a1, a3Says), arrival(a2, a3Says) ]);
            await send(a3, a3Says);

            await arrived;
        });

        it('moves a client to the app its packets name', async () => {
            const a = await openClient();
            const c = await openClient();
            const b = await openClient();
            const received = [ a, c, b ].map(inbox);

            const cJoins = voicePacket(3, 0, [], A);
            const aMovesToB = voicePacket(1, 1, [ 1, 0 ], B);
            const bSays = voicePacket(2, 1, [ 2, 0 ], B);
            const aMovesBack = voicePacket(1, 2, [ 1, 0 ], A);
            const cSays = voicePacket(3, 1, [ 3, 0 ], A);
            const dJoins = voicePacket(4, 0, [], B);
            const arrived = Promise.all([ arrival(c, aMovesBack), arrival(a, cSays), arrival(b, dJoins) ]);

            await sendAll([ [ a, voicePacket(1, 0, [], A) ], [ c, cJoins ], [ b, voicePacket(2, 0, [], B) ] ]);
            // In app B, a hears b and not c; c, left on its own in A, is heard by nobody.
            await sendAll([ [ a, aMovesToB ], [ b, bSays ], [ c, voicePacket(3, 9, [ 3, 0 ], A) ] ]);
            // Back in A, a hears c again, and b no longer hears a. d is a last client of B, so
            // that b has received everything once d's packet is there.
            const d = await openClient();
            await sendAll([ [ a, aMovesBack ], [ c, cSays ], [ d, dJoins ] ]);
            await arrived;

            expect(received).toEqual([
                [ cJoins, bSays, cSays ],
                [ aMovesBack ],
                [ aMovesToB, dJoins ],
            ]);
            expect(internals.clients.size).toBe(4);
            const aPort = (a.address() as AddressInfo).port;
            expect(logs.filter(l => l.origin === 'VoiceServer' && /moved from app/.test(l.message)).map(l => [ l.level, l.message ])).toEqual([
                [ LogLevel.Debug, `Voice client 127.0.0.1:${aPort} ID: 1 moved from app ${appHex(A)} to app ${appHex(B)}` ],
                [ LogLevel.Debug, `Voice client 127.0.0.1:${aPort} ID: 1 moved from app ${appHex(B)} to app ${appHex(A)}` ],
            ]);
        });

        // |userId(2)|sequence(2)|frameSize(2)|codec(1)|data|: the header colibri-unity 1.x sends,
        // which has no app.
        const v1Packet = function (userId: number, codec: VoiceCodec, data: number[]): Buffer {
            const header = Buffer.alloc(7);
            header.writeInt16LE(userId, 0);
            header.writeInt16LE(0, 2);
            header.writeInt16LE(960, 4);
            header.writeUInt8(codec, 6);
            return Buffer.concat([ header, Buffer.from(data) ]);
        };

        const v1Reports = () => logs.filter(l => l.origin === 'VoiceServer' && l.level === LogLevel.Warn && /Colibri 1\.x/.test(l.message));

        it('relays nothing from a Colibri 1.x client, and says so once per source per interval', async () => {
            const a = await openClient();
            const b = await openClient();
            const received = inbox(b);
            await send(b, voicePacket(2, 0, [], APP));

            // PCM with samples, a header on its own, and a short Opus frame: none of them
            // registers a, and none reaches b.
            await sendAll([
                [ a, v1Packet(1, VoiceCodec.PCM, [ 1, 2, 3, 4, 5, 6, 7, 8 ]) ],
                [ a, v1Packet(1, VoiceCodec.PCM, []) ],
                [ a, v1Packet(1, VoiceCodec.OPUS, [ 0xf8 ]) ],
            ]);
            const aSays = voicePacket(1, 1, [ 1, 0 ], APP);
            const arrived = arrival(b, aSays);
            await send(a, aSays);
            await arrived;

            expect(received).toEqual([ aSays ]);
            expect(internals.clients.size).toBe(2);
            expect(malformedReports()).toHaveLength(0);
            expect(v1Reports()).toHaveLength(1);
            const message = v1Reports()[0]!.message;
            expect(message).toContain(`Ignoring voice packet from 127.0.0.1:${(a.address() as AddressInfo).port}: it looks like a Colibri 1.x client`);
            expect(message).toContain('Upgrade the Colibri Unity package (de.uni.kn.colibri) in that app to 2.x');
            expect(message).toContain('not reported for 10s');

            // Once the interval has passed, it is reported again.
            internals.pruneReports(Date.now() + 10000);
            await send(a, v1Packet(1, VoiceCodec.PCM, [ 1, 2 ]));
            await roundTrip(a, b, 1);
            expect(v1Reports()).toHaveLength(2);
        });

        it('relays nothing with a header version it does not know', async () => {
            const a = await openClient();
            const b = await openClient();
            const received = inbox(b);
            await send(b, voicePacket(2, 0, [], APP));

            const version3 = voicePacket(1, 1, [ 1, 0 ], APP);
            version3.writeUInt8(0x30, 6);
            await send(a, version3);
            const aSays = voicePacket(1, 2, [ 1, 0 ], APP);
            const arrived = arrival(b, aSays);
            await send(a, aSays);
            await arrived;

            expect(received).toEqual([ aSays ]);
            expect(malformedReports()).toHaveLength(1);
            expect(malformedReports()[0]!.message).toContain('its header version is 3, not 2');
            expect(v1Reports()).toHaveLength(0);
        });
    });

    // Voice is relayed only from the address of a Unity client of the packet's app. The addresses
    // here are documentation ones (RFC 5737): the packets are handed to the socket's listener as if
    // they came from there, and what the server sends is recorded, not sent.
    describe('Unity clients', () => {
        const LAB = voiceAppId('lab');
        const OTHER = voiceAppId('other');

        // Where `socket` relays each packet from now on, as address:port.
        const relays = (socket: dgram.Socket): string[] => {
            const sent: string[] = [];
            vi.spyOn(socket, 'send').mockImplementation(((...args: unknown[]) => void sent.push(`${args[4]}:${args[3]}`)) as never);
            return sent;
        };

        // Handled before this returns.
        const deliver = (socket: dgram.Socket, address: string, port: number, packet: Buffer): void => {
            socket.emit('message', packet, { address, port, family: address.includes(':') ? 'IPv6' : 'IPv4', size: packet.length });
        };

        // The server hears of a Unity client leaving in a microtask (see UnityClientAddresses).
        const settled = () => new Promise<void>(resolve => setImmediate(resolve));

        const ignoredReports = () => logs.filter(l => l.origin === 'VoiceServer' && l.level === LogLevel.Warn && /no Unity client/.test(l.message));
        const noRoomReports = () => logs.filter(l => l.origin === 'VoiceServer' && l.level === LogLevel.Warn && /as many voice clients already/.test(l.message));
        // The debug line for the first packet dropped from a source.
        const firstDrops = () => logs.filter(l => l.origin === 'VoiceServer' && l.level === LogLevel.Debug && /^Ignoring voice packet/.test(l.message));
        const appOf = (key: string) => (internals.clients.get(key) as { appId: number } | undefined)?.appId;

        // Runs `steps` with Date.now() stopped, at the start time plus what `at` was last given in ms.
        // A source's dropped packets are reported only once they have gone on for 3 s.
        const withClock = (steps: (at: (offsetMillis: number) => void) => void): void => {
            vi.useFakeTimers({ toFake: [ 'Date' ] });
            try {
                const start = Date.now();
                steps(offsetMillis => vi.setSystemTime(start + offsetMillis));
            } finally {
                vi.useRealTimers();
            }
        };

        it('relays voice from the address of a Unity client of the same app', () => {
            const sent = relays(internals.udpSocket);
            unity.connect('lab', '192.0.2.1');
            unity.connect('lab', '192.0.2.2');

            deliver(internals.udpSocket, '192.0.2.1', 5001, voicePacket(1, 0, [], LAB));
            deliver(internals.udpSocket, '192.0.2.2', 5002, voicePacket(2, 0, [], LAB));
            deliver(internals.udpSocket, '192.0.2.1', 5001, voicePacket(1, 1, [ 1, 0 ], LAB));

            expect(sent).toEqual([ '192.0.2.1:5001', '192.0.2.2:5002' ]);
            expect(server.status.clients).toBe(2);
            expect(ignoredReports()).toHaveLength(0);
        });

        // Every sender used to be registered and relayed to: one packet with a forged source
        // address every 2 s had the server stream an app's voice to that address.
        it('ignores voice from an address without a Unity client, and relays nothing to it', () => {
            const sent = relays(internals.udpSocket);
            unity.connect('lab', '192.0.2.1');
            withClock(at => {
                deliver(internals.udpSocket, '192.0.2.1', 5001, voicePacket(1, 0, [], LAB));

                // One a second for 4 s: reported at 3 s, and once only.
                for (let i = 0; i < 5; i++) {
                    at(i * 1000);
                    deliver(internals.udpSocket, '198.51.100.7', 4000, voicePacket(9, i, [ 9, 0 ], LAB));
                }
                deliver(internals.udpSocket, '192.0.2.1', 5001, voicePacket(1, 1, [ 1, 0 ], LAB));
            });

            expect(sent).toEqual([]);
            expect([ ...internals.clients.keys() ]).toEqual([ '192.0.2.1:5001' ]);
            expect(ignoredReports().map(l => l.message)).toEqual([
                `Ignoring voice packet from 198.51.100.7:4000 for app ${appHex(LAB)}: no Unity client of that app is connected from 198.51.100.7`
                    + ' (further ones from this source are not reported for 10s)',
            ]);
        });

        it('ignores voice for an app no Unity client at its address is in', () => {
            const sent = relays(internals.udpSocket);
            unity.connect('lab', '192.0.2.1');
            unity.connect('other', '192.0.2.2');
            withClock(at => {
                deliver(internals.udpSocket, '192.0.2.2', 5002, voicePacket(2, 0, [], OTHER));

                // Neither from a new sender, nor from one of lab changing app: that one stays in lab.
                for (const offset of [ 0, 3000 ]) {
                    at(offset);
                    deliver(internals.udpSocket, '192.0.2.1', 5001, voicePacket(1, 0, [], OTHER));
                    deliver(internals.udpSocket, '192.0.2.1', 5003, voicePacket(3, 0, [], LAB));
                    deliver(internals.udpSocket, '192.0.2.1', 5003, voicePacket(3, 1, [ 3, 0 ], OTHER));
                }
                deliver(internals.udpSocket, '192.0.2.2', 5002, voicePacket(2, 1, [ 2, 0 ], OTHER));
            });

            expect(sent).toEqual([]);
            expect([ ...internals.clients.keys() ].sort()).toEqual([ '192.0.2.1:5003', '192.0.2.2:5002' ]);
            expect((internals.clients.get('192.0.2.1:5003') as { appId: number }).appId).toBe(LAB);
            expect(ignoredReports().map(l => l.message.replace(/ \(further .*$/, ''))).toEqual([
                `Ignoring voice packet from 192.0.2.1:5001 for app ${appHex(OTHER)}: no Unity client of that app is connected from 192.0.2.1`,
                `Ignoring voice packet from 192.0.2.1:5003 for app ${appHex(OTHER)}: no Unity client of that app is connected from 192.0.2.1`,
            ]);
        });

        // Each voice client at an address has the app's voice sent there once more, and each source
        // port was one: forged packets from a thousand ports at a participant's address had every
        // packet of the app sent there a thousand times.
        it('lets in no more voice clients from an address than Unity clients of their app are connected from it', () => {
            const sent = relays(internals.udpSocket);
            unity.connect('lab', '192.0.2.1');
            unity.connect('lab', '192.0.2.2');
            withClock(at => {
                for (const offset of [ 0, 3000 ]) {
                    at(offset);
                    // Keeps sending, so that none of them takes its place.
                    deliver(internals.udpSocket, '192.0.2.1', 5001, voicePacket(1, offset, [], LAB));
                    for (let port = 10000; port < 11000; port++) deliver(internals.udpSocket, '192.0.2.1', port, voicePacket(9, 0, [], LAB));
                }
                deliver(internals.udpSocket, '192.0.2.2', 5002, voicePacket(2, 0, [ 2, 0 ], LAB));
            });

            expect(sent).toEqual([ '192.0.2.1:5001' ]);
            expect([ ...internals.clients.keys() ].sort()).toEqual([ '192.0.2.1:5001', '192.0.2.2:5002' ]);
            // Once per source, for as many sources as are remembered at a time.
            expect(noRoomReports()).toHaveLength(100);
            expect(noRoomReports()[0]!.message).toBe(`Ignoring voice packet from 192.0.2.1:10000 for app ${appHex(LAB)}: `
                + '192.0.2.1 has 1 Unity client(s) of that app, and as many voice clients already (further ones from this source are not reported for 10s)');
            expect(ignoredReports()).toHaveLength(0);
        });

        // Headsets behind one NAT address, or the Unity Editor and a build on one machine.
        it('lets in one voice client per Unity client of its app at an address', () => {
            unity.connect('lab', '192.0.2.1');
            unity.connect('lab', '::ffff:192.0.2.1');
            unity.connect('other', '192.0.2.1');
            unity.connect('other', '192.0.2.1');

            withClock(at => {
                deliver(internals.udpSocket, '192.0.2.1', 5001, voicePacket(1, 0, [], LAB));
                deliver(internals.udpSocket, '192.0.2.1', 5003, voicePacket(3, 0, [], LAB));
                deliver(internals.udpSocket, '192.0.2.1', 5005, voicePacket(5, 0, [], LAB));
                deliver(internals.udpSocket, '192.0.2.1', 5007, voicePacket(7, 0, [], OTHER));
                // Nor can one move into an app without room for it. It stays where it was.
                deliver(internals.udpSocket, '192.0.2.1', 5007, voicePacket(7, 1, [], LAB));
                expect([ ...internals.clients.keys() ].sort()).toEqual([ '192.0.2.1:5001', '192.0.2.1:5003', '192.0.2.1:5007' ]);
                expect(appOf('192.0.2.1:5007')).toBe(OTHER);

                // Still so 3 s on, while those of lab keep sending: now they are reported.
                at(3000);
                deliver(internals.udpSocket, '192.0.2.1', 5001, voicePacket(1, 1, [], LAB));
                deliver(internals.udpSocket, '192.0.2.1', 5003, voicePacket(3, 1, [], LAB));
                deliver(internals.udpSocket, '192.0.2.1', 5005, voicePacket(5, 1, [], LAB));
                deliver(internals.udpSocket, '192.0.2.1', 5007, voicePacket(7, 2, [], LAB));
                expect(appOf('192.0.2.1:5007')).toBe(OTHER);

                // One that moves out makes room.
                deliver(internals.udpSocket, '192.0.2.1', 5003, voicePacket(3, 2, [], OTHER));
                deliver(internals.udpSocket, '192.0.2.1', 5005, voicePacket(5, 2, [], LAB));
            });

            expect([ '192.0.2.1:5001', '192.0.2.1:5003', '192.0.2.1:5005', '192.0.2.1:5007' ].map(appOf)).toEqual([ LAB, OTHER, LAB, OTHER ]);
            expect(noRoomReports().map(l => l.message.replace(/ \(further .*$/, ''))).toEqual([
                `Ignoring voice packet from 192.0.2.1:5005 for app ${appHex(LAB)}: 192.0.2.1 has 2 Unity client(s) of that app, and as many voice clients already`,
                `Ignoring voice packet from 192.0.2.1:5007 for app ${appHex(LAB)}: 192.0.2.1 has 2 Unity client(s) of that app, and as many voice clients already`,
            ]);
        });

        // VoiceServerConnection disabled and enabled again sends from a new port, while the voice
        // client of the old one has not timed out yet.
        it('lets a new sender take the place of a voice client that has sent nothing for 500 ms', () => {
            const sent = relays(internals.udpSocket);
            unity.connect('lab', '192.0.2.1');
            unity.connect('lab', '192.0.2.2');

            vi.useFakeTimers({ toFake: [ 'Date' ] });
            try {
                const start = Date.now();
                deliver(internals.udpSocket, '192.0.2.1', 5001, voicePacket(1, 0, [], LAB));
                deliver(internals.udpSocket, '192.0.2.2', 5002, voicePacket(2, 0, [], LAB));

                vi.setSystemTime(start + 499);
                deliver(internals.udpSocket, '192.0.2.1', 5003, voicePacket(1, 0, [], LAB));
                expect([ ...internals.clients.keys() ].sort()).toEqual([ '192.0.2.1:5001', '192.0.2.2:5002' ]);

                vi.setSystemTime(start + 500);
                deliver(internals.udpSocket, '192.0.2.1', 5003, voicePacket(1, 1, [], LAB));
                deliver(internals.udpSocket, '192.0.2.2', 5002, voicePacket(2, 1, [ 2, 0 ], LAB));
            } finally {
                vi.useRealTimers();
            }

            expect(sent).toEqual([ '192.0.2.1:5001', '192.0.2.2:5002', '192.0.2.1:5003' ]);
            expect([ ...internals.clients.keys() ].sort()).toEqual([ '192.0.2.1:5003', '192.0.2.2:5002' ]);
            // Let in within 3 s of its first dropped packet, so not reported.
            expect(noRoomReports()).toHaveLength(0);
            const replaced = logs.filter(l => l.origin === 'VoiceServer' && /takes its place/.test(l.message));
            expect(replaced.map(l => [ l.level, l.message, l.metadata ])).toEqual([
                [ LogLevel.Debug, 'Voice client 192.0.2.1:5001 disconnected ID: 1: no packet for 500 ms, and 192.0.2.1:5003 takes its place', { connection: true } ],
            ]);
        });

        // A Unity client's voice starts a moment before its TCP handshake has registered it, so its
        // first packets are dropped. That used to be a warning at every client start.
        it('does not report a sender let in within 3 s of its first dropped packet', async () => {
            const sent = relays(internals.udpSocket);
            const debugTail = ' (reported as a warning if this goes on for 3s: a Unity client\'s voice can start before its TCP handshake is in)';
            withClock(at => {
                deliver(internals.udpSocket, '192.0.2.1', 5001, voicePacket(1, 0, [], LAB));
                at(150);
                deliver(internals.udpSocket, '192.0.2.1', 5001, voicePacket(1, 1, [], LAB));
                unity.connect('lab', '192.0.2.1');
                at(170);
                deliver(internals.udpSocket, '192.0.2.1', 5001, voicePacket(1, 2, [], LAB));

                // A second client at the same address, until its own handshake is in.
                deliver(internals.udpSocket, '192.0.2.1', 5003, voicePacket(3, 0, [], LAB));
                at(2999);
                deliver(internals.udpSocket, '192.0.2.1', 5001, voicePacket(1, 3, [], LAB));
                deliver(internals.udpSocket, '192.0.2.1', 5003, voicePacket(3, 1, [], LAB));
                unity.connect('lab', '192.0.2.1');
                deliver(internals.udpSocket, '192.0.2.1', 5003, voicePacket(3, 2, [], LAB));
            });

            expect(sent).toEqual([ '192.0.2.1:5001' ]);
            expect([ ...internals.clients.keys() ].sort()).toEqual([ '192.0.2.1:5001', '192.0.2.1:5003' ]);
            expect(ignoredReports()).toHaveLength(0);
            expect(noRoomReports()).toHaveLength(0);
            // The first dropped packet of each is a debug line, among the connection lines.
            expect(firstDrops().map(l => [ l.message, l.metadata ])).toEqual([
                [ `Ignoring voice packet from 192.0.2.1:5001 for app ${appHex(LAB)}: no Unity client of that app is connected from 192.0.2.1${debugTail}`,
                    { connection: true } ],
                [ `Ignoring voice packet from 192.0.2.1:5003 for app ${appHex(LAB)}: 192.0.2.1 has 1 Unity client(s) of that app, and as many voice `
                    + `clients already${debugTail}`, { connection: true } ],
            ]);
            // Each forgot its first dropped packet once it was let in.
            expect(internals.rejections.size).toBe(0);

            // Dropped again once its Unity clients have left, it gets the 3 s anew.
            unity.disconnectApp('lab');
            await settled();
            withClock(at => {
                at(1);
                deliver(internals.udpSocket, '192.0.2.1', 5001, voicePacket(1, 4, [], LAB));
                at(3000);
                deliver(internals.udpSocket, '192.0.2.1', 5001, voicePacket(1, 5, [], LAB));
                expect(ignoredReports()).toHaveLength(0);
                at(3001);
                deliver(internals.udpSocket, '192.0.2.1', 5001, voicePacket(1, 6, [], LAB));
            });
            expect(ignoredReports().map(l => l.message)).toEqual([
                `Ignoring voice packet from 192.0.2.1:5001 for app ${appHex(LAB)}: no Unity client of that app is connected from 192.0.2.1`
                    + ' (further ones from this source are not reported for 10s)',
            ]);
            expect(firstDrops()).toHaveLength(3);
        });

        it('reports a sender whose packets are still dropped after 3 s, once every 10 s', () => {
            unity.connect('lab', '192.0.2.1');
            const ignoredAt: number[] = [];
            const noRoomAt: number[] = [];
            withClock(at => {
                // A packet every 20 ms from each, as VoiceBroadcast sends, for 23 s.
                for (let t = 0; t <= 23000; t += 20) {
                    at(t);
                    const [ ignored, noRoom ] = [ ignoredReports().length, noRoomReports().length ];
                    deliver(internals.udpSocket, '192.0.2.1', 5001, voicePacket(1, t / 20, [], LAB));
                    deliver(internals.udpSocket, '192.0.2.1', 5003, voicePacket(3, t / 20, [], LAB));
                    deliver(internals.udpSocket, '198.51.100.7', 4000, voicePacket(9, t / 20, [], LAB));
                    if (ignoredReports().length > ignored) ignoredAt.push(t);
                    if (noRoomReports().length > noRoom) noRoomAt.push(t);
                }
            });

            expect(ignoredAt).toEqual([ 3000, 13000, 23000 ]);
            expect(noRoomAt).toEqual([ 3000, 13000, 23000 ]);
            expect(ignoredReports()[0]!.message).toBe(`Ignoring voice packet from 198.51.100.7:4000 for app ${appHex(LAB)}: `
                + 'no Unity client of that app is connected from 198.51.100.7 (further ones from this source are not reported for 10s)');
            expect(firstDrops()).toHaveLength(2);
            expect([ ...internals.clients.keys() ]).toEqual([ '192.0.2.1:5001' ]);
        });

        it('bounds and prunes what it remembers about senders whose packets it drops', () => {
            const source = (i: number) => `198.51.100.7:${1024 + i}`;
            withClock(at => {
                // Synthetic deliveries from many distinct sources, as from a flood of forged ones.
                const flood = (sequence: number) => {
                    for (let i = 0; i < 5000; i++) deliver(internals.udpSocket, '198.51.100.7', 1024 + i, voicePacket(9, sequence, [], LAB));
                };
                flood(0);
                expect(internals.rejections.size).toBe(100);
                expect(firstDrops()).toHaveLength(100);
                at(3000);
                flood(1);
                expect(internals.rejections.size).toBe(100);
                expect(ignoredReports()).toHaveLength(100);
                expect(ignoredReports()[0]!.message).toContain(`from ${source(0)} `);

                // One goes on, the others stop. Theirs are forgotten 10 s after their last.
                at(12999);
                deliver(internals.udpSocket, '198.51.100.7', 1024, voicePacket(9, 2, [], LAB));
                internals.pruneReports(Date.now());
                expect(internals.rejections.size).toBe(100);
                at(13000);
                internals.pruneReports(Date.now());
                expect([ ...internals.rejections.keys() ]).toEqual([ source(0) ]);

                // The one that went on keeps its time, and is reported again 10 s after the last time.
                deliver(internals.udpSocket, '198.51.100.7', 1024, voicePacket(9, 3, [], LAB));
                expect(ignoredReports()).toHaveLength(101);
                // A new one gets a slot again, and its 3 s.
                deliver(internals.udpSocket, '198.51.100.7', 1024 + 4999, voicePacket(9, 3, [], LAB));
                expect([ ...internals.rejections.keys() ]).toEqual([ source(0), source(4999) ]);
                expect(ignoredReports()).toHaveLength(101);
            });
        });

        // Behind a proxy every voice packet comes from the proxy's address, which no Unity client has.
        it('relays voice from a trusted proxy unchecked, and says so once', async () => {
            const proxied = new VoiceServer(48000, '/nonexistent-voice-recordings', false, unity, compileTrustedProxies([ '192.0.2.100' ]));
            proxied.start(0, '127.0.0.1');
            const socket = (proxied as unknown as VoiceServerInternals).udpSocket;
            await once(socket, 'listening');
            try {
                const sent = relays(socket);
                // A Unity client of lab on the proxy's machine, connected without the proxy.
                const onProxy = unity.connect('lab', '192.0.2.100');
                withClock(at => {
                    deliver(socket, '192.0.2.100', 6001, voicePacket(1, 0, [], LAB));
                    deliver(socket, '192.0.2.100', 6002, voicePacket(2, 0, [], LAB));
                    deliver(socket, '192.0.2.100', 6001, voicePacket(1, 1, [ 1, 0 ], LAB));
                    // Anyone else still needs a Unity client.
                    deliver(socket, '198.51.100.7', 4000, voicePacket(9, 0, [], LAB));
                    at(3000);
                    deliver(socket, '198.51.100.7', 4000, voicePacket(9, 1, [], LAB));
                });
                // Nor are the proxy's voice clients dropped when that Unity client leaves: they are
                // not its own, but those of whoever is behind the proxy.
                unity.disconnect(onProxy);
                await settled();

                expect(sent).toEqual([ '192.0.2.100:6001', '192.0.2.100:6002' ]);
                expect(proxied.status.clients).toBe(2);
                expect(logs.filter(l => l.origin === 'VoiceServer' && /^New voice client connected from 192\.0\.2\.100:/.test(l.message))
                    .map(l => l.message.endsWith(' (through a trusted proxy, unchecked)'))).toEqual([ true, true ]);
                expect(logs.filter(l => l.origin === 'VoiceServer' && l.level === LogLevel.Info && /unchecked/.test(l.message)).map(l => l.message)).toEqual([
                    'Relaying voice from 192.0.2.100 unchecked: it is in TRUSTED_PROXIES, and voice through a proxy cannot be matched to a Unity client\'s address. '
                        + 'Logged once per address.',
                ]);
                expect(ignoredReports()).toHaveLength(1);
            } finally {
                await proxied.stop();
            }
        });

        it('drops the voice clients at an address once the last Unity client of their app there leaves', async () => {
            const sent = relays(internals.udpSocket);
            const first = unity.connect('lab', '192.0.2.1');
            const second = unity.connect('lab', '192.0.2.1');
            unity.connect('lab', '192.0.2.2');
            unity.connect('other', '192.0.2.1');
            deliver(internals.udpSocket, '192.0.2.1', 5001, voicePacket(1, 0, [], LAB));
            deliver(internals.udpSocket, '192.0.2.2', 5002, voicePacket(2, 0, [], LAB));
            deliver(internals.udpSocket, '192.0.2.1', 5003, voicePacket(3, 0, [], OTHER));
            expect(sent).toEqual([ '192.0.2.1:5001' ]);

            // Another Unity client of lab is still connected from there.
            unity.disconnect(first);
            await settled();
            expect(server.status.clients).toBe(3);

            unity.disconnect(second);
            await settled();
            expect(server.status.clients).toBe(2);
            expect([ ...internals.clients.keys() ].sort()).toEqual([ '192.0.2.1:5003', '192.0.2.2:5002' ]);
            const dropped = logs.filter(l => l.origin === 'VoiceServer' && /no Unity client of app/.test(l.message));
            expect(dropped.map(l => [ l.level, l.message, l.metadata ])).toEqual([
                [ LogLevel.Debug, `Voice client 192.0.2.1:5001 disconnected ID: 1: no Unity client of app ${appHex(LAB)} is connected from 192.0.2.1 any more`, { connection: true } ],
            ]);

            // It hears nothing more, and is not let in again, which is reported once it has gone on for 3 s.
            withClock(at => {
                deliver(internals.udpSocket, '192.0.2.2', 5002, voicePacket(2, 1, [ 2, 0 ], LAB));
                deliver(internals.udpSocket, '192.0.2.1', 5001, voicePacket(1, 1, [ 1, 0 ], LAB));
                at(3000);
                deliver(internals.udpSocket, '192.0.2.2', 5002, voicePacket(2, 2, [ 2, 0 ], LAB));
                deliver(internals.udpSocket, '192.0.2.1', 5001, voicePacket(1, 2, [ 1, 0 ], LAB));
            });
            expect(sent).toEqual([ '192.0.2.1:5001' ]);
            expect(server.status.clients).toBe(2);
            expect(ignoredReports()).toHaveLength(1);
        });

        // Two headsets behind one NAT address, one of which quits. Its voice client may well have
        // sent its last packet after the other's latest, so the one that has gone the longest
        // without a packet is the right one to drop only once the one that left has gone quiet.
        it('drops the voice clients over the Unity clients of their app left at an address 500 ms after one leaves, the quietest first', async () => {
            const leaving = unity.connect('lab', '192.0.2.1');
            unity.connect('lab', '192.0.2.1');

            vi.useFakeTimers({ toFake: [ 'Date' ] });
            try {
                const start = Date.now();
                deliver(internals.udpSocket, '192.0.2.1', 5001, voicePacket(1, 0, [], LAB));
                vi.setSystemTime(start + 10);
                deliver(internals.udpSocket, '192.0.2.1', 5003, voicePacket(3, 0, [], LAB));
                vi.setSystemTime(start + 20);
                deliver(internals.udpSocket, '192.0.2.1', 5001, voicePacket(1, 1, [], LAB));
                unity.disconnect(leaving);
                await settled();

                // The headset left sends on.
                vi.setSystemTime(start + 519);
                deliver(internals.udpSocket, '192.0.2.1', 5001, voicePacket(1, 2, [], LAB));
                await internals.checkClientsDisconnected();
                expect([ ...internals.clients.keys() ].sort()).toEqual([ '192.0.2.1:5001', '192.0.2.1:5003' ]);

                vi.setSystemTime(start + 520);
                await internals.checkClientsDisconnected();
                expect([ ...internals.clients.keys() ]).toEqual([ '192.0.2.1:5001' ]);

                // Nor is there room for it again while the other sends, which is reported once it
                // has gone on for 3 s.
                deliver(internals.udpSocket, '192.0.2.1', 5003, voicePacket(3, 1, [], LAB));
                expect([ ...internals.clients.keys() ]).toEqual([ '192.0.2.1:5001' ]);
                vi.setSystemTime(start + 3520);
                deliver(internals.udpSocket, '192.0.2.1', 5001, voicePacket(1, 3, [], LAB));
                deliver(internals.udpSocket, '192.0.2.1', 5003, voicePacket(3, 2, [], LAB));
                expect([ ...internals.clients.keys() ]).toEqual([ '192.0.2.1:5001' ]);
            } finally {
                vi.useRealTimers();
            }

            const dropped = logs.filter(l => l.origin === 'VoiceServer' && /Unity client\(s\) of app .* left$/.test(l.message));
            expect(dropped.map(l => [ l.level, l.message, l.metadata ])).toEqual([
                [ LogLevel.Debug, `Voice client 192.0.2.1:5003 disconnected ID: 3: 192.0.2.1 has only 1 Unity client(s) of app ${appHex(LAB)} left`, { connection: true } ],
            ]);
            expect(noRoomReports()).toHaveLength(1);
        });

        // TCPServerProxy reports a second handshake as the client leaving and connecting again.
        it('keeps the voice clients of a Unity client that handshakes again into the same app', async () => {
            const client = unity.connect('lab', '192.0.2.1');
            deliver(internals.udpSocket, '192.0.2.1', 5001, voicePacket(1, 0, [], LAB));

            unity.disconnect(client);
            unity.connect('lab', '192.0.2.1');
            await settled();

            expect([ ...internals.clients.keys() ]).toEqual([ '192.0.2.1:5001' ]);
        });

        // A dual-stack TCP socket reports an IPv4 client as ::ffff:192.0.2.1.
        it('matches an IPv4-mapped IPv6 address as the IPv4 address it maps, on either side', async () => {
            const sent = relays(internals.udpSocket);
            const mapped = unity.connect('lab', '::ffff:192.0.2.1');
            unity.connect('lab', '192.0.2.2');

            deliver(internals.udpSocket, '192.0.2.1', 5001, voicePacket(1, 0, [], LAB));
            deliver(internals.udpSocket, '::ffff:192.0.2.2', 5002, voicePacket(2, 0, [], LAB));
            expect(sent).toEqual([ '192.0.2.1:5001' ]);

            unity.disconnect(mapped);
            await settled();
            expect([ ...internals.clients.keys() ]).toEqual([ '::ffff:192.0.2.2:5002' ]);
        });
    });
});

describe('VoiceServer startup', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    // The 'listening' handler printed 'Voice server listening on ...' with a bare console.log
    // and then logged the same line, which the console sink prints as well.
    it('says it is listening exactly once', async () => {
        const printed: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void printed.push(args.map(String).join(' ')));
        // The sink main.ts attaches, writing here instead of to stdout/stderr.
        const sink = new ConsoleLog({ minLevel: LogLevel.Debug, broadcastTraffic: false }, {
            out: line => printed.push(line),
            err: line => printed.push(line),
        });
        const subscription = sink.attach(Service.output$);

        const server = new VoiceServer(48000, '/nonexistent-voice-recordings', false, new FakeUnityClients());
        try {
            server.start(0, '127.0.0.1');
            await once((server as unknown as VoiceServerInternals).udpSocket, 'listening');

            const listening = printed.filter(line => line.includes('Voice server listening on'));
            expect(listening).toHaveLength(1);
            expect(listening[0]).toMatch(/ INFO {2}\[web\/VoiceServer\] Voice server listening on 127\.0\.0\.1:\d+$/);
        } finally {
            subscription.unsubscribe();
            await server.stop();
        }
    });

    // The socket's 'error' handler was a bare console.error(err.message): a voice port that
    // was already taken printed only 'bind EADDRINUSE 127.0.0.1:<port>' on stderr, never
    // reached the admin UI's log, and said nothing of voice being off while the rest ran on.
    describe('socket errors', () => {
        let logs: LogMessage[];
        let stderr: string[];
        let consoleError: ReturnType<typeof vi.spyOn>;
        let subscriptions: Subscription[];
        let sockets: dgram.Socket[];
        let server: VoiceServer;

        beforeEach(() => {
            logs = [];
            stderr = [];
            sockets = [];
            consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
            // What the admin UI's WebLog sees, and what the sink main.ts attaches prints on stderr.
            const sink = new ConsoleLog({ minLevel: LogLevel.Info, broadcastTraffic: false }, {
                out: () => undefined,
                err: line => stderr.push(line),
            });
            subscriptions = [ Service.output$.subscribe(log => logs.push(log)), sink.attach(Service.output$) ];
            server = new VoiceServer(48000, '/nonexistent-voice-recordings', false, new FakeUnityClients());
        });

        afterEach(async () => {
            for (const subscription of subscriptions) subscription.unsubscribe();
            await server.stop();
            for (const socket of sockets) socket.close();
        });

        const errors = () => logs.filter(l => l.origin === 'VoiceServer' && l.level === LogLevel.Error);

        it('says where voice could not listen, and that voice is disabled, when the port is taken', async () => {
            const taken = dgram.createSocket('udp4');
            sockets.push(taken);
            taken.bind(0, '127.0.0.1');
            await once(taken, 'listening');
            const port = (taken.address() as AddressInfo).port;

            server.start(port, '127.0.0.1');
            await once((server as unknown as VoiceServerInternals).udpSocket, 'error');

            expect(errors()).toHaveLength(1);
            const message = errors()[0]!.message;
            expect(message).toContain(`Voice server could not listen on UDP 127.0.0.1:${port}`);
            expect(message).toContain('another process is already using');
            expect(message).toContain(`bind EADDRINUSE 127.0.0.1:${port}`);
            expect(message).toContain('Voice is disabled');
            expect(stderr).toHaveLength(1);
            expect(stderr[0]).toMatch(/ ERROR \[web\/VoiceServer\] Voice server could not listen on UDP /);
            expect(consoleError).not.toHaveBeenCalled();
            // afterEach then stops it, which must not throw for a socket that never listened.
        });

        it('reports an error once it is listening with its context, once per interval', async () => {
            server.start(0, '127.0.0.1');
            const udpSocket = (server as unknown as VoiceServerInternals).udpSocket;
            await once(udpSocket, 'listening');

            for (let i = 0; i < 3; i++) {
                udpSocket.emit('error', Object.assign(new Error('recvmsg ECONNRESET'), { code: 'ECONNRESET' }));
            }

            expect(errors()).toHaveLength(1);
            expect(errors()[0]!.message).toContain('Voice server socket error on UDP 127.0.0.1:0: recvmsg ECONNRESET');
            expect(errors()[0]!.message).not.toContain('Voice is disabled');
            expect(consoleError).not.toHaveBeenCalled();
        });
    });
});

describe('voiceSocketOptions', () => {
    // An IPv6 VOICE_HOST used to get the udp4 socket as well, which cannot bind it (EINVAL), and
    // voice stayed off.
    it.each([ '::', '::1', '2001:db8::1', 'fe80::1%lo' ])('gives %s an IPv6 socket that takes IPv4 as well', (host) => {
        expect(voiceSocketOptions(host)).toEqual({ type: 'udp6', ipv6Only: false });
    });

    it.each([ '0.0.0.0', '127.0.0.1', 'localhost', 'voice.example.org' ])('gives %s the IPv4 socket', (host) => {
        expect(voiceSocketOptions(host)).toEqual({ type: 'udp4' });
    });
});

// Whether this machine has an IPv6 loopback, and whether its IPv6 sockets take IPv4 too, which
// they do unless the system says otherwise (on Linux, net.ipv6.bindv6only=1).
const hasIPv6Loopback = Object.values(networkInterfaces()).some(addresses => addresses?.some(a => a.address === '::1'));
const BINDV6ONLY = '/proc/sys/net/ipv6/bindv6only';
const ipv6TakesIPv4 = !existsSync(BINDV6ONLY) || readFileSync(BINDV6ONLY, 'utf8').trim() === '0';

describe.skipIf(!hasIPv6Loopback)('VoiceServer on an IPv6 VOICE_HOST', () => {
    let server: VoiceServer | undefined;
    let sockets: dgram.Socket[];

    beforeEach(() => {
        server = undefined;
        sockets = [];
    });

    afterEach(async () => {
        for (const socket of sockets) socket.close();
        await server?.stop();
    });

    // Voice is relayed only from the address of a Unity client of its app, one voice client per
    // Unity client: two on the IPv6 loopback, one on the IPv4 loopback.
    const start = async (host: string): Promise<dgram.Socket> => {
        const unity = new FakeUnityClients();
        unity.connect('voice-test', '::1');
        unity.connect('voice-test', '::1');
        unity.connect('voice-test', '127.0.0.1');
        server = new VoiceServer(48000, '/nonexistent-voice-recordings', false, unity);
        server.start(0, host);
        const udpSocket = (server as unknown as VoiceServerInternals).udpSocket;
        await once(udpSocket, 'listening');
        return udpSocket;
    };

    const openClient = async (type: 'udp4' | 'udp6'): Promise<dgram.Socket> => {
        const socket = dgram.createSocket(type);
        sockets.push(socket);
        socket.bind(0, type === 'udp4' ? '127.0.0.1' : '::1');
        await once(socket, 'listening');
        return socket;
    };

    const sendTo = (socket: dgram.Socket, port: number, host: string, packet: Buffer): Promise<void> =>
        new Promise((resolve, reject) => socket.send(packet, port, host, err => err ? reject(err) : resolve()));

    const nextMessage = (socket: dgram.Socket): Promise<Buffer> =>
        new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('no voice packet relayed within 2s')), 2000);
            socket.once('message', (msg) => {
                clearTimeout(timeout);
                resolve(msg);
            });
        });

    it('relays between clients on the IPv6 loopback', async () => {
        const udpSocket = await start('::1');
        const { port, family } = udpSocket.address() as AddressInfo;
        expect(family).toBe('IPv6');
        const a = await openClient('udp6');
        const b = await openClient('udp6');

        await sendTo(a, port, '::1', voicePacket(1, 1));
        const relayed = nextMessage(a);
        await sendTo(b, port, '::1', voicePacket(2, 1));

        expect(await relayed).toEqual(voicePacket(2, 1));
    });

    // VOICE_HOST=:: for a server reached over IPv6, where Unity clients on IPv4 still have to be heard.
    it.skipIf(!ipv6TakesIPv4)('takes IPv4 clients as well on ::, and relays between the two kinds', async () => {
        const { port } = (await start('::')).address() as AddressInfo;
        const v4 = await openClient('udp4');
        const v6 = await openClient('udp6');

        await sendTo(v4, port, '127.0.0.1', voicePacket(1, 1));
        const toV4 = nextMessage(v4);
        await sendTo(v6, port, '::1', voicePacket(2, 1));
        expect(await toV4).toEqual(voicePacket(2, 1));

        const toV6 = nextMessage(v6);
        await sendTo(v4, port, '127.0.0.1', voicePacket(1, 2));
        expect(await toV6).toEqual(voicePacket(1, 2));
        expect(server!.status.clients).toBe(2);
    });
});

describe('VoiceServer recordings', () => {
    const SAMPLING_RATE = 48000;

    let unity: FakeUnityClients;
    let dir: string;
    let server: VoiceServer;
    let internals: VoiceServerInternals;
    let port: number;
    let sockets: dgram.Socket[];
    let logs: LogMessage[];
    let logSubscription: Subscription;

    beforeEach(async () => {
        sockets = [];
        logs = [];
        logSubscription = Service.output$.subscribe(log => logs.push(log));
        dir = await mkdtemp(path.join(tmpdir(), 'colibri-voice-recordings-'));

        unity = unityClientsOnLoopback();
        server = new VoiceServer(SAMPLING_RATE, dir, true, unity);
        internals = server as unknown as VoiceServerInternals;
        server.start(0, '127.0.0.1');
        await once(internals.udpSocket, 'listening');
        port = (internals.udpSocket.address() as AddressInfo).port;
    });

    afterEach(async () => {
        logSubscription.unsubscribe();
        for (const socket of sockets) socket.close();
        await server.stop();
        await rm(dir, { recursive: true, force: true });
    });

    const openClient = async (): Promise<dgram.Socket> => {
        const socket = dgram.createSocket('udp4');
        sockets.push(socket);
        socket.bind(0, '127.0.0.1');
        await once(socket, 'listening');
        return socket;
    };

    const send = (socket: dgram.Socket, bytes: Buffer): Promise<void> =>
        new Promise((resolve, reject) => socket.send(bytes, port, '127.0.0.1', err => err ? reject(err) : resolve()));

    // Sends `samples` from a new client as user `userId`, 480 to a packet, and returns once the
    // server has handled every packet: each is relayed to a listener registered beforehand,
    // which sends nothing that would be recorded itself.
    const talk = async (userId: number, samples: number[]): Promise<void> => {
        const listener = await openClient();
        await send(listener, voicePacket(99, 0, []));
        const speaker = await openClient();
        for (let i = 0; i < samples.length; i += 480) {
            const relayed = once(listener, 'message');
            await send(speaker, pcmPacket(userId, i / 480, samples.slice(i, i + 480)));
            await relayed;
        }
    };

    const recordings = async () => (await readdir(dir)).filter(name => name.endsWith('.wav')).sort();

    const readSamples = async (name: string): Promise<number[]> => {
        const wav = new WaveFile(await readFile(path.join(dir, name)));
        expect(wav.fmt).toMatchObject({ audioFormat: 1, numChannels: 1, sampleRate: SAMPLING_RATE, bitsPerSample: 16 });
        return Array.from(wav.getSamples(false, Int16Array) as unknown as Int16Array);
    };

    const savedLogs = () => logs.filter(l => l.origin === 'VoiceServer' && /Voice recording of client ID \d+ .* saved to /.test(l.message));

    const someSamples = (count: number, seed: number) => Array.from({ length: count }, (_, i) => Math.round(30000 * Math.sin((i + seed) / 7)));

    // A recording used to be saved only once its client had been quiet for 2 s. stop() closed the
    // socket and returned, so `docker stop` or a restart while anyone was still talking left no
    // .wav file, and no log line saying a recording had been dropped.
    it('saves a recording still in progress when it stops, and logs it', async () => {
        const samples = someSamples(4800, 0);
        await talk(7, samples);
        expect(await recordings()).toEqual([]);

        await server.stop();

        const files = await recordings();
        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(new RegExp(`^rec_\\d{4}-\\d\\d-\\d\\dT\\d\\d_\\d\\d_\\d\\d\\.\\d{3}Z_app_${appHex(APP)}_ID_7_port_\\d+\\.wav$`));
        expect(await readSamples(files[0]!)).toEqual(samples);

        const saved = savedLogs();
        expect(saved).toHaveLength(1);
        // Info, so the default CONSOLE_LOG_LEVEL prints it.
        expect(saved[0]!.level).toBe(LogLevel.Info);
        expect(saved[0]!.message).toContain('Voice recording of client ID 7 (127.0.0.1:');
        expect(saved[0]!.message).toContain(`, 0.1 s) saved to ${path.join(dir, files[0]!)}`);
    });

    it('saves every client\'s recording when it stops', async () => {
        const first = someSamples(960, 1);
        const second = someSamples(1440, 2);
        await talk(1, first);
        await talk(2, second);

        await server.stop();

        const files = await recordings();
        expect(files.map(name => /_ID_(\d+)_port_/.exec(name)?.[1])).toEqual([ '1', '2' ]);
        expect(await readSamples(files[0]!)).toEqual(first);
        expect(await readSamples(files[1]!)).toEqual(second);
        expect(savedLogs()).toHaveLength(2);
    });

    // After a restart or a dropped network every client registers again within one 20 ms frame,
    // and two apps may use the same voice id. The file name used to hold only the start time
    // and the voice id, so the second of two such recordings replaced the first.
    it('keeps apart the recordings of clients with the same voice id that start in the same millisecond', async () => {
        const A = voiceAppId('app-a');
        const B = voiceAppId('app-b');
        const a1 = await openClient();
        const b1 = await openClient();
        const a2 = await openClient();
        const speakers: [ dgram.Socket, number, number[] ][] = [
            [ a1, A, someSamples(480, 10) ],
            [ b1, B, someSamples(480, 11) ],
            // The same app and voice id too, from another source port.
            [ a2, A, someSamples(480, 12) ],
        ];

        vi.useFakeTimers({ toFake: [ 'Date' ] });
        try {
            vi.setSystemTime(new Date('2026-10-09T11:07:58.502Z'));
            for (const [ socket, appId, samples ] of speakers) {
                const packet = pcmPacket(1, 0, samples, appId);
                internals.udpSocket.emit('message', packet, { ...socket.address(), size: packet.length });
            }
        } finally {
            vi.useRealTimers();
        }

        await server.stop();

        const expected = speakers.map(([ socket, appId, samples ]) =>
            [ `rec_2026-10-09T11_07_58.502Z_app_${appHex(appId)}_ID_1_port_${(socket.address() as AddressInfo).port}.wav`, samples ] as const);
        expect(await recordings()).toEqual(expected.map(([ name ]) => name).sort());
        for (const [ name, samples ] of expected) {
            expect(await readSamples(name)).toEqual(samples);
        }
        expect(savedLogs()).toHaveLength(3);
    });

    it('waits for a save the disconnect check started before it saves the rest', async () => {
        await talk(3, someSamples(480, 3));
        let release!: () => void;
        internals.savingRecordings = new Promise<void>(resolve => release = resolve);

        let stopped = false;
        const stopping = server.stop().then(() => stopped = true);
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(stopped).toBe(false);
        expect(await recordings()).toEqual([]);

        release();
        await stopping;
        expect(await recordings()).toHaveLength(1);
    });

    it('still saves when its socket has been closed already', async () => {
        await talk(4, someSamples(480, 4));
        internals.udpSocket.close();

        await server.stop();

        expect(await recordings()).toHaveLength(1);
    });

    it('saves a recording once, when its client goes quiet, and not again when it stops', async () => {
        const samples = someSamples(960, 5);
        await talk(5, samples);
        for (const client of internals.clients.values()) (client as { lastHeartbeat: number }).lastHeartbeat -= 5000;

        await internals.checkClientsDisconnected();
        const files = await recordings();
        expect(files).toHaveLength(1);
        expect(await readSamples(files[0]!)).toEqual(samples);

        await server.stop();
        expect(await recordings()).toEqual(files);
        expect(savedLogs()).toHaveLength(1);
    });

    it('saves the recording of a voice client dropped because its Unity client left, once', async () => {
        const samples = someSamples(960, 9);
        await talk(9, samples);
        unity.disconnectApp('voice-test');
        await new Promise(resolve => setImmediate(resolve));
        expect(internals.clients.size).toBe(0);

        await internals.checkClientsDisconnected();
        const files = await recordings();
        expect(files).toHaveLength(1);
        expect(await readSamples(files[0]!)).toEqual(samples);

        await server.stop();
        expect(await recordings()).toEqual(files);
        expect(savedLogs()).toHaveLength(1);
    });

    it('saves the recording of a voice client dropped because its Unity client left when it stops first', async () => {
        const samples = someSamples(480, 10);
        await talk(10, samples);
        unity.disconnectApp('voice-test');
        await new Promise(resolve => setImmediate(resolve));

        await server.stop();

        const files = await recordings();
        expect(files).toHaveLength(1);
        expect(await readSamples(files[0]!)).toEqual(samples);
    });

    it('logs a recording it cannot save, and saves the others', async () => {
        await talk(6, someSamples(480, 6));
        await talk(8, someSamples(480, 8));
        // A directory where client 6's file would go.
        const client6 = Array.from(internals.clients.values()).find(client => (client as { userId: number }).userId === 6) as { recordingStartDate: Date, appId: number, port: number };
        await mkdir(path.join(dir, `rec_${client6.recordingStartDate.toISOString().replace(/:/g, '_')}_app_${appHex(client6.appId)}_ID_6_port_${client6.port}.wav`));

        await server.stop();

        const failed = logs.filter(l => l.origin === 'VoiceServer' && l.level === LogLevel.Error);
        expect(failed).toHaveLength(1);
        expect(failed[0]!.message).toContain('Failed to save the voice recording of client ID 6 (127.0.0.1:');
        expect(failed[0]!.message).toContain('EISDIR');
        expect((await recordings()).filter(name => name.includes('_ID_8_'))).toHaveLength(1);
        expect(savedLogs()).toHaveLength(1);
    });

    // wavefile's fromScratch and toBuffer re-encoded every sample on the main thread: about
    // 1 to 4 s for a 10-minute recording, during which no TCP or Socket.IO message was relayed.
    it('saves a 10-minute recording without holding up the event loop', async () => {
        const samples = new Int16Array(SAMPLING_RATE * 600);
        for (let i = 0; i < samples.length; i++) samples[i] = (i * 31) % 20000 - 10000;
        internals.clients.set('127.0.0.1:9', {
            ip: '127.0.0.1', port: 9, userId: 9, appId: APP, lastSequence: 0, lastHeartbeat: Date.now(),
            frameSize: 480, frameSizeMillis: 10, codec: 0, recordingStartDate: new Date(),
            recordingData: { length: samples.length, toTypedArray: () => samples },
        });

        let longestGap = 0;
        let last = performance.now();
        const ticker = setInterval(() => {
            const now = performance.now();
            longestGap = Math.max(longestGap, now - last);
            last = now;
        }, 5);
        try {
            await server.stop();
        } finally {
            clearInterval(ticker);
        }
        longestGap = Math.max(longestGap, performance.now() - last);

        expect(longestGap).toBeLessThan(500);
        const files = await recordings();
        expect(files).toHaveLength(1);
        const bytes = await readFile(path.join(dir, files[0]!));
        expect(bytes.length).toBe(44 + samples.byteLength);
        expect(bytes.subarray(44).equals(Buffer.from(samples.buffer))).toBe(true);
    });
});

describe('wavHeader', () => {
    // The format the recordings had when wavefile wrote them, byte for byte.
    it.each([ 48000, 44100, 16000 ])('makes the same file as wavefile at %i Hz', (rate) => {
        const samples = new Int16Array([ 0, 1, -1, 32767, -32768, 1234, -4321 ]);
        const wav = new WaveFile();
        wav.fromScratch(1, rate, '16', samples);

        const ours = Buffer.concat([ wavHeader(rate, samples.byteLength), Buffer.from(samples.buffer) ]);

        expect(ours.equals(Buffer.from(wav.toBuffer()))).toBe(true);
    });

    it('makes the same header as wavefile for an empty recording', () => {
        const wav = new WaveFile();
        wav.fromScratch(1, 48000, '16', new Int16Array(0));

        expect(wavHeader(48000, 0).equals(Buffer.from(wav.toBuffer()))).toBe(true);
    });

    it('marks the sizes "up to the end of the file" past the 4 GiB they can hold, instead of throwing', () => {
        const header = wavHeader(48000, 5 * 1024 ** 3);

        expect(header.readUInt32LE(4)).toBe(0xFFFFFFFF);
        expect(header.readUInt32LE(40)).toBe(0xFFFFFFFF);
    });
});
