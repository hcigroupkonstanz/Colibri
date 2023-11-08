import { RegisterChannel, SendMessage, UnregisterChannel } from './Networking';

export const sendBool = (channel: string, val: boolean) => {
    SendMessage(channel, 'broadcast::bool', val);
};

export const sendBoolArray = (channel: string, val: boolean[]) => {
    SendMessage(channel, 'broadcast::bool[]', val);
};

export const sendNumber = (channel: string, val: number) => {
    SendMessage(channel, 'broadcast::float', val);
};

export const sendNumberArray = (channel: string, val: number[]) => {
    SendMessage(channel, 'broadcast::float[]', val);
};

// for clearer compatibility with Unity Colibri
export const sendFloat = sendNumber;
export const sendInt = sendNumber;
export const sendFloatArray = sendNumberArray;
export const sendIntArray = sendNumberArray;

export const sendString = (channel: string, val: string) => {
    SendMessage(channel, 'broadcast::string', val);
};

export const sendStringArray = (channel: string, val: string[]) => {
    SendMessage(channel, 'broadcast::string[]', val);
};

export const sendVector3 = (channel: string, val: [number, number, number]) => {
    SendMessage(channel, 'broadcast::vector3', val);
};

export const sendVector3Array = (channel: string, val: [number, number, number][]) => {
    SendMessage(channel, 'broadcast::vector3[]', val);
};

export const sendQuaternion = (channel: string, val: [number, number, number, number]) => {
    SendMessage(channel, 'broadcast::quaternion', val);
};

export const sendQuaternionArray = (channel: string, val: [number, number, number, number][]) => {
    SendMessage(channel, 'broadcast::quaternion[]', val);
};

export const sendColor = (channel: string, val: [number, number, number, number]) => {
    SendMessage(channel, 'broadcast::color', val);
};

export const sendColorArray = (channel: string, val: [number, number, number, number][]) => {
    SendMessage(channel, 'broadcast::color[]', val);
};

export const sendJson = (channel: string, val: { [key: string]: unknown }) => {
    SendMessage(channel, 'broadcast::json', val);
};



export const receiveBool = (channel: string, callback: (val: boolean) => void) => {
    RegisterChannel(channel, (msg) => callback(msg.payload as boolean));
};

export const receiveBoolArray = (channel: string, callback: (val: boolean[]) => void) => {
    RegisterChannel(channel, (msg) => callback(msg.payload as boolean[]));
};

export const receiveNumber = (channel: string, callback: (val: number) => void) => {
    RegisterChannel(channel, (msg) => callback(msg.payload as number));
};

export const receiveNumberArray = (channel: string, callback: (val: number[]) => void) => {
    RegisterChannel(channel, (msg) => callback(msg.payload as number[]));
};

export const receiveString = (channel: string, callback: (val: string) => void) => {
    RegisterChannel(channel, (msg) => callback(msg.payload as string));
};

export const receiveStringArray = (channel: string, callback: (val: string[]) => void) => {
    RegisterChannel(channel, (msg) => callback(msg.payload as string[]));
};

export const receiveVector3 = (channel: string, callback: (val: [number, number, number]) => void) => {
    RegisterChannel(channel, (msg) => callback(msg.payload as [number, number, number]));
};

export const receiveVector3Array = (channel: string, callback: (val: [number, number, number][]) => void) => {
    RegisterChannel(channel, (msg) => callback(msg.payload as [number, number, number][]));
};

export const receiveQuaternion = (channel: string, callback: (val: [number, number, number, number]) => void) => {
    RegisterChannel(channel, (msg) => callback(msg.payload as [number, number, number, number]));
};

export const receiveQuaternionArray = (channel: string, callback: (val: [number, number, number, number][]) => void) => {
    RegisterChannel(channel, (msg) => callback(msg.payload as [number, number, number, number][]));
};

export const receiveColor = (channel: string, callback: (val: [number, number, number, number]) => void) => {
    RegisterChannel(channel, (msg) => callback(msg.payload as [number, number, number, number]));
};

export const receiveColorArray = (channel: string, callback: (val: [number, number, number, number][]) => void) => {
    RegisterChannel(channel, (msg) => callback(msg.payload as [number, number, number, number][]));
};

export const receiveJson = (channel: string, callback: (val: { [key: string]: unknown }) => void) => {
    RegisterChannel(channel, (msg) => callback(msg.payload as { [key: string]: unknown }));
};


export const unregister = (channel: string, callback: (val: unknown) => void) => {
    UnregisterChannel(channel, callback);
};


