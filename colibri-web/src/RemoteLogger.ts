import { SendMessage } from './Networking';

const init = () => {
    // keep original console commands
    const consoleDebug = console.debug;
    const consoleLog = console.log;
    const consoleWarn = console.warn;
    const consoleError = console.error;

    const stringify = (obj: unknown): string => {
        if (obj instanceof Error) {
            return obj.message + '\n' + obj.stack;
        }

        const cache: unknown[] = [];
        const str = JSON.stringify(obj, (_, value: unknown) => {
            if (typeof value === 'object' && value !== null) {
                if (cache.indexOf(value) !== -1) {
                    // Circular reference found, discard key
                    return;
                }
                // Store value in our collection
                cache.push(value);
            }
            return value;
        }, 2);
        return str;
    };

    // intercept calls from console
    console.debug = function (...args) {
        consoleDebug.apply(this, Array.prototype.slice.call(args));
        SendMessage('log', 'debug', [...args].map(stringify).join().trim());
    };
    console.log = function (...args) {
        consoleLog.apply(this, Array.prototype.slice.call(args));
        SendMessage('log', 'info', [...args].map(stringify).join().trim());
    };
    console.warn = function (...args) {
        consoleWarn.apply(this, Array.prototype.slice.call(args));
        SendMessage('log', 'warning', [...args].map(stringify).join().trim());
    };
    console.error = function (...args) {
        consoleError.apply(this, Array.prototype.slice.call(args));
        SendMessage('log', 'error', [...args].map(stringify).join().trim());
    };
};


export const RemoteLogger = {
    init
};
