import * as net from 'net';
import { Observable, Subject } from 'rxjs';
import { voiceAppId } from './voice-packet.js';

// A Unity (TCP) client as the voice server needs to know it. TCPServerProxy's clients are these.
export interface UnityClient {
    readonly app: string;
    // Behind a proxy, the one its PROXY protocol header named.
    readonly address: string;
}

// TCPServerProxy, as far as the voice server is concerned.
export interface UnityClientSource {
    readonly currentClients: ReadonlyArray<UnityClient>;
    readonly clientConnected$: Observable<UnityClient>;
    readonly clientDisconnected$: Observable<UnityClient>;
}

// An app, and an address one of its Unity clients there has left.
export interface UnityClientLeft {
    address: string;
    appId: number;
}

const IPV4_MAPPED_PREFIX = '::ffff:';

/**
 * `address` without the `::ffff:` of an IPv4-mapped IPv6 address. A dual-stack TCP socket reports an
 * IPv4 client as `::ffff:192.0.2.1`, the IPv4-only voice socket as `192.0.2.1`.
 */
export const normalizeAddress = function (address: string): string {
    if (address.length <= IPV4_MAPPED_PREFIX.length || address.slice(0, IPV4_MAPPED_PREFIX.length).toLowerCase() !== IPV4_MAPPED_PREFIX) {
        return address;
    }
    const ipv4 = address.slice(IPV4_MAPPED_PREFIX.length);
    return net.isIPv4(ipv4) ? ipv4 : address;
};

/**
 * The addresses the Unity clients of each app are connected from, by voice app id. Voice is relayed
 * only from these (see VoiceServer.admit): a UDP source address is all a voice packet can be checked
 * by, and anyone can compute an app's id from its name.
 */
export class UnityClientAddresses {
    // Address (see normalizeAddress) -> app id -> how many Unity clients of that app are connected
    // from it. Two lookups per check, however many clients there are: the voice server checks every
    // packet from a sender it has not let in yet, which a flood of forged ones makes thousands a second.
    private readonly apps = new Map<string, Map<number, number>>();
    private readonly leftStream = new Subject<UnityClientLeft>();

    public constructor(source: UnityClientSource) {
        for (const client of source.currentClients) this.add(client);
        source.clientConnected$.subscribe(client => this.add(client));
        source.clientDisconnected$.subscribe(client => this.remove(client));
    }

    // Each time a Unity client of an app leaves an address, unless another is back in its place at
    // once (see remove). count() then says how many are left there.
    public get left$(): Observable<UnityClientLeft> {
        return this.leftStream.asObservable();
    }

    // Whether a Unity client of the app `appId` is connected from `address`, normalized.
    public has(address: string, appId: number): boolean {
        return this.apps.get(address)?.has(appId) === true;
    }

    // How many Unity clients of the app `appId` are connected from `address`, normalized.
    public count(address: string, appId: number): number {
        return this.apps.get(address)?.get(appId) ?? 0;
    }

    private add(client: UnityClient): void {
        const address = normalizeAddress(client.address);
        const appId = voiceAppId(client.app);
        let counts = this.apps.get(address);
        if (!counts) {
            counts = new Map();
            this.apps.set(address, counts);
        }
        counts.set(appId, (counts.get(appId) ?? 0) + 1);
    }

    private remove(client: UnityClient): void {
        const address = normalizeAddress(client.address);
        const appId = voiceAppId(client.app);
        const counts = this.apps.get(address);
        const count = counts?.get(appId);
        if (!counts || count === undefined) return;

        const left = count - 1;
        if (left > 0) {
            counts.set(appId, left);
        } else {
            counts.delete(appId);
            if (counts.size === 0) this.apps.delete(address);
        }

        // A client that handshakes again on its connection is reported gone and then connected,
        // one right after the other (TCPServerProxy.onClientConnected). Told once that is over, and
        // only if fewer are left then, so that one staying in its app does not lose its voice, nor
        // have its recording cut in two. A microtask still runs before the next voice packet is
        // handled.
        queueMicrotask(() => {
            if (this.count(address, appId) <= left) this.leftStream.next({ address, appId });
        });
    }
}
