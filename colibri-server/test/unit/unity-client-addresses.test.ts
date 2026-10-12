import { describe, it, expect } from 'vitest';
import { Subject } from 'rxjs';
import { UnityClient, UnityClientAddresses, UnityClientLeft, normalizeAddress } from '../../src/server/modules/web/unity-client-addresses.js';
import { voiceAppId } from '../../src/server/modules/web/voice-packet.js';

const LAB = voiceAppId('lab');
const OTHER = voiceAppId('other');

describe('normalizeAddress', () => {
    it.each([
        [ '::ffff:192.0.2.1', '192.0.2.1' ],
        [ '::FFFF:192.0.2.1', '192.0.2.1' ],
        [ '192.0.2.1', '192.0.2.1' ],
        [ '::1', '::1' ],
        [ '2001:db8::1', '2001:db8::1' ],
        // Not an IPv4 address after the prefix.
        [ '::ffff:c000:201', '::ffff:c000:201' ],
        [ '::ffff:', '::ffff:' ],
        [ '', '' ],
    ])('turns "%s" into "%s"', (address, normalized) => {
        expect(normalizeAddress(address)).toBe(normalized);
    });
});

describe('UnityClientAddresses', () => {
    const create = (current: UnityClient[] = []) => {
        const connected = new Subject<UnityClient>();
        const disconnected = new Subject<UnityClient>();
        const addresses = new UnityClientAddresses({
            currentClients: current,
            clientConnected$: connected.asObservable(),
            clientDisconnected$: disconnected.asObservable(),
        });
        const left: UnityClientLeft[] = [];
        addresses.left$.subscribe(entry => left.push(entry));
        return { addresses, connected, disconnected, left };
    };

    const settled = () => new Promise<void>(resolve => setImmediate(resolve));

    it('knows the clients connected before it, and those connecting after', () => {
        const { addresses, connected } = create([ { app: 'lab', address: '192.0.2.1' } ]);
        connected.next({ app: 'other', address: '::ffff:192.0.2.2' });

        expect(addresses.has('192.0.2.1', LAB)).toBe(true);
        expect(addresses.has('192.0.2.2', OTHER)).toBe(true);
        expect(addresses.has('192.0.2.1', OTHER)).toBe(false);
        expect(addresses.has('192.0.2.2', LAB)).toBe(false);
        expect(addresses.has('192.0.2.3', LAB)).toBe(false);
    });

    it('counts the clients of each app at each address', () => {
        const { addresses, connected, disconnected } = create([ { app: 'lab', address: '192.0.2.1' } ]);
        const second = { app: 'lab', address: '::ffff:192.0.2.1' };
        connected.next(second);
        connected.next({ app: 'other', address: '192.0.2.1' });

        expect(addresses.count('192.0.2.1', LAB)).toBe(2);
        expect(addresses.count('192.0.2.1', OTHER)).toBe(1);
        expect(addresses.count('192.0.2.2', LAB)).toBe(0);

        disconnected.next(second);
        expect(addresses.count('192.0.2.1', LAB)).toBe(1);
    });

    it('says each time a client of an app leaves an address, once it has been counted out', async () => {
        const { addresses, connected, disconnected, left } = create();
        const first = { app: 'lab', address: '192.0.2.1' };
        const second = { app: 'lab', address: '::ffff:192.0.2.1' };
        connected.next(first);
        connected.next(second);

        disconnected.next(first);
        expect(left).toEqual([]);
        await settled();
        expect(addresses.count('192.0.2.1', LAB)).toBe(1);
        expect(left).toEqual([ { address: '192.0.2.1', appId: LAB } ]);

        disconnected.next(second);
        expect(addresses.has('192.0.2.1', LAB)).toBe(false);
        await settled();
        expect(left).toEqual([ { address: '192.0.2.1', appId: LAB }, { address: '192.0.2.1', appId: LAB } ]);
    });

    // TCPServerProxy reports a second handshake on a connection as the client leaving, then connecting.
    it('says nothing for a client that leaves and is back in its app in one go', async () => {
        const { addresses, connected, disconnected, left } = create();
        const client = { app: 'lab', address: '192.0.2.1' };
        const other = { app: 'lab', address: '192.0.2.1' };
        connected.next(client);
        connected.next(other);

        disconnected.next(client);
        connected.next({ ...client });
        await settled();

        expect(addresses.count('192.0.2.1', LAB)).toBe(2);
        expect(left).toEqual([]);
    });

    it('ignores a client that leaves without having been reported connected', async () => {
        const { addresses, connected, disconnected, left } = create();
        connected.next({ app: 'lab', address: '192.0.2.1' });

        disconnected.next({ app: 'lab', address: '192.0.2.9' });
        disconnected.next({ app: 'other', address: '192.0.2.1' });
        await settled();

        expect(addresses.has('192.0.2.1', LAB)).toBe(true);
        expect(left).toEqual([]);
    });
});
