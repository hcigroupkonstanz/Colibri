import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Message } from '../src/Colibri';

vi.mock('../src/Colibri', () => ({
    SendMessage: vi.fn(),
    RegisterChannel: vi.fn()
}));

type SyncSender = (channel: string, value: unknown) => void;
type SyncReceiver = (channel: string, callback: (value: unknown) => void) => void;

let Sync: (typeof import('../src/Broadcasting'))['Sync'];
let sendMessage: Mock<
    (channel: string, command: string, payload?: unknown) => void
>;
let registerChannel: Mock<
    (channel: string, handler: (payload: Message) => void) => void
>;

beforeEach(async () => {
    // Broadcasting.ts keeps a module-level `listeners` registry that must not
    // leak between tests, so force a fresh module (and a fresh Colibri mock)
    // on every run.
    vi.resetModules();
    const colibri = await import('../src/Colibri');
    sendMessage = colibri.SendMessage as unknown as Mock;
    registerChannel = colibri.RegisterChannel as unknown as Mock;
    // vi.mock's factory result is cached across resetModules(), so the mock
    // functions themselves persist between tests - clear their call history
    // explicitly rather than relying on a fresh instance.
    sendMessage.mockClear();
    registerChannel.mockClear();
    ({ Sync } = await import('../src/Broadcasting'));
});

describe('Sync senders', () => {
    it.each([
        ['sendBool', true, 'broadcast::bool'],
        ['sendBoolArray', [true, false], 'broadcast::bool[]'],
        ['sendNumber', 42, 'broadcast::float'],
        ['sendNumberArray', [1, 2, 3], 'broadcast::float[]'],
        ['sendString', 'hi', 'broadcast::string'],
        ['sendStringArray', ['a', 'b'], 'broadcast::string[]'],
        ['sendVector3', [1, 2, 3], 'broadcast::vector3'],
        ['sendVector3Array', [[1, 2, 3]], 'broadcast::vector3[]'],
        ['sendQuaternion', [0, 0, 0, 1], 'broadcast::quaternion'],
        ['sendQuaternionArray', [[0, 0, 0, 1]], 'broadcast::quaternion[]'],
        ['sendColor', [1, 0, 0, 1], 'broadcast::color'],
        ['sendColorArray', [[1, 0, 0, 1]], 'broadcast::color[]'],
        ['sendJson', { a: 1 }, 'broadcast::json']
    ] as const)(
        '%s sends %s with the right command',
        (method, value, command) => {
            (Sync as unknown as Record<string, SyncSender>)[method](
                'ch',
                value
            );
            expect(sendMessage).toHaveBeenCalledWith('ch', command, value);
        }
    );

    it('sendFloat and sendInt alias to sendNumber (broadcast::float)', () => {
        Sync.sendFloat('ch', 1.5);
        Sync.sendInt('ch', 2);
        expect(sendMessage).toHaveBeenNthCalledWith(
            1,
            'ch',
            'broadcast::float',
            1.5
        );
        expect(sendMessage).toHaveBeenNthCalledWith(
            2,
            'ch',
            'broadcast::float',
            2
        );
    });

    it('sendFloatArray and sendIntArray alias to sendNumberArray (broadcast::float[])', () => {
        Sync.sendFloatArray('ch', [1.5, 2.5]);
        Sync.sendIntArray('ch', [1, 2]);
        expect(sendMessage).toHaveBeenNthCalledWith(
            1,
            'ch',
            'broadcast::float[]',
            [1.5, 2.5]
        );
        expect(sendMessage).toHaveBeenNthCalledWith(
            2,
            'ch',
            'broadcast::float[]',
            [1, 2]
        );
    });
});

describe('Sync receivers', () => {
    it.each([
        ['receiveBool', 'broadcast::bool', true],
        ['receiveBoolArray', 'broadcast::bool[]', [true, false]],
        ['receiveNumber', 'broadcast::float', 42],
        ['receiveNumberArray', 'broadcast::float[]', [1, 2, 3]],
        ['receiveString', 'broadcast::string', 'hi'],
        ['receiveStringArray', 'broadcast::string[]', ['a', 'b']],
        ['receiveVector3', 'broadcast::vector3', [1, 2, 3]],
        ['receiveVector3Array', 'broadcast::vector3[]', [[1, 2, 3]]],
        ['receiveQuaternion', 'broadcast::quaternion', [0, 0, 0, 1]],
        ['receiveQuaternionArray', 'broadcast::quaternion[]', [[0, 0, 0, 1]]],
        ['receiveColor', 'broadcast::color', '#ff0000'],
        ['receiveColorArray', 'broadcast::color[]', ['#ff0000']],
        ['receiveJson', 'broadcast::json', { a: 1 }]
    ] as const)(
        '%s dispatches inbound %s payloads to its callback',
        (method, command, payload) => {
            const cb = vi.fn();

            (Sync as unknown as Record<string, SyncReceiver>)[method](
                'ch',
                cb
            );

            const handler = registerChannel.mock.calls[0][1];
            handler({ channel: 'ch', command, payload });

            expect(cb).toHaveBeenCalledWith(payload);
        }
    );

    it('registers exactly one channel listener no matter how many types are received on it', () => {
        Sync.receiveBool('ch', () => undefined);
        Sync.receiveNumber('ch', () => undefined);
        Sync.receiveString('ch', () => undefined);

        expect(registerChannel).toHaveBeenCalledTimes(1);
        expect(registerChannel).toHaveBeenCalledWith(
            'ch',
            expect.any(Function)
        );
    });

    it('dispatches inbound messages only to callbacks matching the command', () => {
        const boolCb = vi.fn();
        const numberCb = vi.fn();
        Sync.receiveBool('ch', boolCb);
        Sync.receiveNumber('ch', numberCb);

        const handler = registerChannel.mock.calls[0][1];
        handler({ channel: 'ch', command: 'broadcast::bool', payload: true });

        expect(boolCb).toHaveBeenCalledWith(true);
        expect(numberCb).not.toHaveBeenCalled();
    });

    it('fires every callback registered for the same channel and command', () => {
        const cb1 = vi.fn();
        const cb2 = vi.fn();
        Sync.receiveString('ch', cb1);
        Sync.receiveString('ch', cb2);

        const handler = registerChannel.mock.calls[0][1];
        handler({ channel: 'ch', command: 'broadcast::string', payload: 'hi' });

        expect(cb1).toHaveBeenCalledWith('hi');
        expect(cb2).toHaveBeenCalledWith('hi');
    });

    it('ignores messages for channels/commands with no registered callback', () => {
        const cb = vi.fn();
        Sync.receiveString('ch', cb);

        const handler = registerChannel.mock.calls[0][1];
        handler({
            channel: 'ch',
            command: 'broadcast::json',
            payload: { a: 1 }
        });

        expect(cb).not.toHaveBeenCalled();
    });

    it('unregister removes a callback without affecting other callbacks on the same command', () => {
        const cb1 = vi.fn();
        const cb2 = vi.fn();
        Sync.receiveString('ch', cb1);
        Sync.receiveString('ch', cb2);
        Sync.unregister('ch', cb1);

        const handler = registerChannel.mock.calls[0][1];
        handler({ channel: 'ch', command: 'broadcast::string', payload: 'hi' });

        expect(cb1).not.toHaveBeenCalled();
        expect(cb2).toHaveBeenCalledWith('hi');
    });
});
