import { RegisterChannel, UnregisterChannel } from './Colibri';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GenericCallback = (val: any) => void;
const listeners: Partial<Record<string, Partial<Record<string, GenericCallback[]>>>> = {};
const channelHandlers: Partial<Record<string, Parameters<typeof RegisterChannel>[1]>> = {};

// T pins the payload type the call site's callback expects
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export const registerListener = <T>(channel: string, type: string, callback: (val: T) => void) => {
    let channelListeners = listeners[channel];
    if (channelListeners === undefined) {
        const newChannelListeners: Partial<Record<string, GenericCallback[]>> = {};
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

export const unregister = (channel: string, callback: GenericCallback) => {
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
