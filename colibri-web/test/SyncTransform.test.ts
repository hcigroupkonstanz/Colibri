import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Observable } from 'rxjs';

// The Colibri wire layer, mocked as in ModelSynchronization.test.ts: SendMessage and RegisterChannel
// come back as vi.fn() mocks, and there always is an instance to send through.
vi.mock('../src/Colibri', () => {
    const SendMessage = vi.fn();
    return {
        SendMessage,
        RegisterChannel: vi.fn(),
        Colibri: { getInstance: () => ({ sendMessage: SendMessage }) }
    };
});

import { SendMessage, RegisterChannel } from '../src/Colibri';
import type { Message } from '../src/Colibri';
import { RegisterSyncTransforms, SyncTransform } from '../src/SyncTransform';

const sendMessageMock = SendMessage as unknown as Mock<(channel: string, command: string, payload?: unknown) => void>;
const registerChannelMock = RegisterChannel as unknown as Mock<
    (channel: string, handler: (payload: Message) => void) => void
>;

function capturedHandler(): (payload: Message) => void {
    return registerChannelMock.mock.calls[0][1];
}

function latest<T>(obs: Observable<T[]>): T[] {
    let value: T[] = [];
    obs.subscribe(v => {
        value = v;
    }).unsubscribe();
    return value;
}

describe('SyncTransform', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        warnSpy.mockRestore();
        vi.useRealTimers();
    });

    // colibri-unity's SyncTransform syncs on its class name in lower case, followed by _<ModelId>
    // when the component has one, which keeps its case.
    it('syncs on the channel colibri-unity uses', () => {
        RegisterSyncTransforms();
        RegisterSyncTransforms('Cube');

        expect(registerChannelMock.mock.calls.map(([channel]) => channel)).toEqual([
            'synctransform',
            'colibri::reconnect',
            'synctransform_Cube',
            'colibri::reconnect'
        ]);
    });

    // The names colibri-unity's [Sync] members go out under, and its placeholders' values.
    it('sends the members under the names colibri-unity uses', () => {
        expect(new SyncTransform('t').toJson()).toEqual({
            id: 't',
            active: true,
            position: [0, 0, 0],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
            physicsid: ''
        });
    });

    // The full state of a Unity object, as colibri-unity sends it (see SyncTransformTests.cs).
    it('lists a Unity object with its state, without warning about any member', () => {
        const [transforms$] = RegisterSyncTransforms();

        capturedHandler()({
            channel: 'synctransform',
            command: 'model::update',
            payload: {
                id: 'cube',
                active: false,
                position: [1, 2, 3],
                rotation: [0, 0.7071, 0, 0.7071],
                scale: [2, 2, 2],
                physicsid: 'c0ffee'
            }
        });

        const [cube] = latest(transforms$);
        expect(cube).toBeInstanceOf(SyncTransform);
        expect(cube.id).toBe('cube');
        expect(cube.active).toBe(false);
        expect(cube.position).toEqual([1, 2, 3]);
        expect(cube.rotation).toEqual([0, 0.7071, 0, 0.7071]);
        expect(cube.scale).toEqual([2, 2, 2]);
        expect(cube.physicsId).toBe('c0ffee');
        expect(warnSpy).not.toHaveBeenCalled();
    });

    // A Unity object with a Sync box unticked never sends that member.
    it('keeps the defaults of the members a Unity object does not send', () => {
        const [transforms$] = RegisterSyncTransforms();

        capturedHandler()({
            channel: 'synctransform',
            command: 'model::update',
            payload: { id: 'position-only', position: [4, 5, 6] }
        });

        const [transform] = latest(transforms$);
        expect(transform.position).toEqual([4, 5, 6]);
        expect(transform.active).toBe(true);
        expect(transform.rotation).toEqual([0, 0, 0, 1]);
        expect(transform.scale).toEqual([1, 1, 1]);
    });

    // Moving a Unity object from the web sends the position alone: never physicsid, which would take
    // the physics authority away from the Unity client that has it.
    it('sends only the position when a Unity object is moved', async () => {
        vi.useFakeTimers();
        const [transforms$] = RegisterSyncTransforms();
        capturedHandler()({
            channel: 'synctransform',
            command: 'model::update',
            payload: { id: 'cube', position: [1, 2, 3], physicsid: 'c0ffee' }
        });
        sendMessageMock.mockClear();

        latest(transforms$)[0].position = [7, 8, 9];
        await vi.advanceTimersByTimeAsync(1);

        const updates = sendMessageMock.mock.calls.filter(([, command]) => command === 'model::update');
        expect(updates).toEqual([['synctransform', 'model::update', { id: 'cube', position: [7, 8, 9] }]]);
    });
});
