import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Message } from '../src/Colibri';

vi.mock('../src/Colibri', () => ({
    SendMessage: vi.fn(),
    RegisterChannel: vi.fn(),
    UnregisterChannel: vi.fn()
}));

type SyncSender = (channel: string, value: unknown) => void;
type SyncReceiver = (channel: string, callback: (value: unknown) => void) => void;

let Sync: (typeof import('../src/Broadcasting'))['Sync'];
let toHexColor: (typeof import('../src/Broadcasting'))['toHexColor'];
let toRgbaColor: (typeof import('../src/Broadcasting'))['toRgbaColor'];
let sendMessage: Mock<(channel: string, command: string, payload?: unknown) => void>;
let registerChannel: Mock<(channel: string, handler: (payload: Message) => void) => void>;
let unregisterChannel: Mock<(channel: string, handler: (payload: Message) => void) => void>;

beforeEach(async () => {
    // Broadcasting.ts keeps a module-level `listeners` registry that must not
    // leak between tests, so force a fresh module (and a fresh Colibri mock)
    // on every run.
    vi.resetModules();
    const colibri = await import('../src/Colibri');
    sendMessage = colibri.SendMessage as unknown as Mock;
    registerChannel = colibri.RegisterChannel as unknown as Mock;
    unregisterChannel = colibri.UnregisterChannel as unknown as Mock;
    // vi.mock's factory result is cached across resetModules(), so the mock
    // functions themselves persist between tests - clear their call history
    // explicitly rather than relying on a fresh instance.
    sendMessage.mockClear();
    registerChannel.mockClear();
    unregisterChannel.mockClear();
    ({ Sync, toHexColor, toRgbaColor } = await import('../src/Broadcasting'));
});

describe('Sync senders', () => {
    it.each([
        ['sendBool', true, 'broadcast::bool'],
        ['sendBoolArray', [true, false], 'broadcast::bool[]'],
        ['sendNumber', 42, 'broadcast::float'],
        ['sendNumberArray', [1, 2, 3], 'broadcast::float[]'],
        ['sendString', 'hi', 'broadcast::string'],
        ['sendStringArray', ['a', 'b'], 'broadcast::string[]'],
        ['sendVector2', [1, 2], 'broadcast::vector2'],
        ['sendVector2Array', [[1, 2]], 'broadcast::vector2[]'],
        ['sendVector3', [1, 2, 3], 'broadcast::vector3'],
        ['sendVector3Array', [[1, 2, 3]], 'broadcast::vector3[]'],
        ['sendQuaternion', [0, 0, 0, 1], 'broadcast::quaternion'],
        ['sendQuaternionArray', [[0, 0, 0, 1]], 'broadcast::quaternion[]'],
        ['sendColor', [1, 0, 0, 1], 'broadcast::color'],
        ['sendColorArray', [[1, 0, 0, 1]], 'broadcast::color[]'],
        ['sendJson', { a: 1 }, 'broadcast::json']
    ] as const)('%s sends %s with the right command', (method, value, command) => {
        (Sync as unknown as Record<string, SyncSender>)[method]('ch', value);
        expect(sendMessage).toHaveBeenCalledWith('ch', command, value);
    });

    it('sendFloat and sendInt alias to sendNumber (broadcast::float)', () => {
        Sync.sendFloat('ch', 1.5);
        Sync.sendInt('ch', 2);
        expect(sendMessage).toHaveBeenNthCalledWith(1, 'ch', 'broadcast::float', 1.5);
        expect(sendMessage).toHaveBeenNthCalledWith(2, 'ch', 'broadcast::float', 2);
    });

    it('sendFloatArray and sendIntArray alias to sendNumberArray (broadcast::float[])', () => {
        Sync.sendFloatArray('ch', [1.5, 2.5]);
        Sync.sendIntArray('ch', [1, 2]);
        expect(sendMessage).toHaveBeenNthCalledWith(1, 'ch', 'broadcast::float[]', [1.5, 2.5]);
        expect(sendMessage).toHaveBeenNthCalledWith(2, 'ch', 'broadcast::float[]', [1, 2]);
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
        ['receiveVector2', 'broadcast::vector2', [1, 2]],
        ['receiveVector2Array', 'broadcast::vector2[]', [[1, 2]]],
        ['receiveVector3', 'broadcast::vector3', [1, 2, 3]],
        ['receiveVector3Array', 'broadcast::vector3[]', [[1, 2, 3]]],
        ['receiveQuaternion', 'broadcast::quaternion', [0, 0, 0, 1]],
        ['receiveQuaternionArray', 'broadcast::quaternion[]', [[0, 0, 0, 1]]],
        ['receiveColor', 'broadcast::color', '#ff0000'],
        ['receiveColorArray', 'broadcast::color[]', ['#ff0000']],
        ['receiveJson', 'broadcast::json', { a: 1 }]
    ] as const)('%s dispatches inbound %s payloads to its callback', (method, command, payload) => {
        const cb = vi.fn();

        (Sync as unknown as Record<string, SyncReceiver>)[method]('ch', cb);

        const handler = registerChannel.mock.calls[0][1];
        handler({ channel: 'ch', command, payload });

        expect(cb).toHaveBeenCalledWith(payload);
    });

    it.each([
        ['receiveNumber', 'broadcast::int', 42],
        ['receiveNumberArray', 'broadcast::int[]', [1, 2, 3]]
    ] as const)('%s also accepts %s, which is how Unity tags integers', (method, command, payload) => {
        const cb = vi.fn();

        (Sync as unknown as Record<string, SyncReceiver>)[method]('ch', cb);

        const handler = registerChannel.mock.calls[0][1];
        handler({ channel: 'ch', command, payload });

        expect(cb).toHaveBeenCalledWith(payload);
    });

    it('delivers an integer to a number listener exactly once, not once per command it listens for', () => {
        const cb = vi.fn();
        Sync.receiveNumber('ch', cb);

        const handler = registerChannel.mock.calls[0][1];
        handler({ channel: 'ch', command: 'broadcast::int', payload: 7 });

        expect(cb).toHaveBeenCalledTimes(1);
    });

    it('unregister removes a number listener from both the float and the int command', () => {
        const cb = vi.fn();
        Sync.receiveNumber('ch', cb);
        Sync.unregister('ch', cb);

        const handler = registerChannel.mock.calls[0][1];
        handler({ channel: 'ch', command: 'broadcast::float', payload: 1 });
        handler({ channel: 'ch', command: 'broadcast::int', payload: 2 });

        expect(cb).not.toHaveBeenCalled();
    });

    // colibri-unity sends "#RRGGBBAA", colibri-web sends [r,g,b,a], and both reach the same
    // callback - so receiveColor has to hand over whichever arrived rather than declaring one.
    it.each([
        ['a Unity peer', '#ff0000ff'],
        ['a colibri-web peer', [1, 0, 0, 1]]
    ] as const)('receiveColor delivers the colour %s sent, verbatim', (_peer, payload) => {
        const cb = vi.fn();
        Sync.receiveColor('ch', cb);

        const handler = registerChannel.mock.calls[0][1];
        handler({ channel: 'ch', command: 'broadcast::color', payload });

        expect(cb).toHaveBeenCalledWith(payload);
    });

    it('receiveColorArray delivers a mix of both colour forms verbatim', () => {
        const cb = vi.fn();
        Sync.receiveColorArray('ch', cb);

        const payload = ['#ff0000ff', [0, 1, 0, 1]];
        const handler = registerChannel.mock.calls[0][1];
        handler({ channel: 'ch', command: 'broadcast::color[]', payload });

        expect(cb).toHaveBeenCalledWith(payload);
    });

    it('registers exactly one channel listener no matter how many types are received on it', () => {
        Sync.receiveBool('ch', () => undefined);
        Sync.receiveNumber('ch', () => undefined);
        Sync.receiveString('ch', () => undefined);

        expect(registerChannel).toHaveBeenCalledTimes(1);
        expect(registerChannel).toHaveBeenCalledWith('ch', expect.any(Function));
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

    it('does not unsubscribe the channel while other listeners remain', () => {
        const cb1 = vi.fn();
        const cb2 = vi.fn();
        Sync.receiveString('ch', cb1);
        Sync.receiveString('ch', cb2);
        Sync.unregister('ch', cb1);

        expect(unregisterChannel).not.toHaveBeenCalled();
    });

    it('unsubscribes the channel once its last listener is removed', () => {
        const cb = vi.fn();
        Sync.receiveString('ch', cb);
        const handler = registerChannel.mock.calls[0][1];

        Sync.unregister('ch', cb);

        expect(unregisterChannel).toHaveBeenCalledWith('ch', handler);
    });

    it('resubscribes with a fresh handler after the channel was fully unregistered', () => {
        const cb1 = vi.fn();
        Sync.receiveString('ch', cb1);
        Sync.unregister('ch', cb1);

        const cb2 = vi.fn();
        Sync.receiveString('ch', cb2);

        expect(registerChannel).toHaveBeenCalledTimes(2);
        const handler = registerChannel.mock.calls[1][1];
        handler({ channel: 'ch', command: 'broadcast::string', payload: 'hi' });
        expect(cb2).toHaveBeenCalledWith('hi');
    });
});

describe('colour normalization', () => {
    it.each([
        // The four forms Unity's ColorUtility.TryParseHtmlString accepts, so anything a Unity
        // client can put on the wire has to come back as a colour here.
        ['#f00', [1, 0, 0, 1]],
        ['#f00f', [1, 0, 0, 1]],
        ['#ff0000', [1, 0, 0, 1]],
        ['#ff0000ff', [1, 0, 0, 1]],
        ['#00ff0080', [0, 1, 0, 128 / 255]],
        // Unprefixed, which is what a hand-written payload tends to look like.
        ['ff0000', [1, 0, 0, 1]]
    ] as const)('toRgbaColor reads %s as an [r,g,b,a]', (hex, expected) => {
        expect(toRgbaColor(hex)).toEqual(expected);
    });

    it('toRgbaColor passes an [r,g,b,a] through, clamped', () => {
        expect(toRgbaColor([0.25, 0.5, 0.75, 1])).toEqual([0.25, 0.5, 0.75, 1]);
        expect(toRgbaColor([2, -1, 0.5, 1])).toEqual([1, 0, 0.5, 1]);
    });

    it('toRgbaColor defaults a missing alpha to opaque', () => {
        expect(toRgbaColor([1, 0, 0] as unknown as [number, number, number, number])).toEqual([1, 0, 0, 1]);
    });

    it('toHexColor renders both forms as #RRGGBBAA', () => {
        expect(toHexColor([1, 0, 0, 1])).toBe('#ff0000ff');
        // Shorthand and RGB-only strings are normalized rather than passed through, so a caller
        // can rely on the result always being 9 characters.
        expect(toHexColor('#f00')).toBe('#ff0000ff');
        expect(toHexColor('#ff0000')).toBe('#ff0000ff');
    });

    it.each([['#ff0000ff'], ['#00ff00ff'], ['#0000ffff']])('%s survives a hex -> rgba -> hex round trip', hex => {
        expect(toHexColor(toRgbaColor(hex))).toBe(hex);
    });

    it('an [r,g,b,a] survives an rgba -> hex -> rgba round trip', () => {
        const rgba: [number, number, number, number] = [1, 0, 0.5, 0];
        const returned = toRgbaColor(toHexColor(rgba));
        expect(returned[0]).toBeCloseTo(rgba[0], 2);
        expect(returned[1]).toBeCloseTo(rgba[1], 2);
        expect(returned[2]).toBeCloseTo(rgba[2], 2);
        expect(returned[3]).toBeCloseTo(rgba[3], 2);
    });

    it.each([
        ['not a colour'],
        ['#gg0000'],
        ['#ff00000'],
        [[1, 0] as unknown as [number, number, number, number]],
        [['a', 'b', 'c'] as unknown as [number, number, number, number]]
    ])('warns and falls back to opaque black for %s instead of throwing', bad => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        expect(toRgbaColor(bad)).toEqual([0, 0, 0, 1]);
        expect(toHexColor(bad)).toBe('#000000ff');
        expect(warn).toHaveBeenCalled();

        warn.mockRestore();
    });
});
