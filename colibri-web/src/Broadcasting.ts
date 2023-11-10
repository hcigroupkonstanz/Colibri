import { RegisterChannel, SendMessage, UnregisterChannel } from './Networking';

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

const sendQuaternion = (channel: string, val: [number, number, number, number]) => {
    SendMessage(channel, 'broadcast::quaternion', val);
};

const sendQuaternionArray = (channel: string, val: [number, number, number, number][]) => {
    SendMessage(channel, 'broadcast::quaternion[]', val);
};

const sendColor = (channel: string, val: [number, number, number, number]) => {
    SendMessage(channel, 'broadcast::color', val);
};

const sendColorArray = (channel: string, val: [number, number, number, number][]) => {
    SendMessage(channel, 'broadcast::color[]', val);
};

const sendJson = (channel: string, val: { [key: string]: unknown }) => {
    SendMessage(channel, 'broadcast::json', val);
};


type genericCallback = (val: any) => void;
const listeners: { [channel: string]: { [ command: string ]: genericCallback[] } } = { };

const registerListener = <T>(channel: string, type: string, callback: (val: T) => void) => {
    if (listeners[channel] === undefined) {
        listeners[channel] = { };
        RegisterChannel(channel, (msg) => {
            if (msg.command in listeners[channel]) {
                listeners[channel][msg.command].forEach(cb => cb(msg.payload as T));
            }
        });
    }

    if (listeners[channel][type] === undefined) {
        listeners[channel][type] = [];
    }

    listeners[channel][type].push(callback);
};

const receiveBool = (channel: string, callback: (val: boolean) => void) => {
    registerListener<boolean>(channel, 'broadcast::bool', callback);
};

const receiveBoolArray = (channel: string, callback: (val: boolean[]) => void) => {
    registerListener<boolean[]>(channel, 'broadcast::bool[]', callback);
};

const receiveNumber = (channel: string, callback: (val: number) => void) => {
    registerListener<number>(channel, 'broadcast::float', callback);
};

const receiveNumberArray = (channel: string, callback: (val: number[]) => void) => {
    registerListener<number[]>(channel, 'broadcast::float[]', callback);
};

const receiveString = (channel: string, callback: (val: string) => void) => {
    registerListener<string>(channel, 'broadcast::string', callback);
};

const receiveStringArray = (channel: string, callback: (val: string[]) => void) => {
    registerListener<string[]>(channel, 'broadcast::string[]', callback);
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

const receiveColor = (channel: string, callback: (val: string) => void) => {
    registerListener<string>(channel, 'broadcast::color', callback);
};

const receiveColorArray = (channel: string, callback: (val: string[]) => void) => {
    registerListener<string[]>(channel, 'broadcast::color[]', callback);
};

const receiveJson = (channel: string, callback: (val: { [key: string]: unknown }) => void) => {
    registerListener<any>(channel, 'broadcast::json', callback);
};


const unregister = (channel: string, callback: genericCallback) => {
    for (const command in listeners[channel]) {
        const index = listeners[channel][command].indexOf(callback);
        if (index >= 0) {
            listeners[channel][command].splice(index, 1);
        }
    }

    // TODO: we should ideally unsubscribe from the channel if there are no more listeners
};

export const Sync = {
    sendBool, sendBoolArray,
    sendNumber, sendNumberArray,
    sendString, sendStringArray,
    sendVector3, sendVector3Array,
    sendQuaternion, sendQuaternionArray,
    sendColor, sendColorArray,
    sendJson,

    receiveBool, receiveBoolArray,
    receiveNumber, receiveNumberArray,
    receiveString, receiveStringArray,
    receiveVector3, receiveVector3Array,
    receiveQuaternion, receiveQuaternionArray,
    receiveColor, receiveColorArray,
    receiveJson,

    unregister,

    // for better compatibility with Unity Colibri
    sendFloat: sendNumber,
    sendInt: sendNumber,
    sendFloatArray: sendNumberArray,
    sendIntArray: sendNumberArray,
};
