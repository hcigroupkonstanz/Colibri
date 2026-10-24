import type { TrustProxy } from '../net/trusted-proxies.js';
import { normalizeAddress } from '../net/addresses.js';
import type { UnityClientSource } from './unity-client-addresses.js';
import { UnityClientAddresses } from './unity-client-addresses.js';
import { formatAppId } from './format-app-id.js';

// What VoiceAdmission reads and writes of a voice client: its app, when it last sent a packet, and
// the group it counts against.
interface AdmittedVoiceClient<C> {
    readonly appId: number;
    readonly lastHeartbeat: number;
    group: VoiceClientGroup<C> | undefined;
}

// The voice clients of one app let in from one address (normalized). Each has the app's voice sent
// to that address once more, and anyone can add one by forging a source port there, so there are
// never more of them than Unity clients of the app connected from there (see admit).
export interface VoiceClientGroup<C> {
    readonly key: string;
    readonly address: string;
    readonly appId: number;
    readonly clients: Set<C>;
    // When a Unity client of its app last left its address and left fewer of them than voice
    // clients here, if the extra ones have not been dropped since (see onUnityClientsLeft).
    shrunkAt: number | undefined;
}

// Why a voice packet may be relayed: there is room for its sender among the voice clients of its
// app at its address, or its address is a trusted proxy's.
type Admission = 'unity' | 'proxy';

// What VoiceAdmission needs from the VoiceServer that owns it: dropping a voice client, and the
// reports of the packets it drops and of the trusted proxies it lets in.
interface VoiceAdmissionCallbacks<C> {
    dropVoiceClient(client: C, why: string): void;
    reportUncheckedProxy(address: string): void;
    reportNoUnityClient(source: string, address: string, appId: number, nowMillis: number): void;
    reportNoRoom(source: string, address: string, appId: number, unityClients: number, nowMillis: number): void;
}

const groupKey = (address: string, appId: number): string => `${address} ${appId}`;

// A voice client sends a packet every 20 ms while it broadcasts (VoiceBroadcast's default frame).
// One that has sent nothing for this long is taken to be gone when a new sender of its app at its
// address needs its place, as when a Unity client's voice socket is opened again, on a new port.
// Waiting for the 2 s disconnect timeout would cut that client's voice for 2 to 3 s. Taking the
// place of one still sending would let any forged packet take it, and two clients that both send
// would take it from each other at packet rate, cutting their recordings into 20 ms pieces.
// It is also how long after a Unity client leaves the voice clients over those left at its address
// are dropped (see onUnityClientsLeft).
const VOICE_CLIENT_GONE_MILLIS = 500;

// The voice client in `group` that has gone the longest without a packet.
const stalestOf = function <C extends AdmittedVoiceClient<C>>(group: VoiceClientGroup<C>): C | undefined {
    let stalest: C | undefined;
    for (const client of group.clients) {
        if (!stalest || client.lastHeartbeat < stalest.lastHeartbeat) stalest = client;
    }
    return stalest;
};

// The VoiceServer's check of which voice senders it relays, and the groups it counts them in. One
// for the server's lifetime: it drops the voice clients let in once their Unity clients leave.
export class VoiceAdmission<C extends AdmittedVoiceClient<C>> {
    // Where the Unity clients of each app are connected from: voice is relayed only from there.
    private readonly unityClients: UnityClientAddresses;
    // The voice clients let in for the Unity clients of each app at each address, by groupKey.
    private readonly groups = new Map<string, VoiceClientGroup<C>>();

    // `unityClients`: TCPServerProxy. `trustProxy`: TRUSTED_PROXIES, whose voice is relayed unchecked.
    public constructor(
        unityClients: UnityClientSource,
        private readonly trustProxy: TrustProxy,
        private readonly callbacks: VoiceAdmissionCallbacks<C>
    ) {
        this.unityClients = new UnityClientAddresses(unityClients);
        this.unityClients.left$.subscribe(({ address, appId }) => this.onUnityClientsLeft(address, appId));
    }

    // Whether a packet from `address` for the app `appId` may be relayed, and its sender be relayed
    // to. Anyone can compute an app's id from its name, and forge a packet's source address and
    // port. While every sender was let in, one forged packet every 2 s had this server stream an
    // app's voice to whatever address it named. Now a sender has to be at the address of a Unity
    // client of the app, which takes a TCP connection from there, and each such Unity client lets
    // in one voice client. Otherwise forged source ports at a participant's address would each have
    // the app's voice sent there once more: a thousand of them, a thousand copies of every packet.
    public admit(address: string, appId: number, source: string, nowMillis: number): Admission | undefined {
        // Behind a proxy every voice packet comes from the proxy's address, which says nothing
        // about who sent it: nothing can be checked, or counted, there. Asked first, so that a
        // Unity client on the proxy's machine does not have the voice of everyone behind the proxy
        // taken for its own, and dropped when it leaves.
        const normalized = normalizeAddress(address);
        if (this.trustProxy(address, 0)) {
            this.callbacks.reportUncheckedProxy(normalized);
            return 'proxy';
        }

        const unityClients = this.unityClients.count(normalized, appId);
        if (unityClients === 0) {
            this.callbacks.reportNoUnityClient(source, normalized, appId, nowMillis);
            return undefined;
        }

        const group = this.groups.get(groupKey(normalized, appId));
        if (group && group.clients.size >= unityClients && !this.dropGoneVoiceClient(group, source, nowMillis)) {
            this.callbacks.reportNoRoom(source, normalized, appId, unityClients, nowMillis);
            return undefined;
        }
        return 'unity';
    }

    // Makes room in `group` for `source` by dropping the voice client that has gone the longest
    // without a packet, if that is VOICE_CLIENT_GONE_MILLIS or more.
    private dropGoneVoiceClient(group: VoiceClientGroup<C>, source: string, nowMillis: number): boolean {
        const stalest = stalestOf(group);
        if (!stalest || nowMillis - stalest.lastHeartbeat < VOICE_CLIENT_GONE_MILLIS) return false;

        this.callbacks.dropVoiceClient(stalest, `no packet for ${nowMillis - stalest.lastHeartbeat} ms, and ${source} takes its place`);
        return true;
    }

    // A Unity client of the app `appId` has left `address`. With none left there, the voice clients
    // they let in stop receiving now rather than once they go quiet: one that kept sending, forged
    // packets included, would otherwise keep receiving the app's voice for as long as it liked.
    // With fewer left than voice clients, the extra ones are dropped VOICE_CLIENT_GONE_MILLIS later
    // (trimGroups), once the voice client of the one that left has gone quiet. Right now, the one
    // that has gone the longest without a packet may well be one still sending: a client that quits
    // closes its TCP connection and its voice socket at about the same time.
    private onUnityClientsLeft(address: string, appId: number): void {
        const group = this.groups.get(groupKey(address, appId));
        if (!group) return;

        const unityClients = this.unityClients.count(address, appId);
        if (unityClients > 0) {
            if (group.clients.size > unityClients) group.shrunkAt = Date.now();
            return;
        }
        // dropVoiceClient takes each out of the set: deleting the entry being visited is safe.
        for (const client of group.clients) {
            this.callbacks.dropVoiceClient(client, `no Unity client of app ${formatAppId(appId)} is connected from ${address} any more`);
        }
    }

    // Drops the voice clients each group has over the Unity clients of its app left at its address,
    // the one that has gone the longest without a packet first, VOICE_CLIENT_GONE_MILLIS after one
    // of those Unity clients left (see onUnityClientsLeft).
    public trimGroups(nowMillis: number): void {
        for (const group of this.groups.values()) {
            if (group.shrunkAt === undefined || nowMillis - group.shrunkAt < VOICE_CLIENT_GONE_MILLIS) continue;

            group.shrunkAt = undefined;
            const unityClients = this.unityClients.count(group.address, group.appId);
            while (group.clients.size > unityClients) {
                this.callbacks.dropVoiceClient(stalestOf(group)!,
                    `${group.address} has only ${unityClients} Unity client(s) of app ${formatAppId(group.appId)} left`);
            }
        }
    }

    // Counts `client` against the Unity clients of its app at `address` (see admit).
    public joinGroup(client: C, address: string): void {
        const normalized = normalizeAddress(address);
        const key = groupKey(normalized, client.appId);
        let group = this.groups.get(key);
        if (!group) {
            group = { key, address: normalized, appId: client.appId, clients: new Set(), shrunkAt: undefined };
            this.groups.set(key, group);
        }
        group.clients.add(client);
        client.group = group;
    }

    public leaveGroup(client: C): void {
        const group = client.group;
        if (!group) return;

        client.group = undefined;
        group.clients.delete(client);
        if (group.clients.size === 0) this.groups.delete(group.key);
    }

    // The server has stopped: its voice clients are gone.
    public clearGroups(): void {
        this.groups.clear();
    }
}
