import { RegisterChannel, SendMessage } from './Colibri';

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

const sendVector3 = (channel: string, val: [number, number, number]) => {
    SendMessage(channel, 'broadcast::vector3', val);
};

const sendVector3Array = (channel: string, val: [number, number, number][]) => {
    SendMessage(channel, 'broadcast::vector3[]', val);
};

const sendQuaternion = (
    channel: string,
    val: [number, number, number, number]
) => {
    SendMessage(channel, 'broadcast::quaternion', val);
};

const sendQuaternionArray = (
    channel: string,
    val: [number, number, number, number][]
) => {
    SendMessage(channel, 'broadcast::quaternion[]', val);
};

const sendColor = (channel: string, val: [number, number, number, number]) => {
    SendMessage(channel, 'broadcast::color', val);
};

const sendColorArray = (
    channel: string,
    val: [number, number, number, number][]
) => {
    SendMessage(channel, 'broadcast::color[]', val);
};

const sendJson = (channel: string, val: { [key: string]: unknown }) => {
    SendMessage(channel, 'broadcast::json', val);
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type genericCallback = (val: any) => void;
const listeners: Partial<
    Record<string, Partial<Record<string, genericCallback[]>>>
> = {};

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T lets each call site pin the concrete payload type its callback expects
const registerListener = <T>(
    channel: string,
    type: string,
    callback: (val: T) => void
) => {
    let channelListeners = listeners[channel];
    if (channelListeners === undefined) {
        const newChannelListeners: Partial<Record<string, genericCallback[]>>
            = {};
        channelListeners = newChannelListeners;
        listeners[channel] = newChannelListeners;
        RegisterChannel(channel, (msg) => {
            const commandListeners = newChannelListeners[msg.command];
            if (commandListeners !== undefined) {
                commandListeners.forEach((cb) => {
                    cb(msg.payload);
                });
            }
        });
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

const receiveBoolArray = (
    channel: string,
    callback: (val: boolean[]) => void
) => {
    registerListener<boolean[]>(channel, 'broadcast::bool[]', callback);
};

const receiveNumber = (channel: string, callback: (val: number) => void) => {
    registerListener<number>(channel, 'broadcast::float', callback);
};

const receiveNumberArray = (
    channel: string,
    callback: (val: number[]) => void
) => {
    registerListener<number[]>(channel, 'broadcast::float[]', callback);
};

const receiveString = (channel: string, callback: (val: string) => void) => {
    registerListener<string>(channel, 'broadcast::string', callback);
};

const receiveStringArray = (
    channel: string,
    callback: (val: string[]) => void
) => {
    registerListener<string[]>(channel, 'broadcast::string[]', callback);
};

const receiveVector3 = (
    channel: string,
    callback: (val: [number, number, number]) => void
) => {
    registerListener<[number, number, number]>(
        channel,
        'broadcast::vector3',
        callback
    );
};

const receiveVector3Array = (
    channel: string,
    callback: (val: [number, number, number][]) => void
) => {
    registerListener<[number, number, number][]>(
        channel,
        'broadcast::vector3[]',
        callback
    );
};

const receiveQuaternion = (
    channel: string,
    callback: (val: [number, number, number, number]) => void
) => {
    registerListener<[number, number, number, number]>(
        channel,
        'broadcast::quaternion',
        callback
    );
};

const receiveQuaternionArray = (
    channel: string,
    callback: (val: [number, number, number, number][]) => void
) => {
    registerListener<[number, number, number, number][]>(
        channel,
        'broadcast::quaternion[]',
        callback
    );
};

const receiveColor = (channel: string, callback: (val: string) => void) => {
    registerListener<string>(channel, 'broadcast::color', callback);
};

const receiveColorArray = (
    channel: string,
    callback: (val: string[]) => void
) => {
    registerListener<string[]>(channel, 'broadcast::color[]', callback);
};

const receiveJson = (
    channel: string,
    callback: (val: { [key: string]: unknown }) => void
) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerListener<any>(channel, 'broadcast::json', callback);
};

const unregister = (channel: string, callback: genericCallback) => {
    const channelListeners = listeners[channel];
    if (channelListeners === undefined) return;

    for (const command in channelListeners) {
        const commandListeners = channelListeners[command];
        const index = commandListeners?.indexOf(callback) ?? -1;
        if (index >= 0) {
            commandListeners?.splice(index, 1);
        }
    }

    // TODO: we should ideally unsubscribe from the channel if there are no more listeners
};

export const Sync = {
    sendBool,
    sendBoolArray,
    sendNumber,
    sendNumberArray,
    sendString,
    sendStringArray,
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
    receiveVector3,
    receiveVector3Array,
    receiveQuaternion,
    receiveQuaternionArray,
    receiveColor,
    receiveColorArray,
    receiveJson,

    unregister,

    // for better compatibility with Unity Colibri
    sendFloat: sendNumber,
    sendInt: sendNumber,
    sendFloatArray: sendNumberArray,
    sendIntArray: sendNumberArray
};
