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



const receiveBool = (channel: string, callback: (val: boolean) => void) => {
    RegisterChannel(channel, (msg) => callback(msg.payload as boolean));
};

const receiveBoolArray = (channel: string, callback: (val: boolean[]) => void) => {
    RegisterChannel(channel, (msg) => callback(msg.payload as boolean[]));
};

const receiveNumber = (channel: string, callback: (val: number) => void) => {
    RegisterChannel(channel, (msg) => callback(msg.payload as number));
};

const receiveNumberArray = (channel: string, callback: (val: number[]) => void) => {
    RegisterChannel(channel, (msg) => callback(msg.payload as number[]));
};

const receiveString = (channel: string, callback: (val: string) => void) => {
    RegisterChannel(channel, (msg) => callback(msg.payload as string));
};

const receiveStringArray = (channel: string, callback: (val: string[]) => void) => {
    RegisterChannel(channel, (msg) => callback(msg.payload as string[]));
};

const receiveVector3 = (channel: string, callback: (val: [number, number, number]) => void) => {
    RegisterChannel(channel, (msg) => callback(msg.payload as [number, number, number]));
};

const receiveVector3Array = (channel: string, callback: (val: [number, number, number][]) => void) => {
    RegisterChannel(channel, (msg) => callback(msg.payload as [number, number, number][]));
};

const receiveQuaternion = (channel: string, callback: (val: [number, number, number, number]) => void) => {
    RegisterChannel(channel, (msg) => callback(msg.payload as [number, number, number, number]));
};

const receiveQuaternionArray = (channel: string, callback: (val: [number, number, number, number][]) => void) => {
    RegisterChannel(channel, (msg) => callback(msg.payload as [number, number, number, number][]));
};

const receiveColor = (channel: string, callback: (val: [number, number, number, number]) => void) => {
    RegisterChannel(channel, (msg) => callback(msg.payload as [number, number, number, number]));
};

const receiveColorArray = (channel: string, callback: (val: [number, number, number, number][]) => void) => {
    RegisterChannel(channel, (msg) => callback(msg.payload as [number, number, number, number][]));
};

const receiveJson = (channel: string, callback: (val: { [key: string]: unknown }) => void) => {
    RegisterChannel(channel, (msg) => callback(msg.payload as { [key: string]: unknown }));
};


const unregister = (channel: string, callback: (val: unknown) => void) => {
    UnregisterChannel(channel, callback);
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

    // for clearer compatibility with Unity Colibri
    sendFloat: sendNumber,
    sendInt: sendNumber,
    sendFloatArray: sendNumberArray,
    sendIntArray: sendNumberArray,
};
