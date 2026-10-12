import { RegisterChannel, SendMessage, UnregisterChannel } from './Colibri';

/**
 * A colour on the wire, in either of the two forms Colibri clients put there.
 *
 * colibri-web writes `[r, g, b, a]` with each component 0-1; colibri-unity writes the HTML
 * string Unity's `ColorUtility.ToHtmlStringRGBA` produces (`"#RRGGBBAA"`). Both are accepted
 * everywhere a colour is received - the same tolerance colibri-unity's `JsonExtensions.ToColor`
 * has - so a colour keeps its meaning whichever kind of peer sent it. Use {@link toHexColor} or
 * {@link toRgbaColor} to get the one shape your code wants.
 */
export type ColorValue = string | [number, number, number, number];

const sendBool = (channel: string, val: boolean) => {
    SendMessage(channel, 'broadcast::bool', val);
};

const sendBoolArray = (channel: string, val: boolean[]) => {
    SendMessage(channel, 'broadcast::bool[]', val);
};

const sendNumber = (channel: string, val: number) => {
    SendMessage(channel, 'broadcast::float', val);
};

const sendNumberArray = (channel: string, val: number[]) => {
    SendMessage(channel, 'broadcast::float[]', val);
};

const sendString = (channel: string, val: string) => {
    SendMessage(channel, 'broadcast::string', val);
};

const sendStringArray = (channel: string, val: string[]) => {
    SendMessage(channel, 'broadcast::string[]', val);
};

const sendVector2 = (channel: string, val: [number, number]) => {
    SendMessage(channel, 'broadcast::vector2', val);
};

const sendVector2Array = (channel: string, val: [number, number][]) => {
    SendMessage(channel, 'broadcast::vector2[]', val);
};

const sendVector3 = (channel: string, val: [number, number, number]) => {
    SendMessage(channel, 'broadcast::vector3', val);
};

const sendVector3Array = (channel: string, val: [number, number, number][]) => {
    SendMessage(channel, 'broadcast::vector3[]', val);
};

const sendQuaternion = (channel: string, val: [number, number, number, number]) => {
    SendMessage(channel, 'broadcast::quaternion', val);
};

const sendQuaternionArray = (channel: string, val: [number, number, number, number][]) => {
    SendMessage(channel, 'broadcast::quaternion[]', val);
};

const sendColor = (channel: string, val: ColorValue) => {
    SendMessage(channel, 'broadcast::color', val);
};

const sendColorArray = (channel: string, val: ColorValue[]) => {
    SendMessage(channel, 'broadcast::color[]', val);
};

const sendJson = (channel: string, val: { [key: string]: unknown }) => {
    SendMessage(channel, 'broadcast::json', val);
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type genericCallback = (val: any) => void;
const listeners: Partial<Record<string, Partial<Record<string, genericCallback[]>>>> = {};
const channelHandlers: Partial<Record<string, Parameters<typeof RegisterChannel>[1]>> = {};

// NOTE: T lets each call site pin the concrete payload type its callback expects
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
const registerListener = <T>(channel: string, type: string, callback: (val: T) => void) => {
    let channelListeners = listeners[channel];
    if (channelListeners === undefined) {
        const newChannelListeners: Partial<Record<string, genericCallback[]>> = {};
        channelListeners = newChannelListeners;
        listeners[channel] = newChannelListeners;
        const handler: Parameters<typeof RegisterChannel>[1] = msg => {
            const commandListeners = newChannelListeners[msg.command];
            if (commandListeners !== undefined) {
                commandListeners.forEach(cb => {
                    cb(msg.payload);
                });
            }
        };
        channelHandlers[channel] = handler;
        RegisterChannel(channel, handler);
    }

    let typeListeners = channelListeners[type];
    if (typeListeners === undefined) {
        typeListeners = [];
        channelListeners[type] = typeListeners;
    }

    typeListeners.push(callback);
};

const receiveBool = (channel: string, callback: (val: boolean) => void) => {
    registerListener<boolean>(channel, 'broadcast::bool', callback);
};

const receiveBoolArray = (channel: string, callback: (val: boolean[]) => void) => {
    registerListener<boolean[]>(channel, 'broadcast::bool[]', callback);
};

// JavaScript has one number type, but Unity distinguishes int from float and tags the
// message accordingly, so `Sync.Send(channel, 5)` in Unity arrives as broadcast::int.
// Listening for only broadcast::float silently dropped every integer a Unity client sent.
const receiveNumber = (channel: string, callback: (val: number) => void) => {
    registerListener<number>(channel, 'broadcast::float', callback);
    registerListener<number>(channel, 'broadcast::int', callback);
};

const receiveNumberArray = (channel: string, callback: (val: number[]) => void) => {
    registerListener<number[]>(channel, 'broadcast::float[]', callback);
    registerListener<number[]>(channel, 'broadcast::int[]', callback);
};

const receiveString = (channel: string, callback: (val: string) => void) => {
    registerListener<string>(channel, 'broadcast::string', callback);
};

const receiveStringArray = (channel: string, callback: (val: string[]) => void) => {
    registerListener<string[]>(channel, 'broadcast::string[]', callback);
};

const receiveVector2 = (channel: string, callback: (val: [number, number]) => void) => {
    registerListener<[number, number]>(channel, 'broadcast::vector2', callback);
};

const receiveVector2Array = (channel: string, callback: (val: [number, number][]) => void) => {
    registerListener<[number, number][]>(channel, 'broadcast::vector2[]', callback);
};

const receiveVector3 = (channel: string, callback: (val: [number, number, number]) => void) => {
    registerListener<[number, number, number]>(channel, 'broadcast::vector3', callback);
};

const receiveVector3Array = (channel: string, callback: (val: [number, number, number][]) => void) => {
    registerListener<[number, number, number][]>(channel, 'broadcast::vector3[]', callback);
};

const receiveQuaternion = (channel: string, callback: (val: [number, number, number, number]) => void) => {
    registerListener<[number, number, number, number]>(channel, 'broadcast::quaternion', callback);
};

const receiveQuaternionArray = (channel: string, callback: (val: [number, number, number, number][]) => void) => {
    registerListener<[number, number, number, number][]>(channel, 'broadcast::quaternion[]', callback);
};

// Typed ColorValue rather than string: a colour reaches this callback as an "#RRGGBBAA" string
// from a Unity peer but as an [r,g,b,a] array from a colibri-web one, and declaring only the
// first meant a web-to-web colour arrived as an array through a callback promised a string.
// Normalize with toHexColor/toRgbaColor instead of assuming either form.
const receiveColor = (channel: string, callback: (val: ColorValue) => void) => {
    registerListener<ColorValue>(channel, 'broadcast::color', callback);
};

const receiveColorArray = (channel: string, callback: (val: ColorValue[]) => void) => {
    registerListener<ColorValue[]>(channel, 'broadcast::color[]', callback);
};

const receiveJson = (channel: string, callback: (val: { [key: string]: unknown }) => void) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerListener<any>(channel, 'broadcast::json', callback);
};

/*
 *  Colour normalization.
 *
 *  A malformed colour warns and falls back to opaque black rather than throwing, matching what
 *  colibri-unity's JsonExtensions does: a wrong-shaped payload is a message worth reporting, not
 *  a reason to take down the handler that every other message on the channel goes through.
 */

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const hexPair = (n: number) =>
    Math.round(clamp01(n) * 255)
        .toString(16)
        .padStart(2, '0');

const warnNotAColor = (val: unknown) => {
    console.warn(`Colibri: '${JSON.stringify(val)}' is not a colour - expected "#RRGGBBAA" or [r,g,b,a]. Using black.`);
};

// Typed on `unknown` rather than ColorValue: this runs on whatever came off the wire, and
// narrowing against the declared type would let the compiler assume the very shape being checked.
const asComponents = (val: unknown): number[] | null => {
    if (!Array.isArray(val) || val.length < 3) return null;
    const numbers = val as unknown[];
    if (!numbers.every(c => typeof c === 'number' && !Number.isNaN(c))) return null;
    return numbers as number[];
};

/**
 * Renders a colour as the `"#RRGGBBAA"` string colibri-unity puts on the wire, whichever form it
 * arrived in. An unparseable colour warns and comes back opaque black.
 */
export const toHexColor = (val: ColorValue): string => {
    const rgba = toRgbaColor(val);
    return `#${hexPair(rgba[0])}${hexPair(rgba[1])}${hexPair(rgba[2])}${hexPair(rgba[3])}`;
};

/**
 * Reads a colour as `[r, g, b, a]` with each component 0-1, whichever form it arrived in. An
 * unparseable colour warns and comes back opaque black.
 */
export const toRgbaColor = (val: ColorValue): [number, number, number, number] => {
    const components = asComponents(val);
    if (components !== null) {
        return [
            clamp01(components[0]),
            clamp01(components[1]),
            clamp01(components[2]),
            components.length > 3 ? clamp01(components[3]) : 1
        ];
    }

    if (typeof val === 'string') {
        const hex = val.startsWith('#') ? val.slice(1) : val;
        // #RGB and #RGBA are Unity's shorthand forms; ColorUtility.TryParseHtmlString accepts all
        // four, so anything a Unity client can send has to parse here too.
        const digits = hex.length === 3 || hex.length === 4 ? hex.replace(/./g, c => c + c) : hex;

        if ((digits.length === 6 || digits.length === 8) && /^[0-9a-f]+$/i.test(digits)) {
            const byteAt = (i: number) => parseInt(digits.slice(i, i + 2), 16) / 255;
            return [byteAt(0), byteAt(2), byteAt(4), digits.length === 8 ? byteAt(6) : 1];
        }
    }

    warnNotAColor(val);
    return [0, 0, 0, 1];
};

const unregister = (channel: string, callback: genericCallback) => {
    const channelListeners = listeners[channel];
    if (channelListeners === undefined) return;

    let hasRemainingListeners = false;
    for (const command in channelListeners) {
        const commandListeners = channelListeners[command];
        const index = commandListeners?.indexOf(callback) ?? -1;
        if (index >= 0) {
            commandListeners?.splice(index, 1);
        }
        if ((commandListeners?.length ?? 0) > 0) {
            hasRemainingListeners = true;
        }
    }

    if (!hasRemainingListeners) {
        const handler = channelHandlers[channel];
        if (handler !== undefined) {
            UnregisterChannel(channel, handler);
        }
        Reflect.deleteProperty(listeners, channel);
        Reflect.deleteProperty(channelHandlers, channel);
    }
};

export const Sync = {
    sendBool,
    sendBoolArray,
    sendNumber,
    sendNumberArray,
    sendString,
    sendStringArray,
    sendVector2,
    sendVector2Array,
    sendVector3,
    sendVector3Array,
    sendQuaternion,
    sendQuaternionArray,
    sendColor,
    sendColorArray,
    sendJson,

    receiveBool,
    receiveBoolArray,
    receiveNumber,
    receiveNumberArray,
    receiveString,
    receiveStringArray,
    receiveVector2,
    receiveVector2Array,
    receiveVector3,
    receiveVector3Array,
    receiveQuaternion,
    receiveQuaternionArray,
    receiveColor,
    receiveColorArray,
    receiveJson,

    unregister,

    // For better compatibility with Unity Colibri. Note that sendInt still emits
    // `broadcast::float`, because JavaScript has one number type and nothing here can tell an
    // integer apart from a float that happens to be whole. Unity routes `broadcast::int` and
    // `broadcast::float` to separate listener lists, so a Unity client must receive these with
    // `Sync.Receive<float>`, never `Sync.Receive<int>`. The reverse direction does work:
    // receiveNumber listens for both commands.
    sendFloat: sendNumber,
    sendInt: sendNumber,
    sendFloatArray: sendNumberArray,
    sendIntArray: sendNumberArray
};
