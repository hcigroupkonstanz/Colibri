import { afterEach, describe, expect, it } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { filter, timeout } from 'rxjs/operators';
import { createSingletonWithPeer, disconnectAll, nextMessage, uniqueApp } from './helpers';
import { RegisterSyncTransforms, SyncTransform } from '../src/SyncTransform';

afterEach(() => {
    disconnectAll();
});

// The raw peer stands in for colibri-unity: it sends what a SyncTransform component sends (see
// colibri-unity's SyncTransformTests.cs), on the channel the component syncs on.
describe('SyncTransform', () => {
    it('lists a Unity object with the state the server relays', async () => {
        const { peer } = await createSingletonWithPeer(uniqueApp('sync-transform-in'));
        const [transforms$] = RegisterSyncTransforms();

        const listed = firstValueFrom(
            transforms$.pipe(
                filter(transforms => transforms.some(t => t.id === 'cube')),
                timeout(5000)
            )
        );
        peer.sendMessage('synctransform', 'model::update', {
            id: 'cube',
            active: true,
            position: [1, 2, 3],
            rotation: [0, 0.7071, 0, 0.7071],
            scale: [2, 2, 2],
            physicsid: 'c0ffee'
        });

        const cube = (await listed).find(t => t.id === 'cube');
        expect(cube?.position).toEqual([1, 2, 3]);
        expect(cube?.rotation).toEqual([0, 0.7071, 0, 0.7071]);
        expect(cube?.scale).toEqual([2, 2, 2]);
    });

    it('moves a Unity object with a position alone', async () => {
        const { peer } = await createSingletonWithPeer(uniqueApp('sync-transform-move'));
        const [transforms$] = RegisterSyncTransforms('Cube');

        const listed = firstValueFrom(
            transforms$.pipe(
                filter(transforms => transforms.length > 0),
                timeout(5000)
            )
        );
        peer.sendMessage('synctransform_Cube', 'model::update', {
            id: 'cube',
            position: [1, 2, 3],
            physicsid: 'c0ffee'
        });
        const [cube] = await listed;

        const moved = nextMessage(peer, { channel: 'synctransform_Cube', command: 'model::update' });
        cube.position = [4, 5, 6];

        expect((await moved).payload).toEqual({ id: 'cube', position: [4, 5, 6] });
    });

    it('sends a transform registered on the web in full, as a Unity SyncTransformManager builds it', async () => {
        const { peer } = await createSingletonWithPeer(uniqueApp('sync-transform-out'));
        const [, registerTransform] = RegisterSyncTransforms();

        const sent = nextMessage(peer, { channel: 'synctransform', command: 'model::update' });
        const marker = new SyncTransform('marker');
        marker.position = [0, 1, 0];
        registerTransform(marker);

        expect((await sent).payload).toEqual({
            id: 'marker',
            active: true,
            position: [0, 1, 0],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
            physicsid: ''
        });
    });
});
