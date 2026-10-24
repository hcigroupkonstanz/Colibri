import { registerListener, unregister } from './broadcastListeners';
import { SendMessage } from './Colibri';
import type { ColorValue } from './ColorValue';

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

const receiveBool = (channel: string, callback: (val: boolean) => void) => {
    registerListener<boolean>(channel, 'broadcast::bool', callback);
};

const receiveBoolArray = (channel: string, callback: (val: boolean[]) => void) => {
    registerListener<boolean[]>(channel, 'broadcast::bool[]', callback);
};

// Unity tags integers as broadcast::int (`Sync.Send(channel, 5)`), so listen for both.
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

// The payload is a "#RRGGBBAA" string from Unity but an [r,g,b,a] array from colibri-web.
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

/** Sends typed values on a channel and registers callbacks for the values received on it. */
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

    // for better compatibility with Unity Colibri
    // sendInt and sendIntArray still send the float commands (JS cannot tell 5 from 5.0), so a
    // Unity client has to listen for float, not int.
    sendFloat: sendNumber,
    sendInt: sendNumber,
    sendFloatArray: sendNumberArray,
    sendIntArray: sendNumberArray
};
